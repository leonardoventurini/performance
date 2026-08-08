import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDeclarativeAuditCatalog } from '../../../reliability/declarative/catalog.js';
import { createDeclarativePrimitiveRegistry } from '../../../reliability/runtime/primitive-registry.js';
import { validatePlanPrimitiveCoverage } from '../../../reliability/runtime/interpreter.js';
import type { InterpreterState, PrimitiveInvocation, RuntimeContext } from '../../../reliability/runtime/interpreter.js';

const sealStep = Object.freeze({
  id: 'seal', kind: 'seal_evidence' as const, onFailure: 'fail_case' as const,
});

function invocation(context: RuntimeContext): PrimitiveInvocation {
  const plan = {
    schemaVersion: 1 as const,
    contractId: 'contract', contractDigest: 'a'.repeat(64), caseDefinitionDigest: 'b'.repeat(64),
    profileId: 'smoke', digest: 'c'.repeat(64),
    coordinate: {
      caseId: 'case', transport: 'sockjs' as const, topology: 'replica_set' as const,
      observerOrder: ['changeStreams'], seed: 1,
    },
    resolvedParameters: {}, steps: [sealStep],
    budget: {
      maximumSteps: 1, maximumDocuments: 1, maximumSubscribers: 1,
      maximumPayloadBytes: 1, maximumEvidenceEntries: 10,
      stepTimeoutMs: 100, caseTimeoutMs: 100, maximumRetries: 0 as const,
    },
  };
  const definition = {
    id: 'case',
    fixture: {
      collection: 'reliabilityDocuments' as const,
      publication: 'reliability.documents' as const,
      generator: 'synthetic-document-v1',
      subscribers: { kind: 'literal' as const, value: 1 },
      documents: { kind: 'literal' as const, value: 1 },
      payloadBytes: { kind: 'literal' as const, value: 1 },
    },
    steps: [sealStep], oracles: [],
  };
  const state: InterpreterState = {
    plan, definition, runId: 'run', fixture: {}, context,
    outputs: new Map(), provenance: new Map(), ledger: [], sealed: null,
  };
  return {
    state, step: sealStep, signal: new AbortController().signal,
    resolve: (value: unknown): unknown => value,
  };
}

test('trusted registry covers every authored declarative step without identifier policy', () => {
  const catalog = loadDeclarativeAuditCatalog();
  const registry = createDeclarativePrimitiveRegistry();
  for (const definition of catalog.cases) {
    const steps = definition.steps;
    assert.ok(Array.isArray(steps));
    assert.doesNotThrow(() => validatePlanPrimitiveCoverage({ steps }, registry), String(definition.id));
  }
});

test('missing runtime adapters fail explicitly instead of declining a coordinate', async () => {
  const registry = createDeclarativePrimitiveRegistry();
  const resume = registry.clientLifecycle.resume_sticky_instance;
  assert.ok(resume);
  await assert.rejects(
    () => resume(invocation({})),
    /trusted runtime adapter clients.execute is unavailable/,
  );
});

test('seal evidence delegates quiescence to the trusted adapter and returns its immutable cutoff', async () => {
  const registry = createDeclarativePrimitiveRegistry();
  const calls: string[] = [];
  const seal = registry.steps.seal_evidence;
  assert.ok(seal);
  const cutoff = await seal(invocation({
    evidence: {
          async seal(sealInvocation: PrimitiveInvocation) {
            calls.push(sealInvocation.step.id);
            return {
              sealed: true,
              producers: ['mongodb'],
              cutoff: { sequence: 11 },
              quietWindow: { startSequence: 10, endSequence: 11, eventStable: true },
            };
          },
        },
  }));
  assert.deepEqual(calls, ['seal']);
  assert.ok(cutoff && typeof cutoff === 'object');
  assert.equal(Object.isFrozen(cutoff), true);
  assert.equal(Object.isFrozen(Reflect.get(cutoff, 'cutoff')), true);
  assert.deepEqual(Reflect.get(cutoff, 'cutoff'), { sequence: 11 });
});

test('seal evidence rejects an adapter response that is not a sealed cutoff', async () => {
  const registry = createDeclarativePrimitiveRegistry();
  const seal = registry.steps.seal_evidence;
  assert.ok(seal);
  await assert.rejects(
    () => seal(invocation({ evidence: { seal: async () => ({ sealed: false }) } })),
    /invalid immutable cutoff/,
  );
});
