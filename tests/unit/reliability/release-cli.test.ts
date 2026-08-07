import assert from 'node:assert/strict';
import test from 'node:test';

import { createReleaseCaseExecutor } from '../../../cli/release-audit.js';
import type { MeteorSource } from '../../../lib/benchmark-types.js';

const TEST_SOURCE: MeteorSource = {
  mode: 'release', meteorCmd: 'meteor', releaseArg: '--release=test',
  checkoutPath: null, version: 'test', sha: 'release:test',
};
const TEST_CATALOG_ID = 'test-contract';
const TEST_CATALOG_DIGEST = 'a'.repeat(64);

test('release executor compiles every coordinate without silent support filtering', async () => {
  const calls: unknown[] = [];
  const environment = { stop: async () => ({ restored: true }) };
  const executeCase = createReleaseCaseExecutor({
    values: {}, source: TEST_SOURCE, appPath: '/app', releaseIdentity: {},
    catalog: {
      contract: { id: TEST_CATALOG_ID },
      digest: TEST_CATALOG_DIGEST,
      casesById: new Map([['event.insert', { id: 'event.insert' }]]),
      profilesById: new Map<string, Readonly<{ id: string }>>(),
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
    values: {}, source: TEST_SOURCE, appPath: '/app', releaseIdentity: {},
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

test('release executor retires a poisoned environment before the next coordinate', async () => {
  let environmentCount = 0;
  let invocationCount = 0;
  const stopped: number[] = [];
  const executeCase = createReleaseCaseExecutor({
    values: {}, source: TEST_SOURCE, appPath: '/app', releaseIdentity: {},
    environmentFactory: async () => {
      environmentCount += 1;
      const identity = environmentCount;
      return {
        async stop() {
          stopped.push(identity);
          return {
            restored: true,
            recovery: {
              runDocumentsRemoved: true, topologyRestored: true,
              profilerRestored: true, networkRestored: true,
            },
          };
        },
      };
    },
    runCase: async () => {
      invocationCount += 1;
      if (invocationCount === 1) throw new Error('poisoned transport');
      return { status: 'passed' };
    },
  });
  const coordinate = {
    caseId: 'event.insert', transport: 'sockjs', topology: 'replica_set', seed: 1,
    observerOrder: ['changeStreams', 'oplog', 'polling'],
  };

  await assert.rejects(() => executeCase({ coordinate, attemptId: 'attempt-1' }), /poisoned transport/u);
  await executeCase({ coordinate, attemptId: 'attempt-2' });
  assert.equal(environmentCount, 2);
  assert.deepEqual(stopped, [1]);
  await executeCase.finalize();
  assert.deepEqual(stopped, [1, 2]);
});
