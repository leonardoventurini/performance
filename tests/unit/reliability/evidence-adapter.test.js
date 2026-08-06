import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceAdapter } from '../../../reliability/runtime/adapters/evidence.js';

test('evidence snapshots bind exact producer provenance', async () => {
  const adapter = createEvidenceAdapter({
    collection: { find: () => ({ sort: () => ({ toArray: async () => [{ _id: 'one' }] }) }) },
    clients: { snapshots: () => [{ _id: 'one' }], ledgers: () => [] },
    database: { expectedSnapshot: () => [{ _id: 'one' }] },
    proxy: { snapshotLedger: () => [] },
    runId: 'run-1',
    caseExecutionId: 'case-1',
  });
  assert.deepEqual(await adapter.snapshot({ step: { producer: 'mongodb' } }), {
    snapshot: [{ _id: 'one' }], provenance: { snapshot: 'mongodb' },
  });
  assert.deepEqual(await adapter.snapshot({ step: { producer: 'ddp_client' } }), {
    snapshot: [{ _id: 'one' }], provenance: { snapshot: 'ddp_client' },
  });
});

test('seal proves an event-stable quiet window', async () => {
  const ledgers = [[{ direction: 'in', message: { msg: 'added' } }]];
  const adapter = createEvidenceAdapter({
    collection: {},
    clients: { snapshots: () => [], ledgers: () => ledgers },
    database: {},
    proxy: { snapshotLedger: () => [{ sequence: 1 }] },
    runId: 'run-1',
    caseExecutionId: 'case-1',
  });
  const seal = await adapter.seal({});
  assert.equal(seal.sealed, true);
  assert.equal(seal.quietWindow.eventStable, true);
  assert.deepEqual(seal.cutoff.ddpLedgerEntries, [1]);
});
