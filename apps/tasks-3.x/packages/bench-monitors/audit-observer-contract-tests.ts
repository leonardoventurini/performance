import { assert } from './test-assertions';

import {
  deriveObservedFallback,
  extractAuditScope,
  validateAuditEchoRequest,
  validateAuditFaultRequest,
  validateAuditMonitorRequest,
} from './audit-observer-contract';

it('observer correlation extracts only valid run and case identifiers', () => {
  assert.deepEqual(extractAuditScope({ options: { _auditObserverScope: {
    runId: 'run-1', caseExecutionId: 'case-1', queryId: 'multiple_projections',
    cursorOrdinal: 1, cursorFingerprint: 'cursor-deadbeef',
  } } }), {
    runId: 'run-1', caseExecutionId: 'case-1', queryId: 'multiple_projections',
    cursorOrdinal: 1, cursorFingerprint: 'cursor-deadbeef',
  });
  assert.equal(extractAuditScope({ runId: 'run-1', selector: { arbitrary: true } }), null);
  assert.equal(extractAuditScope({ selector: {
    runId: 'run-1', caseExecutionId: 'case-1', queryId: 'unordered',
    cursorOrdinal: 0, cursorFingerprint: 'cursor-deadbeef',
  } }), null);
  assert.equal(extractAuditScope({ options: { _auditObserverScope: {
    runId: '../escape', caseExecutionId: 'case-1', queryId: 'unordered',
    cursorOrdinal: 0, cursorFingerprint: 'cursor-deadbeef',
  } } }), null);
});

it('fallback provenance requires an independently observed rejected driver check', () => {
  assert.deepEqual(deriveObservedFallback({
    configuredOrder: ['changeStreams', 'oplog', 'polling'],
    attempts: [
      { driver: 'changeStreams', available: false, reason: 'ordered observeChanges is unsupported' },
      { driver: 'oplog', available: true },
    ],
  }, 'oplog'), {
    fallbackFrom: 'changeStreams',
    fallbackReason: 'ordered observeChanges is unsupported',
  });
  assert.equal(deriveObservedFallback({
    configuredOrder: ['changeStreams', 'oplog', 'polling'],
    attempts: [{ driver: 'changeStreams', available: false }],
  }, 'oplog'), null);
  assert.equal(deriveObservedFallback({
    configuredOrder: ['changeStreams', 'oplog', 'polling'],
    attempts: [{ driver: 'changeStreams', available: true }],
  }, 'oplog'), null);
});

it('transport echo is ownership-attested and byte bounded', () => {
  const expected = { runId: 'run-1', ownershipToken: 'secret' };
  assert.deepEqual(validateAuditEchoRequest({
    runId: 'run-1', ownershipToken: 'secret', payload: { value: 'ok' },
  }, expected), { payload: { value: 'ok' }, byteLength: 14 });
  assert.throws(() => validateAuditEchoRequest({
    runId: 'run-1', ownershipToken: 'secret', payload: 'oversized',
  }, expected, 2), /byte ceiling/);
});

it('fault control accepts only owned closed primitives', () => {
  const request = {
    runId: 'run-1', caseExecutionId: 'case-1', ownershipToken: 'secret',
    controller: 'stream_restart', operation: 'activate', faultId: 'fault-1',
  };
  assert.deepEqual(validateAuditFaultRequest(request, {
    runId: 'run-1', ownershipToken: 'secret',
  }, ['stream_restart']), {
    runId: 'run-1', caseExecutionId: 'case-1', controller: 'stream_restart',
    operation: 'activate', faultId: 'fault-1',
  });
  assert.throws(() => validateAuditFaultRequest({ ...request, controller: 'shell' }, {
    runId: 'run-1', ownershipToken: 'secret',
  }, ['stream_restart']), /unknown audit fault controller/);
});

it('monitor evidence reads require exact run and ownership token', () => {
  const expected = { runId: 'run-1', ownershipToken: 'secret' };
  assert.deepEqual(validateAuditMonitorRequest({ runId: 'run-1', ownershipToken: 'secret' }, expected), {
    runId: 'run-1', caseExecutionId: null,
  });
  assert.deepEqual(validateAuditMonitorRequest({
    runId: 'run-1', caseExecutionId: 'case-1', ownershipToken: 'secret',
  }, expected), {
    runId: 'run-1', caseExecutionId: 'case-1',
  });
  assert.throws(() => validateAuditMonitorRequest({ runId: 'run-1', ownershipToken: 'wrong' }, expected), /attestation failed/);
  assert.throws(() => validateAuditMonitorRequest({
    runId: 'run-1', caseExecutionId: '../escape', ownershipToken: 'secret',
  }, expected), /caseExecutionId/);
  assert.throws(() => validateAuditMonitorRequest({
    runId: 'run-1', ownershipToken: 'secret', selector: {},
  }, expected), /unknown audit monitor fields/);
});
