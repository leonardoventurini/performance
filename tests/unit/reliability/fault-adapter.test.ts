import assert from 'node:assert/strict';
import test from 'node:test';

import { createFaultAdapter } from '../../../reliability/runtime/adapters/faults.js';

test('primary stepdown begins on activation and is awaited on restoration', async () => {
  let restore: () => void = () => undefined;
  const recovery = new Promise<void>((resolve) => { restore = resolve; });
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

test('restoreAll rejects false restoration witnesses and retains active state', async () => {
  const client = {
    state: 'connected',
    resume: async () => undefined,
    call: async (_method: string, parameters: readonly unknown[]) => {
      const operation = Reflect.get(parameters[0] as object, 'operation');
      return operation === 'activate' ? { activated: true } : { restored: false };
    },
  };
  const faults = createFaultAdapter({
    environment: { replicaSet: { stepDownPrimary: async () => undefined } },
    clients: { clients: [], faultControlClients: async () => [client] },
    runId: 'run', caseExecutionId: 'case', ownershipToken: 'token',
  });
  await faults.execute('startup_snapshot_pause', 'activate', { step: { faultId: 'fault' } });

  await assert.rejects(faults.restoreAll(), /fault restoration was incomplete/);
  assert.equal(faults.state.has('fault'), true);
});

test('asymmetric activation restores successful targets before rejecting', async () => {
  const calls: string[] = [];
  const first = {
    state: 'connected',
    resume: async () => undefined,
    call: async (_method: string, parameters: readonly unknown[]) => {
      const operation = String(Reflect.get(parameters[0] as object, 'operation'));
      calls.push(`first:${operation}`);
      return operation === 'activate' ? { activated: true } : { restored: true };
    },
  };
  const second = {
    state: 'connected',
    resume: async () => undefined,
    call: async () => {
      calls.push('second:activate');
      throw new Error('second backend failed');
    },
  };
  const faults = createFaultAdapter({
    environment: { replicaSet: { stepDownPrimary: async () => undefined } },
    clients: { clients: [], faultControlClients: async () => [first, second] },
    runId: 'run', caseExecutionId: 'case', ownershipToken: 'token',
  });

  await assert.rejects(
    faults.execute('watch_setup_pause', 'activate', { step: { faultId: 'fault' } }),
    /second backend failed/,
  );
  assert.deepEqual(calls, ['first:activate', 'second:activate', 'first:restore']);
  assert.equal(faults.state.has('fault'), false);
});

test('activation rejects a lifecycle status witness without an activation attestation', async () => {
  const client = {
    state: 'connected',
    resume: async () => undefined,
    call: async () => ({ engaged: true }),
  };
  const faults = createFaultAdapter({
    environment: { replicaSet: { stepDownPrimary: async () => undefined } },
    clients: { clients: [], faultControlClients: async () => [client] },
    runId: 'run', caseExecutionId: 'case', ownershipToken: 'token',
  });

  await assert.rejects(
    faults.execute('watch_setup_pause', 'activate', { step: { faultId: 'fault' } }),
    /did not attest activation/u,
  );
  assert.equal(faults.state.has('fault'), false);
});
