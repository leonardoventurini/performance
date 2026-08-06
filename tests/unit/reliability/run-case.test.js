import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDeclarativeAuditCatalog } from '../../../reliability/declarative/catalog.js';
import { compileDeclarativeCase } from '../../../reliability/declarative/compiler.js';

test('event insert compiles with the exact runtime adapter inputs', () => {
  const catalog = loadDeclarativeAuditCatalog();
  const plan = compileDeclarativeCase({
    catalog,
    caseId: 'event.insert',
    profileId: 'smoke',
    coordinate: {
      caseId: 'event.insert', transport: 'sockjs', topology: 'replica_set', seed: 42,
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    },
  });
  assert.equal(plan.steps[0].kind, 'subscribe');
  assert.equal(plan.steps.at(-1).kind, 'seal_evidence');
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
});
