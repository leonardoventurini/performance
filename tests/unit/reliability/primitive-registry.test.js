import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDeclarativeAuditCatalog } from '../../../reliability/declarative/catalog.js';
import { createDeclarativePrimitiveRegistry } from '../../../reliability/runtime/primitive-registry.js';
import { validatePlanPrimitiveCoverage } from '../../../reliability/runtime/interpreter.js';

test('trusted registry covers every authored declarative step without identifier policy', () => {
  const catalog = loadDeclarativeAuditCatalog();
  const registry = createDeclarativePrimitiveRegistry();
  for (const definition of catalog.cases) {
    assert.doesNotThrow(() => validatePlanPrimitiveCoverage({ steps: definition.steps }, registry), definition.id);
  }
});

test('missing runtime adapters fail explicitly instead of declining a coordinate', async () => {
  const registry = createDeclarativePrimitiveRegistry();
  await assert.rejects(() => registry.clientLifecycle.resume_sticky_instance({
    state: { context: {} }, step: {},
  }), /trusted runtime adapter clients.execute is unavailable/);
});

test('seal evidence delegates quiescence to the trusted adapter and returns its immutable cutoff', async () => {
  const registry = createDeclarativePrimitiveRegistry();
  const calls = [];
  const cutoff = await registry.steps.seal_evidence({
    state: {
      context: {
        evidence: {
          async seal(invocation) {
            calls.push(invocation.step.id);
            return {
              sealed: true,
              producers: ['mongodb'],
              cutoff: { sequence: 11 },
              quietWindow: { startSequence: 10, endSequence: 11 },
            };
          },
        },
      },
    },
    step: { id: 'seal' },
  });
  assert.deepEqual(calls, ['seal']);
  assert.equal(Object.isFrozen(cutoff), true);
  assert.equal(Object.isFrozen(cutoff.cutoff), true);
  assert.deepEqual(cutoff.cutoff, { sequence: 11 });
});

test('seal evidence rejects an adapter response that is not a sealed cutoff', async () => {
  const registry = createDeclarativePrimitiveRegistry();
  await assert.rejects(() => registry.steps.seal_evidence({
    state: { context: { evidence: { seal: async () => ({ sealed: false }) } } },
    step: { id: 'seal' },
  }), /invalid immutable cutoff/);
});
