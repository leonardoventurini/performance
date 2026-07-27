import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIncompleteAuditMetric,
  finalizeAuditEvidence,
  resolveAuditMongoTarget,
} from '../../reliability/audit-evidence.js';

function passingMetrics() {
  return {
    driver_fallbacks: { no_fallback: 3, total_cursors: 3 },
    ddp_messages: { by_type: { out: { added: 1, changed: 1, removed: 1 } } },
    ddp_frame_size: { by_type_bytes: { out: { added: 10, changed: 10, removed: 10 } } },
  };
}

describe('audit target safety', () => {
  test('accepts a named loopback database', () => {
    assert.equal(resolveAuditMongoTarget({
      fallbackMongoUri: 'mongodb://127.0.0.1:3001/meteor',
      allowRemote: false,
    }), 'mongodb://127.0.0.1:3001/meteor');
  });

  test('rejects mismatched workload and Meteor databases before execution', () => {
    assert.throws(() => resolveAuditMongoTarget({
      benchMongoUri: 'mongodb://127.0.0.1:3001/audit',
      meteorMongoUri: 'mongodb://127.0.0.1:3001/meteor',
      fallbackMongoUri: 'mongodb://127.0.0.1:3001/meteor',
      allowRemote: false,
    }), /same database/);
  });

  test('rejects unnamed and remote databases by default', () => {
    assert.throws(() => resolveAuditMongoTarget({
      fallbackMongoUri: 'mongodb://127.0.0.1:3001',
      allowRemote: false,
    }), /explicit MongoDB database name/);
    assert.throws(() => resolveAuditMongoTarget({
      fallbackMongoUri: 'mongodb://db.internal:27017/audit',
      allowRemote: false,
    }), /Refusing non-loopback/);
  });
});

describe('audit evidence finalization', () => {
  test('creates persistable incomplete evidence for missing workload output', () => {
    assert.deepEqual(createIncompleteAuditMetric({
      requestedDriver: 'changeStreams',
      scriptFailed: true,
    }), {
      schema_version: 1,
      status: 'incomplete',
      requested_driver: 'changeStreams',
      failure_reasons: ['workload_process_failed', 'workload_output_missing'],
    });
  });

  test('preserves a passing workload only with matching observer and DDP evidence', () => {
    const audit = { status: 'passed', requested_driver: 'changeStreams' };
    finalizeAuditEvidence({
      audit,
      meteor: { version: '3.5.1-beta.0' },
      runtime: { observer_driver_actual: 'changeStreams', transport: 'sockjs' },
      metrics: passingMetrics(),
      scriptFailed: false,
    });
    assert.equal(audit.status, 'passed');
    assert.deepEqual(audit.failure_reasons, undefined);
  });

  test('a nonzero workload process cannot retain a passing status', () => {
    const audit = { status: 'passed', requested_driver: 'changeStreams' };
    finalizeAuditEvidence({
      audit,
      meteor: { version: '3.5.1-beta.0' },
      runtime: { observer_driver_actual: 'changeStreams', transport: 'sockjs' },
      metrics: passingMetrics(),
      scriptFailed: true,
    });
    assert.equal(audit.status, 'incomplete');
    assert.ok(audit.failure_reasons.includes('workload_process_failed'));
  });

  test('fails when any required event lacks message or byte evidence', () => {
    const metrics = passingMetrics();
    metrics.ddp_frame_size.by_type_bytes.out.removed = 0;
    const audit = { status: 'passed', requested_driver: 'changeStreams' };
    finalizeAuditEvidence({
      audit,
      meteor: { version: '3.5.1-beta.0' },
      runtime: { observer_driver_actual: 'changeStreams', transport: 'sockjs' },
      metrics,
      scriptFailed: false,
    });
    assert.equal(audit.status, 'failed');
    assert.ok(audit.failure_reasons.includes('transport_evidence_missing'));
  });
});
