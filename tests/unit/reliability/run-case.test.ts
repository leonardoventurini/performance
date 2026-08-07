import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';

import { loadDeclarativeAuditCatalog } from '../../../reliability/declarative/catalog.js';
import { compileDeclarativeCase } from '../../../reliability/declarative/compiler.js';
import { runDeclarativeCase } from '../../../reliability/runtime/run-case.js';
import type { RuntimeEnvironment } from '../../../reliability/runtime/run-case.js';

test('event insert compiles with the exact runtime adapter inputs', () => {
  const catalog = loadDeclarativeAuditCatalog();
  const plan = compileDeclarativeCase({
    catalog,
    caseId: 'event.insert',
    profileId: 'smoke',
    coordinate: {
      caseId: 'event.insert', transport: 'sockjs', topology: 'replica_set', seed: 42,
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    },
  });
  const steps = Reflect.get(plan, 'steps');
  const digest = Reflect.get(plan, 'digest');
  assert.ok(Array.isArray(steps));
  const first = steps[0];
  const last = steps.at(-1);
  assert.ok(first && typeof first === 'object');
  assert.ok(last && typeof last === 'object');
  assert.equal(Reflect.get(first, 'kind'), 'subscribe');
  assert.equal(Reflect.get(last, 'kind'), 'seal_evidence');
  assert.equal(typeof digest, 'string');
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('closes Mongo when post-connect database setup fails', async () => {
  const catalog = loadDeclarativeAuditCatalog();
  const definition = catalog.casesById.get('event.insert');
  assert.ok(definition);
  const plan = compileDeclarativeCase({
    catalog,
    caseId: definition.id,
    profileId: 'smoke',
    coordinate: {
      caseId: definition.id, transport: 'sockjs', topology: 'replica_set', seed: 42,
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    },
  });
  let closed = false;
  class SetupFailureMongoClient extends MongoClient {
    override async connect(): Promise<this> { return this; }
    override db(): never { throw new Error('database setup failed'); }
    override async close(): Promise<void> { closed = true; }
  }
  const environment: RuntimeEnvironment = {
    auditId: 'audit',
    ddpUrl: 'ws://127.0.0.1:3000/websocket',
    proxy: {
      backendIdForConnection: () => 'backend',
      setRoutePolicy: () => undefined,
    },
    cluster: {
      token: 'token',
      backends: [{ id: 'backend' }],
      stopInstance: async () => undefined,
      restartInstance: async () => undefined,
    },
    replicaSet: { uri: 'mongodb://127.0.0.1:27017', stepDownPrimary: async () => undefined },
  };

  await assert.rejects(runDeclarativeCase({
    environment,
    definition,
    plan,
    release: {},
    attemptId: 'attempt',
    mongoClientClass: SetupFailureMongoClient,
  }), /database setup failed/);
  assert.equal(closed, true);
});
