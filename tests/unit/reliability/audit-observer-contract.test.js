import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAuditScope,
  validateAuditMonitorRequest,
} from '../../../apps/tasks-3.x/packages/bench-monitors/audit-observer-contract.js';

test('observer correlation extracts only valid run and case identifiers', () => {
  assert.deepEqual(extractAuditScope([{
    _selector: { runId: 'run-1', caseExecutionId: 'case-1' },
  }]), { runId: 'run-1', caseExecutionId: 'case-1' });
  assert.equal(extractAuditScope({ runId: 'run-1', selector: { arbitrary: true } }), null);
  assert.equal(extractAuditScope({ runId: '../escape', caseExecutionId: 'case-1' }), null);
});

test('monitor evidence reads require exact run and ownership token', () => {
  const expected = { runId: 'run-1', ownershipToken: 'secret' };
  assert.deepEqual(validateAuditMonitorRequest({ runId: 'run-1', ownershipToken: 'secret' }, expected), {
    runId: 'run-1',
  });
  assert.throws(() => validateAuditMonitorRequest({ runId: 'run-1', ownershipToken: 'wrong' }, expected), /attestation failed/);
  assert.throws(() => validateAuditMonitorRequest({
    runId: 'run-1', ownershipToken: 'secret', selector: {},
  }, expected), /unknown audit monitor fields/);
});
