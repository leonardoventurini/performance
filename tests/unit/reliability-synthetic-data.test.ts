import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Binary, ObjectId } from 'mongodb';
import {
  MAX_PAYLOAD_BYTES,
  buildSyntheticDocument,
  documentDigest,
  isLoopbackMongoUri,
  validateWorkloadOptions,
} from '../../reliability/synthetic-data.js';
import { summarizeReliability } from '../../reliability/metrics.js';

describe('reliability synthetic data', () => {
  test('is deterministic and preserves the requested UTF-8 payload size', () => {
    const options = { runId: 'run', sequence: 4, revision: 2, payloadBytes: 4096, seed: 17 };
    const first = buildSyntheticDocument(options);
    const second = buildSyntheticDocument(options);
    assert.deepEqual(first, second);
    assert.equal(Buffer.byteLength(first.payload), 4096);
    assert.match(first.adversarial.unicode, /🚀/);
    assert.equal(first.adversarial.scalarBoundaries.maximumSafeInteger, Number.MAX_SAFE_INTEGER);
    assert.equal(first.structureDigest.length, 64);
  });

  test('changes digest when the revision changes', () => {
    const base = { runId: 'run', sequence: 1, payloadBytes: 1024, seed: 9 };
    assert.notEqual(
      buildSyntheticDocument({ ...base, revision: 0 }).payloadDigest,
      buildSyntheticDocument({ ...base, revision: 1 }).payloadDigest,
    );
  });

  test('canonicalizes BSON and DDP extended values to the same digest', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    assert.equal(
      documentDigest({ value: new Binary(bytes) }),
      documentDigest({ value: bytes }),
    );
    const objectId = new ObjectId('000000000000000000000001');
    assert.equal(
      documentDigest({ value: objectId }),
      documentDigest({ value: new ObjectId(objectId.toHexString()) }),
    );
    assert.notEqual(
      documentDigest({ value: new Date(0) }),
      documentDigest({ value: new Date(1) }),
    );
  });

  test('canonical type nodes cannot collide with user-authored lookalike objects', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    assert.notEqual(
      documentDigest({ value: new Date(0) }),
      documentDigest({ value: { $date: new Date(0).toISOString() } }),
    );
    assert.notEqual(
      documentDigest({ value: bytes }),
      documentDigest({ value: { $binary: Buffer.from(bytes).toString('base64') } }),
    );
    const objectId = new ObjectId('000000000000000000000001');
    assert.notEqual(
      documentDigest({ value: objectId }),
      documentDigest({ value: { buffer: Uint8Array.from(objectId.id) } }),
    );
    assert.notEqual(
      documentDigest({ value: new Binary(bytes, 0) }),
      documentDigest({ value: new Binary(bytes, 1) }),
    );
  });

  test('canonical document digest detects extra fields without depending on object key order', () => {
    assert.equal(documentDigest({ a: 1, b: { c: 2 } }), documentDigest({ b: { c: 2 }, a: 1 }));
    assert.notEqual(documentDigest({ a: 1 }), documentDigest({ a: 1, stale: true }));
  });

  test('rejects unsafe or invalid workload bounds', () => {
    const valid = {
      subscribers: 2, documents: 10, mutations: 2, payloadBytes: 1024,
      burstSize: 5, timeoutMs: 1000, seed: 0,
    };
    assert.equal(validateWorkloadOptions(valid), valid);
    assert.throws(() => validateWorkloadOptions({ ...valid, payloadBytes: MAX_PAYLOAD_BYTES + 1 }), /must not exceed/);
    assert.throws(() => validateWorkloadOptions({ ...valid, burstSize: 11 }), /must not exceed documents/);
    assert.throws(() => validateWorkloadOptions({ ...valid, subscribers: 0 }), /positive integer/);
    assert.throws(() => validateWorkloadOptions({ ...valid, subscribers: 101 }), /must not exceed/);
    assert.throws(() => validateWorkloadOptions({ ...valid, documents: 1_001, burstSize: 5 }), /must not exceed/);
  });

  test('recognizes only loopback MongoDB targets by default', () => {
    assert.equal(isLoopbackMongoUri('mongodb://127.0.0.1:3001/meteor'), true);
    assert.equal(isLoopbackMongoUri('mongodb://user:pass@localhost:27017/meteor'), true);
    assert.equal(isLoopbackMongoUri('mongodb://[::1]:27017/meteor'), true);
    assert.equal(isLoopbackMongoUri('mongodb://127.example.com:27017/meteor'), false);
    assert.equal(isLoopbackMongoUri('mongodb://127.0.0.1.example.com:27017/meteor'), false);
    assert.equal(isLoopbackMongoUri('mongodb://db.internal:27017/meteor'), false);
    assert.equal(isLoopbackMongoUri('not-a-uri'), false);
  });
});

describe('reliability metric summary', () => {
  test('summarizes latency and passes when correctness counters are clean', () => {
    const metric = summarizeReliability({
      profile: 'smoke', seed: 1, requestedDriver: 'changeStreams', actualDriver: 'changeStreams', completed: true,
      subscribers: 2, documents: 2, mutations: 1, payloadBytes: 1024,
      writes: { inserts: 2, updates: 2, removes: 1 },
      observedEvents: 10, duplicateEvents: 0, outOfOrderEvents: 0,
      foreignEvents: 0, convergedSubscribers: 2, timedOutSubscribers: 0,
      finalStateMismatches: 0, digestMismatches: 0,
      latencies: [1, 2, 3, 20],
    });
    assert.equal(metric.status, 'passed');
    assert.equal(metric.propagation_p95, 20);
    assert.equal(metric.generated_bytes, 4096);
  });

  test('fails on any correctness violation', () => {
    const metric = summarizeReliability({
      profile: 'extreme', seed: 1, requestedDriver: 'oplog', actualDriver: 'changeStreams', completed: true,
      subscribers: 1, documents: 1, mutations: 1, payloadBytes: 1,
      writes: {}, observedEvents: 1, duplicateEvents: 1, outOfOrderEvents: 1,
      foreignEvents: 1, convergedSubscribers: 0, timedOutSubscribers: 1,
      finalStateMismatches: 1, digestMismatches: 1,
      latencies: [], failureReasons: ['actual driver mismatch'],
    });
    assert.equal(metric.status, 'failed');
    assert.ok(metric.failure_reasons.length >= 6);
  });
});
