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
  const steps = Reflect.get(plan, 'steps');
  const digest = Reflect.get(plan, 'digest');
  assert.ok(Array.isArray(steps));
  const first = steps[0];
  const last = steps.at(-1);
  assert.ok(first && typeof first === 'object');
  assert.ok(last && typeof last === 'object');
  assert.equal(Reflect.get(first, 'kind'), 'subscribe');
  assert.equal(Reflect.get(last, 'kind'), 'seal_evidence');
  assert.equal(typeof digest, 'string');
  assert.match(digest, /^[a-f0-9]{64}$/);
});
