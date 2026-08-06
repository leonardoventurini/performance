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
      async snapshot() { events.push('snapshot'); return { snapshot: [{ _id: '1', value: 1 }], provenance: { snapshot: 'mongodb' } }; },
      async seal_evidence() {
        events.push('seal');
        return { sealed: true, producers: ['mongodb'], cutoff: { sequence: 3 }, quietWindow: { startSequence: 2, endSequence: 3, eventStable: true } };
      },
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

test('named concurrency groups start members before a barrier joins them', async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const concurrentRegistry = registry(events);
  concurrentRegistry.steps.mongo_write = async ({ step }) => {
    events.push(`start:${step.id}`);
    if (step.id === 'writer-a') await gate;
    else release();
    events.push(`finish:${step.id}`);
    return { expectedState: [] };
  };
  concurrentRegistry.steps.barrier = async ({ step }) => {
    events.push(`barrier:${step.id}`);
    return { joined: true };
  };
  const concurrentPlan = {
    ...plan,
    steps: [
      { id: 'writer-a', kind: 'mongo_write', concurrencyGroup: 'writers', onFailure: 'fail_case' },
      { id: 'writer-b', kind: 'mongo_write', concurrencyGroup: 'writers', onFailure: 'fail_case' },
      { id: 'join', kind: 'barrier', barrier: 'writers', schedule: 'concurrent', participants: { kind: 'literal', value: 2 }, onFailure: 'fail_case' },
    ],
  };
  const interpreter = new DeclarativeCaseInterpreter({ registry: concurrentRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: concurrentPlan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'passed');
  assert.deepEqual(events, ['start:writer-a', 'start:writer-b', 'finish:writer-b', 'finish:writer-a', 'barrier:join', 'cleanup']);
  assert.deepEqual(execution.evidence.stepLedger.map(({ stepId }) => stepId), ['writer-a', 'writer-b', 'join']);
});

test('step deadlines abort and settle a primitive before cleanup starts', async () => {
  const events = [];
  const slowPlan = {
    ...plan,
    steps: [{ id: 'subscribe', kind: 'subscribe', timeoutMs: 5, onFailure: 'incomplete_case' }],
  };
  const slowRegistry = registry(events);
  slowRegistry.steps.subscribe = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      events.push('primitive-settled');
      resolve({});
    }, { once: true });
  });
  const interpreter = new DeclarativeCaseInterpreter({ registry: slowRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: slowPlan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'incomplete');
  assert.match(execution.failure.reason, /deadline exceeded/);
  assert.deepEqual(events, ['primitive-settled', 'cleanup']);
});

test('cleanup has a bounded deadline and must settle after cancellation', async () => {
  const events = [];
  const cleanupPlan = { ...plan, budget: { ...plan.budget, stepTimeoutMs: 5 } };
  const slowRegistry = registry(events);
  slowRegistry.cleanup = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      events.push('cleanup-settled');
      resolve({});
    }, { once: true });
  });
  const interpreter = new DeclarativeCaseInterpreter({ registry: slowRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: cleanupPlan, definition: { cleanup: {} }, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'incomplete');
  assert.deepEqual(events, ['subscribe:1', 'write', 'snapshot', 'seal', 'cleanup-settled']);
  assert.match(execution.failure.reason, /deadline exceeded/);
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
  const forged = {
    ...execution,
    evidence: { ...execution.evidence, provenance: { snapshot: { snapshot: 'ddp_client' } } },
  };
  const forgedResult = evaluateDeclarativeOracles({ definition, execution: forged });
  assert.equal(forgedResult.status, 'failed');
  assert.equal(forgedResult.results[0].reason, 'evidence_provenance_mismatch');
  const missing = { ...execution, evidence: { ...execution.evidence, outputs: {} } };
  assert.equal(evaluateDeclarativeOracles({ definition, execution: missing }).status, 'incomplete');
});

test('event absence requires provenance-bound evidence sealed after a quiet window', () => {
  const definition = { oracles: [{
    id: 'absent', family: 'event_absent', producer: 'ddp_client', gate: 'hard',
    expected: { kind: 'literal', value: { type: 'changed' } },
    observed: { producer: 'ddp_client', stepId: 'events', ledger: 'ledger' },
    failureReason: 'unexpected_event',
  }] };
  const evidence = {
    coordinate: {},
    outputs: { events: { ledger: [] } },
    provenance: { events: { ledger: 'ddp_client' } },
  };
  assert.equal(evaluateDeclarativeOracles({ definition, execution: { status: 'passed', evidence } }).status, 'failed');
  evidence.outputs.seal = {
    sealed: true,
    producers: ['ddp_client'],
    cutoff: { sequence: 7 },
    quietWindow: { startSequence: 6, endSequence: 7, eventStable: true },
  };
  assert.equal(evaluateDeclarativeOracles({ definition, execution: { status: 'passed', evidence } }).status, 'passed');
});
