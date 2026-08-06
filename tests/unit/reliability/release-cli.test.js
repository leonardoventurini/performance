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
  assert.deepEqual(calls, []);
});
