import assert from 'node:assert/strict';
import test from 'node:test';

import { createFaultAdapter } from '../../../reliability/runtime/adapters/faults.js';

test('primary stepdown begins on activation and is awaited on restoration', async () => {
  let restore;
  const recovery = new Promise((resolve) => { restore = resolve; });
  const faults = createFaultAdapter({
    environment: { replicaSet: { stepDownPrimary: () => recovery } },
    clients: { clients: [] }, runId: 'run', caseExecutionId: 'case', ownershipToken: 'token',
  });
  const activation = await faults.execute('mongodb_primary_step_down', 'activate', {
    step: { faultId: 'fault' },
  });
  assert.equal(activation.fault_witness.activated, true);
  let completed = false;
  const restoration = faults.execute('mongodb_primary_step_down', 'restore', {
    step: { faultId: 'fault' },
  }).then((value) => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  restore();
  assert.equal((await restoration).fault_witness.restored, true);
});
