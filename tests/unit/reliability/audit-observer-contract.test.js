import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAuditScope,
  validateAuditEchoRequest,
  validateAuditFaultRequest,
  validateAuditMonitorRequest,
} from '../../../apps/tasks-3.x/packages/bench-monitors/audit-observer-contract.js';
import {
  buildReliabilityCursorPlans,
} from '../../../apps/tasks-3.x/packages/tasks-common/reliability-query-descriptors.js';

test('observer correlation extracts only valid run and case identifiers', () => {
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

test('transport echo is ownership-attested and byte bounded', () => {
  const expected = { runId: 'run-1', ownershipToken: 'secret' };
  assert.deepEqual(validateAuditEchoRequest({
    runId: 'run-1', ownershipToken: 'secret', payload: { value: 'ok' },
  }, expected), { payload: { value: 'ok' }, byteLength: 14 });
  assert.throws(() => validateAuditEchoRequest({
    runId: 'run-1', ownershipToken: 'secret', payload: 'oversized',
  }, expected, 2), /byte ceiling/);
});

test('fault control accepts only owned closed primitives', () => {
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

test('server-owned cursor plans carry distinct closed correlation tags', () => {
  const request = {
    runId: 'run-1', caseExecutionId: 'case-1', queryId: 'multiple_projections',
  };
  const plans = buildReliabilityCursorPlans(request);
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map(({ options }) => options._auditObserverScope.cursorOrdinal),
    [0, 1],
  );
  assert.notEqual(
    plans[0].options._auditObserverScope.cursorFingerprint,
    plans[1].options._auditObserverScope.cursorFingerprint,
  );
  assert.deepEqual(buildReliabilityCursorPlans(request), plans);
  assert.equal(buildReliabilityCursorPlans('run-1')[0].options._auditObserverScope, undefined);
});

test('monitor evidence reads require exact run and ownership token', () => {
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
