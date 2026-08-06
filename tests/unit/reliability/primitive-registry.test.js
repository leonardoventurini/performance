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
