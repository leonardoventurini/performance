#!/usr/bin/env node

import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { BSON, MongoClient } from 'mongodb';
import SimpleDDP from 'simpleddp';
import ws from 'ws';
import {
  buildSyntheticDocument,
  documentDigest,
  isLoopbackMongoUri,
  structureDigest,
  validateWorkloadOptions,
} from '../reliability/synthetic-data.js';
import { summarizeReliability } from '../reliability/metrics.js';
import {
  CAPABILITY_CONTRACT,
  buildMutation,
  recordCapabilityOutcome,
  summarizeCapabilities,
} from '../reliability/operation-matrix.js';

const COLLECTION_NAME = 'reliabilityDocuments';
const MAX_DOCUMENT_BSON_BYTES = 12 * 1024 * 1024;
const PROFILES = {
  smoke: {
    subscribers: 3,
    documents: 12,
    mutations: 5,
    payloadBytes: 64 * 1024,
    burstSize: 4,
    timeoutMs: 30_000,
  },
  extreme: {
    subscribers: 12,
    documents: 120,
    mutations: 10,
    payloadBytes: 512 * 1024,
    burstSize: 20,
    timeoutMs: 120_000,
  },
};

function websocketUrl(httpUrl) {
  return httpUrl.replace(/^http/, 'ws') + '/websocket';
}

function asPositiveInteger(value, fallback) {
  return value === undefined ? fallback : Number.parseInt(value, 10);
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      seed: { type: 'string' },
      subscribers: { type: 'string' },
      documents: { type: 'string' },
      mutations: { type: 'string' },
      'payload-kb': { type: 'string' },
      'burst-size': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'observer-driver': { type: 'string' },
      'allow-remote-mongo': { type: 'boolean' },
    },
    strict: true,
  });
  const profile = values.profile || 'smoke';
  const preset = PROFILES[profile];
  if (!preset) throw new Error(`Unknown reliability profile: ${profile}`);
  const options = validateWorkloadOptions({
    subscribers: asPositiveInteger(values.subscribers, preset.subscribers),
    documents: asPositiveInteger(values.documents, preset.documents),
    mutations: asPositiveInteger(values.mutations, preset.mutations),
    payloadBytes: asPositiveInteger(values['payload-kb'], preset.payloadBytes / 1024) * 1024,
    burstSize: asPositiveInteger(values['burst-size'], preset.burstSize),
    timeoutMs: asPositiveInteger(values['timeout-ms'], preset.timeoutMs),
    seed: asPositiveInteger(values.seed, 42),
  });
  return {
    ...options,
    profile,
    requestedDriver: values['observer-driver'] || 'changeStreams',
    allowRemote: values['allow-remote-mongo'] || false,
  };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function expectedStateMatches(ddp, expected) {
  const documents = ddp.collection(COLLECTION_NAME).fetch();
  if (documents.length !== expected.size) return false;
  return documents.every((document) => {
    const wanted = expected.get(document.id);
    if (!wanted
      || document.runId !== wanted.runId
      || document.revision !== wanted.revision
      || document.payloadDigest !== wanted.payloadDigest
      || crypto.createHash('sha256').update(document.payload).digest('hex') !== wanted.payloadDigest
      || document.structureDigest !== wanted.structureDigest
      || structureDigest(document.adversarial) !== wanted.structureDigest) return false;
    const normalized = { ...document, _id: document.id };
    delete normalized.id;
    return documentDigest(normalized) === documentDigest(wanted);
  });
}

async function runBurst(items, burstSize, operation) {
  for (let offset = 0; offset < items.length; offset += burstSize) {
    await operation(items.slice(offset, offset + burstSize));
  }
}

async function run() {
  const options = parseOptions();
  const target = process.env.REMOTE_URL || 'http://localhost:3000';
  const mongoUri = process.env.BENCH_MONGO_URL || 'mongodb://127.0.0.1:3001/meteor';
  if (!options.allowRemote && !isLoopbackMongoUri(mongoUri)) {
    throw new Error('Refusing non-loopback MongoDB target without --allow-remote-mongo');
  }

  const runId = crypto.randomUUID();
  const auditStartedAt = new Date().toISOString();
  console.error(`Change-stream audit run ID: ${runId}`);
  const client = new MongoClient(mongoUri);
  const subscribers = [];
  const handlers = [];
  const seen = new Set();
  const lastRevision = new Map();
  const sentAt = new Map();
  const latencies = [];
  let duplicateEvents = 0;
  let outOfOrderEvents = 0;
  let foreignEvents = 0;
  let digestMismatches = 0;
  const capabilityOutcomes = {};

  await client.connect();
  const collection = client.db().collection(COLLECTION_NAME);
  await collection.deleteMany({ runId });
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    for (const handler of handlers) handler.stop();
    for (const subscriber of subscribers) subscriber.disconnect();
    await collection.deleteMany({ runId });
    await client.close();
  };
  const handleSignal = () => {
    cleanup().finally(() => process.exit(1));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    console.error(`Reliability ${options.profile}: ${options.subscribers} subscribers, ${options.documents} documents, ${options.mutations} mutations`);
    for (let index = 0; index < options.subscribers; index += 1) {
      const ddp = new SimpleDDP({
        endpoint: websocketUrl(target),
        SocketConstructor: ws,
        reconnectInterval: 1_000,
      });
      await ddp.connect();
      const subscription = ddp.subscribe('reliability.documents', runId);
      await subscription.ready();
      const handler = ddp.collection(COLLECTION_NAME).onChange(({ added, changed, removed }) => {
        const document = added || changed?.next || removed;
        if (!document) return;
        if (document.runId !== runId) {
          foreignEvents += 1;
          return;
        }
        if (typeof document.payload !== 'string'
          || crypto.createHash('sha256').update(document.payload).digest('hex') !== document.payloadDigest
          || structureDigest(document.adversarial) !== document.structureDigest) {
          digestMismatches += 1;
        }
        const action = added ? 'insert' : changed ? 'update' : 'remove';
        const eventKey = `${index}:${action}:${document.id}:${document.revision}`;
        if (seen.has(eventKey)) duplicateEvents += 1;
        else seen.add(eventKey);

        const revisionKey = `${index}:${document.id}`;
        const previousRevision = lastRevision.get(revisionKey);
        if (previousRevision !== undefined && document.revision < previousRevision) {
          outOfOrderEvents += 1;
        }
        lastRevision.set(revisionKey, document.revision);

        const start = sentAt.get(`${action}:${document.id}:${document.revision}`);
        if (start !== undefined) latencies.push(Number(process.hrtime.bigint() - start) / 1_000_000);
      });
      subscribers.push(ddp);
      handlers.push(handler);
    }

    const expected = new Map();
    const documents = Array.from({ length: options.documents }, (_, sequence) => (
      {
        ...buildSyntheticDocument({ runId, sequence, revision: 0, payloadBytes: options.payloadBytes, seed: options.seed }),
        auditStartedAt,
      }
    ));
    const bsonSizes = documents.map((document) => BSON.calculateObjectSize(document));
    if (bsonSizes.some((size) => size > MAX_DOCUMENT_BSON_BYTES)) {
      throw new Error(`Generated document exceeds conservative BSON limit of ${MAX_DOCUMENT_BSON_BYTES} bytes`);
    }
    const [conformanceDocument, ...burstDocuments] = documents;
    const insertStart = process.hrtime.bigint();
    sentAt.set(`insert:${conformanceDocument._id}:0`, insertStart);
    expected.set(conformanceDocument._id, conformanceDocument);
    await collection.insertOne(conformanceDocument);
    recordCapabilityOutcome(capabilityOutcomes, 'insert', await waitUntil(
      () => subscribers.every((subscriber, index) => (
        seen.has(`${index}:insert:${conformanceDocument._id}:0`)
        && expectedStateMatches(subscriber, expected)
      )),
      options.timeoutMs,
    ));

    await runBurst(burstDocuments, options.burstSize, async (burst) => {
      const now = process.hrtime.bigint();
      for (const document of burst) {
        sentAt.set(`insert:${document._id}:0`, now);
        expected.set(document._id, document);
      }
      await collection.insertMany(burst, { ordered: true });
    });

    for (let revision = 1; revision <= options.mutations; revision += 1) {
      const mutations = [...expected.values()].map((previous) => (
        buildMutation({ previous, revision, payloadBytes: options.payloadBytes, seed: options.seed })
      ));
      const [conformanceMutation, ...burstMutations] = mutations;
      const conformanceStart = process.hrtime.bigint();
      sentAt.set(`update:${conformanceMutation.next._id}:${revision}`, conformanceStart);
      expected.set(conformanceMutation.next._id, conformanceMutation.next);
      await collection.bulkWrite([conformanceMutation.write], { ordered: true });
      recordCapabilityOutcome(capabilityOutcomes, conformanceMutation.operationId, await waitUntil(
        () => subscribers.every((subscriber, index) => (
          seen.has(`${index}:update:${conformanceMutation.next._id}:${revision}`)
          && expectedStateMatches(subscriber, expected)
        )),
        options.timeoutMs,
      ));

      await runBurst(burstMutations, options.burstSize, async (burst) => {
        const now = process.hrtime.bigint();
        for (const mutation of burst) {
          sentAt.set(`update:${mutation.next._id}:${revision}`, now);
          expected.set(mutation.next._id, mutation.next);
        }
        await collection.bulkWrite(burst.map((mutation) => mutation.write), { ordered: true });
      });
    }

    const removed = documents.filter((document) => document.sequence % 3 === 0);
    const [conformanceRemoval, ...burstRemovals] = removed;
    const removalStart = process.hrtime.bigint();
    sentAt.set(`remove:${conformanceRemoval._id}:${options.mutations}`, removalStart);
    expected.delete(conformanceRemoval._id);
    await collection.deleteOne({ runId, _id: conformanceRemoval._id });
    const deleteConformancePassed = await waitUntil(
      () => subscribers.every((subscriber, index) => (
        seen.has(`${index}:remove:${conformanceRemoval._id}:${options.mutations}`)
        && expectedStateMatches(subscriber, expected)
      )),
      options.timeoutMs,
    );

    await runBurst(burstRemovals, options.burstSize, async (burst) => {
      const now = process.hrtime.bigint();
      for (const document of burst) {
        sentAt.set(`remove:${document._id}:${options.mutations}`, now);
        expected.delete(document._id);
      }
      await collection.deleteMany({ runId, _id: { $in: burst.map((document) => document._id) } });
    });

    const converged = await waitUntil(
      () => subscribers.every((subscriber) => expectedStateMatches(subscriber, expected)),
      options.timeoutMs,
    );
    const convergedSubscribers = subscribers.filter((subscriber) => expectedStateMatches(subscriber, expected)).length;
    const timedOutSubscribers = options.subscribers - convergedSubscribers;
    const failureReasons = [];
    if (!converged) failureReasons.push('subscriber convergence deadline exceeded');
    recordCapabilityOutcome(capabilityOutcomes, 'delete', deleteConformancePassed && converged);
    const failedCapabilities = Object.entries(capabilityOutcomes)
      .filter(([, status]) => status !== 'passed')
      .map(([id]) => id);
    if (failedCapabilities.length > 0) {
      failureReasons.push(`capability audit failed: ${failedCapabilities.join(', ')}`);
    }

    const metric = summarizeReliability({
      profile: options.profile,
      seed: options.seed,
      requestedDriver: options.requestedDriver,
      actualDriver: process.env.RELIABILITY_ACTUAL_DRIVER || options.requestedDriver,
      completed: true,
      subscribers: options.subscribers,
      documents: options.documents,
      mutations: options.mutations,
      payloadBytes: options.payloadBytes,
      writes: {
        inserts: options.documents,
        updates: options.documents * options.mutations,
        removes: removed.length,
      },
      observedEvents: seen.size,
      duplicateEvents,
      outOfOrderEvents,
      foreignEvents,
      convergedSubscribers,
      timedOutSubscribers,
      finalStateMismatches: timedOutSubscribers,
      digestMismatches,
      latencies,
      failureReasons,
    });
    metric.generated_bson_bytes = bsonSizes.reduce((total, size) => total + size, 0) * (options.mutations + 1);
    metric.max_document_bson_bytes = Math.max(...bsonSizes);
    metric.capabilities = summarizeCapabilities(capabilityOutcomes);
    metric.capability_contract = CAPABILITY_CONTRACT;
    console.log(JSON.stringify(metric));
    if (metric.status !== 'passed') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanup();
  }
}

run().catch((error) => {
  console.error(`Reliability workload failed: ${error.stack || error.message}`);
  process.exit(1);
});
