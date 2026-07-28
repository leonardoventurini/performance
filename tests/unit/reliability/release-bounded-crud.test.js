import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildBoundedCrudCaseResult,
} from '../../../reliability/cases/bounded-crud.js';

const DIGEST = 'a'.repeat(64);
const RELEASE = {
  requested: '3.5.1-beta.0',
  actual: '3.5.1-beta.0',
  sourceRevision: 'release:3.5.1-beta.0',
  fixtureRelease: 'METEOR@3.5.1-beta.0',
  packageVersionsDigest: DIGEST,
  settingsDigest: DIGEST,
  harnessRevision: 'b'.repeat(40),
  harnessDirty: false,
  executionEnvironment: 'darwin-arm64/node-24/host-abcdef123456',
};
const COORDINATE = {
  caseId: 'event.insert',
  transport: 'sockjs',
  observerOrder: ['changeStreams', 'oplog', 'polling'],
  topology: 'replica_set',
  seed: 42,
};

function benchmarkResult() {
  return {
    runtime: {
      transport: 'sockjs',
      observer_driver_actual: 'changeStreams',
    },
    metrics: {
      driver_fallbacks: {
        total_cursors: 3,
        no_fallback: 3,
        fallbacks: {},
      },
      change_stream_audit: {
        status: 'passed',
        subscribers: 2,
        observed_events: 8,
        generated_bytes: 1024,
        propagation_p50: 1,
        propagation_p95: 2,
        propagation_p99: 3,
        capabilities: [{ id: 'insert', audit_status: 'passed' }],
        release_evidence: {
          mongo_identity: {
            serverVersion: '8.0.1',
            featureCompatibilityVersion: '8.0',
            topology: 'replica_set',
            topologyName: 'member-a',
            members: [{ id: 'member-a', role: 'primary' }],
          },
          expected_final_state_digest: DIGEST,
          mongo_final_state_digest: DIGEST,
          subscriber_final_state_digests: [DIGEST, DIGEST],
        },
      },
    },
  };
}

describe('bounded CRUD release case adapter', () => {
  test('seals independent MongoDB, DDP, and Meteor evidence', () => {
    const result = buildBoundedCrudCaseResult({
      coordinate: COORDINATE,
      release: RELEASE,
      benchmarkResult: benchmarkResult(),
      attemptId: 'attempt-1',
    });
    assert.equal(result.status, 'passed');
    assert.deepEqual(
      result.oracles.map(({ producer }) => producer),
      ['mongodb', 'ddp_client', 'meteor_probe'],
    );
  });

  test('detects one stale subscriber snapshot', () => {
    const benchmark = benchmarkResult();
    benchmark.metrics.change_stream_audit.release_evidence
      .subscriber_final_state_digests[1] = 'c'.repeat(64);
    const result = buildBoundedCrudCaseResult({
      coordinate: COORDINATE,
      release: RELEASE,
      benchmarkResult: benchmark,
      attemptId: 'attempt-1',
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.reasons, ['ddp_snapshot_mismatch']);
  });
});
