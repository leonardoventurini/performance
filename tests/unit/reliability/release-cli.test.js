import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseCaseExecutor } from '../../../cli/release-audit.js';

test('release executor compiles every coordinate without silent support filtering', async () => {
  const calls = [];
  const environment = { stop: async () => ({ restored: true }) };
  const executeCase = createReleaseCaseExecutor({
    values: {}, source: {}, appPath: '/app', releaseIdentity: {},
    catalog: {
      casesById: new Map([['event.insert', { id: 'event.insert' }]]),
      profilesById: new Map(),
    },
    environmentFactory: async () => environment,
    runCase: async (input) => { calls.push(input); return { status: 'passed' }; },
  });
  await assert.rejects(() => executeCase({
    coordinate: {
      caseId: 'missing', transport: 'sockjs', topology: 'replica_set', seed: 1,
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    },
    attemptId: 'attempt',
  }), /required declarative case missing is missing/);
  assert.equal(Object.hasOwn(executeCase, 'supports'), false);
  const finalized = await executeCase.finalize();
  assert.equal(finalized.recovery.topologyRestored, false);
  assert.equal(finalized.recovery.profilerRestored, false);
  assert.deepEqual(calls, []);
});

test('release finalization maps recovery dimensions independently', async () => {
  const environment = {
    stop: async () => ({
      recovery: {
        runDocumentsRemoved: true,
        topologyRestored: false,
        profilerRestored: true,
        networkRestored: true,
      },
    }),
  };
  const executeCase = createReleaseCaseExecutor({
    values: {}, source: {}, appPath: '/app', releaseIdentity: {},
    environmentFactory: async () => environment,
    runCase: async () => ({ status: 'passed' }),
  });
  await executeCase({
    coordinate: {
      caseId: 'event.insert', transport: 'sockjs', topology: 'replica_set', seed: 1,
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    },
    attemptId: 'attempt',
  });
  const { recovery } = await executeCase.finalize();
  assert.equal(recovery.runDocumentsRemoved, true);
  assert.equal(recovery.topologyRestored, false);
  assert.equal(recovery.profilerRestored, true);
  assert.equal(recovery.networkRestored, true);
});
