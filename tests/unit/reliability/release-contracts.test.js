import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contractDigest,
  validateAuditCaseResult,
  validateCaseCoordinate,
  validateReleaseIdentity,
} from '../../../reliability/contracts/index.js';
import {
  RELEASE_CAPABILITY_CONTRACT_DIGEST,
  RELEASE_CAPABILITY_REGISTRY,
} from '../../../reliability/release-audit/capability-registry.js';
import { resolveReleaseAuditMatrix } from '../../../reliability/release-audit/matrix.js';

const SHA = 'a'.repeat(64);

function validCase() {
  return {
    schemaVersion: 2,
    coordinate: {
      caseId: 'event.insert',
      transport: 'sockjs',
      observerOrder: ['changeStreams', 'oplog', 'polling'],
      topology: 'replica_set',
      seed: 7,
    },
    attemptId: 'attempt-1',
    status: 'passed',
    release: {
      requested: '3.5.1-beta.0',
      actual: '3.5.1-beta.0',
      sourceRevision: 'release:3.5.1-beta.0',
      fixtureRelease: 'METEOR@3.5.1-beta.0',
      packageVersionsDigest: SHA,
      settingsDigest: SHA,
      harnessRevision: 'c'.repeat(40),
      harnessDirty: false,
      executionEnvironment: 'node-24-test',
    },
    mongo: {
      serverVersion: '8.0.0',
      featureCompatibilityVersion: '8.0',
      topology: 'replica_set',
      topologyName: 'audit-rs',
      members: [{ id: 'mongo-1', role: 'primary' }],
    },
    observerEvidence: [{
      cursorId: 'cursor-1',
      requestedOrder: ['changeStreams', 'oplog', 'polling'],
      actualDriver: 'changeStreams',
    }],
    oracles: [{
      oracleId: 'ddp-content',
      producer: 'ddp_client',
      digest: SHA,
      assertions: 1,
      passed: true,
      failures: [],
    }],
    diagnostics: {
      resources: { cpu: 1 },
    },
    reasons: [],
  };
}

test('contract digest is deterministic across object key order', () => {
  assert.equal(
    contractDigest({ z: 1, nested: { b: 2, a: 3 } }),
    contractDigest({ nested: { a: 3, b: 2 }, z: 1 }),
  );
  assert.match(RELEASE_CAPABILITY_CONTRACT_DIGEST, /^[a-f0-9]{64}$/);
});

test('case contract rejects unknown fields, statuses, and non-finite diagnostics', () => {
  assert.throws(
    () => validateAuditCaseResult({ ...validCase(), surprise: true }),
    /surprise is unknown/,
  );
  assert.throws(
    () => validateAuditCaseResult({ ...validCase(), status: 'successful' }),
    /must be one of/,
  );
  const nonFinite = validCase();
  nonFinite.diagnostics.resources.cpu = Number.POSITIVE_INFINITY;
  assert.throws(() => validateAuditCaseResult(nonFinite), /must be finite/);
});

test('coordinate contract rejects duplicate observer drivers and unbounded seeds', () => {
  const coordinate = validCase().coordinate;
  assert.throws(
    () => validateCaseCoordinate({
      ...coordinate,
      observerOrder: ['changeStreams', 'changeStreams'],
    }),
    /unique drivers/,
  );
  assert.throws(
    () => validateCaseCoordinate({ ...coordinate, seed: 0x1_0000_0000 }),
    /unsigned 32-bit/,
  );
});

test('release and MongoDB sentinels cannot enter conformance evidence', () => {
  const identity = validCase().release;
  assert.throws(
    () => validateReleaseIdentity({ ...identity, sourceRevision: 'unknown' }),
    /must not be unknown/u,
  );
  assert.throws(
    () => validateReleaseIdentity({ ...identity, fixtureRelease: 'METEOR@3.5.0' }),
    /must exactly match/u,
  );
  const unavailableMongo = validCase();
  unavailableMongo.mongo.serverVersion = 'unavailable';
  assert.throws(
    () => validateAuditCaseResult(unavailableMongo),
    /exact numeric version/u,
  );
});

test('registry includes every exact capability explicitly named by the spec', () => {
  const ids = new Set(RELEASE_CAPABILITY_REGISTRY.map(({ id }) => id));
  for (const id of [
    'observer.distinct_queries_isolated',
    'fallback.change_stream_unavailable',
    'session.resume.queue_boundary',
    'session.resume.non_sticky_instance',
    'recovery.mongodb_primary_step_down',
    'mongodb.collection_rename_drop_invalidate',
    'mongodb.database_drop',
    'mongodb.expanded_events',
    'mongodb.change_stream_pre_images',
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  for (const id of [
    'mongodb.collection_rename_drop_invalidate',
    'mongodb.database_drop',
    'mongodb.expanded_events',
    'mongodb.change_stream_pre_images',
  ]) {
    assert.equal(
      RELEASE_CAPABILITY_REGISTRY.find((capability) => capability.id === id).expectation,
      'out_of_scope',
    );
  }
  assert.equal(ids.size, RELEASE_CAPABILITY_REGISTRY.length);
});

test('matrix resolver covers every applicable required capability coordinate', () => {
  const matrix = resolveReleaseAuditMatrix({
    topologyScope: ['replica_set', 'standalone'],
    transportScope: ['sockjs', 'uws'],
    seed: 7,
  });
  assert.ok(matrix.coordinates.length > 0);
  for (const capability of RELEASE_CAPABILITY_REGISTRY) {
    const required = matrix.requiredByCapability[capability.id];
    if (['supported', 'fallback_required'].includes(capability.expectation)) {
      assert.ok(required.length > 0, `${capability.id} is uncovered`);
    } else {
      assert.deepEqual(required, []);
    }
  }
});

test('matrix resolver rejects duplicate capability identities', () => {
  assert.throws(() => resolveReleaseAuditMatrix({
    topologyScope: ['replica_set'],
    transportScope: ['sockjs'],
    seed: 7,
    registry: [RELEASE_CAPABILITY_REGISTRY[0], RELEASE_CAPABILITY_REGISTRY[0]],
  }), /duplicate capability identifier/);
});
