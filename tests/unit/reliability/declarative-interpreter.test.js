import assert from 'node:assert/strict';
import test from 'node:test';

import { DeclarativeCaseInterpreter, validatePlanPrimitiveCoverage } from '../../../reliability/runtime/interpreter.js';
import { evaluateDeclarativeOracles } from '../../../reliability/oracles/evaluator.js';

const plan = Object.freeze({
  contractDigest: 'a'.repeat(64),
  caseDefinitionDigest: 'b'.repeat(64),
  digest: 'c'.repeat(64),
  coordinate: { caseId: 'event.insert', seed: 42, transport: 'sockjs', topology: 'replica_set' },
  resolvedParameters: { subscribers: 1 },
  steps: [
    { id: 'subscribe', kind: 'subscribe', clients: { kind: 'parameter', name: 'subscribers' }, onFailure: 'incomplete_case' },
    { id: 'write', kind: 'mongo_write', onFailure: 'fail_case' },
    { id: 'snapshot', kind: 'snapshot', producer: 'mongodb', scope: 'mongodb', onFailure: 'incomplete_case' },
    { id: 'seal', kind: 'seal_evidence', onFailure: 'incomplete_case' },
  ],
  budget: { stepTimeoutMs: 1_000, caseTimeoutMs: 5_000, maximumEvidenceEntries: 20 },
});

function registry(events, { failWrite = false } = {}) {
  return {
    steps: {
      async subscribe({ resolve, step }) { events.push(`subscribe:${resolve(step.clients)}`); return {}; },
      async mongo_write() { events.push('write'); if (failWrite) throw new Error('write failed'); return { expectedState: [{ _id: '1', value: 1 }] }; },
      async snapshot() { events.push('snapshot'); return { snapshot: [{ _id: '1', value: 1 }] }; },
      async seal_evidence() { events.push('seal'); return {}; },
    },
    async cleanup() { events.push('cleanup'); return { cleanup: true }; },
  };
}

test('interpreter executes only registered steps, resolves values, and always cleans up', async () => {
  const events = [];
  const interpreter = new DeclarativeCaseInterpreter({ registry: registry(events), interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'passed');
  assert.deepEqual(events, ['subscribe:1', 'write', 'snapshot', 'seal', 'cleanup']);
  assert.equal(execution.evidence.outputs.cleanup.cleanup, true);
  assert.match(execution.evidence.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => { execution.evidence.outputs.cleanup.cleanup = false; }, TypeError);
});

test('primitive coverage fails before the first side effect', () => {
  const events = [];
  assert.throws(() => validatePlanPrimitiveCoverage({ ...plan, steps: [{
    id: 'resume', kind: 'client_lifecycle', action: 'unknown', onFailure: 'fail_case',
  }] }, registry(events)), /client_lifecycle:unknown/);
  assert.deepEqual(events, []);
});

test('step failure classification follows the declarative onFailure contract', async () => {
  const events = [];
  const interpreter = new DeclarativeCaseInterpreter({ registry: registry(events, { failWrite: true }), interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'failed');
  assert.deepEqual(events, ['subscribe:1', 'write', 'cleanup']);
  assert.deepEqual(execution.failure, { stepId: 'write', reason: 'write failed' });
});

test('step deadlines are enforced even when a primitive does not observe its signal', async () => {
  const events = [];
  const slowPlan = {
    ...plan,
    steps: [{ id: 'subscribe', kind: 'subscribe', timeoutMs: 5, onFailure: 'incomplete_case' }],
  };
  const slowRegistry = registry(events);
  slowRegistry.steps.subscribe = () => new Promise(() => {});
  const interpreter = new DeclarativeCaseInterpreter({ registry: slowRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: slowPlan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'incomplete');
  assert.match(execution.failure.reason, /deadline exceeded/);
  assert.deepEqual(events, ['cleanup']);
});

test('oracle evaluator compares independent snapshots and fails closed on absence', async () => {
  const interpreter = new DeclarativeCaseInterpreter({ registry: registry([]), interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  const definition = { oracles: [{
    id: 'snapshot', family: 'snapshot_exact', producer: 'mongodb', gate: 'hard',
    expected: { kind: 'step', stepId: 'write', output: 'expectedState' },
    observed: { producer: 'mongodb', stepId: 'snapshot', ledger: 'snapshot' },
    failureReason: 'content_digest_mismatch',
  }] };
  assert.equal(evaluateDeclarativeOracles({ definition, execution }).status, 'passed');
  const missing = { ...execution, evidence: { ...execution.evidence, outputs: {} } };
  assert.equal(evaluateDeclarativeOracles({ definition, execution: missing }).status, 'incomplete');
});
