import assert from 'node:assert/strict';
import test from 'node:test';

import { DeclarativeCaseInterpreter, validatePlanPrimitiveCoverage } from '../../../reliability/runtime/interpreter.js';
import type {
  DeclarativePrimitiveRegistry,
  PrimitiveInvocation,
} from '../../../reliability/runtime/interpreter.js';
import type {
  CompiledCasePlan,
  DeclarativeCaseDefinition,
} from '../../../reliability/contracts/declarative-audit.js';
import type { DeclarativeExecution } from '../../../reliability/runtime/interpreter.js';

function evaluatorExecution(execution: DeclarativeExecution): Parameters<typeof evaluateDeclarativeOracles>[0]['execution'] {
  return {
    status: execution.status,
    evidence: {
      coordinate: Object.fromEntries(Object.entries(execution.evidence.coordinate)),
      outputs: execution.evidence.outputs,
      provenance: Object.fromEntries(Object.entries(execution.evidence.provenance).map(([stepId, values]) => [
        stepId,
        Object.fromEntries(Object.entries(values).flatMap(([key, value]) => (
          typeof value === 'string' ? [[key, value]] : []
        ))),
      ])),
    },
  };
}

function binaryPayload(execution: DeclarativeExecution): Uint8Array {
  const snapshotOutput = execution.evidence.outputs.snapshot?.snapshot;
  if (!Array.isArray(snapshotOutput) || !snapshotOutput[0] || typeof snapshotOutput[0] !== 'object') {
    throw new Error('test snapshot evidence is missing');
  }
  const payload = Reflect.get(snapshotOutput[0], 'payload');
  if (!(payload instanceof Uint8Array)) throw new Error('test binary payload is missing');
  return payload;
}
import { DECLARATIVE_ORACLE_HANDLERS, evaluateDeclarativeOracles } from '../../../reliability/oracles/evaluator.js';

const subscribeStep = {
  id: 'subscribe', kind: 'subscribe' as const,
  clients: { kind: 'parameter' as const, name: 'subscribers' },
  query: { kind: 'unordered' as const }, onFailure: 'incomplete_case' as const,
};
const writeStep = {
  id: 'write', kind: 'mongo_write' as const, operation: 'insert_one' as const,
  selector: { kind: 'fixture_document' as const, index: 0 },
  mutation: { kind: 'fixture_document' as const, index: 0 },
  expectedTransition: { kind: 'insert' as const }, onFailure: 'fail_case' as const,
};

const plan: CompiledCasePlan = {
  schemaVersion: 1,
  contractId: 'contract',
  contractDigest: 'a'.repeat(64),
  caseDefinitionDigest: 'b'.repeat(64),
  digest: 'c'.repeat(64),
  profileId: 'smoke',
  coordinate: {
    caseId: 'event.insert', seed: 42, transport: 'sockjs', topology: 'replica_set',
    observerOrder: ['changeStreams'],
  },
  resolvedParameters: { subscribers: 1 },
  steps: [
    subscribeStep,
    writeStep,
    { id: 'snapshot', kind: 'snapshot', producer: 'mongodb', scope: 'mongodb', onFailure: 'incomplete_case' },
    { id: 'seal', kind: 'seal_evidence', onFailure: 'incomplete_case' },
  ],
  budget: {
    maximumSteps: 20, maximumDocuments: 10, maximumSubscribers: 10,
    maximumPayloadBytes: 1_024, maximumEvidenceEntries: 20,
    stepTimeoutMs: 1_000, caseTimeoutMs: 5_000, maximumRetries: 0,
  },
};

const caseDefinition: DeclarativeCaseDefinition = {
  id: 'event.insert',
  fixture: {
    collection: 'reliabilityDocuments', publication: 'reliability.documents',
    generator: 'synthetic-document-v1',
    subscribers: { kind: 'literal', value: 1 }, documents: { kind: 'literal', value: 1 },
    payloadBytes: { kind: 'literal', value: 1 },
  },
  steps: plan.steps,
  oracles: [],
};

interface TestRegistry {
  steps: Record<string, (invocation: PrimitiveInvocation) => Promise<unknown>>;
  readonly wait: DeclarativePrimitiveRegistry['wait'];
  readonly clientLifecycle: DeclarativePrimitiveRegistry['clientLifecycle'];
  readonly fault: DeclarativePrimitiveRegistry['fault'];
  abort?: NonNullable<DeclarativePrimitiveRegistry['abort']>;
  cleanup: DeclarativePrimitiveRegistry['cleanup'];
}

function registry(events: string[], { failWrite = false }: Readonly<{ failWrite?: boolean }> = {}): TestRegistry {
  return {
    steps: {
      async subscribe({ resolve, step }) {
        if (step.kind !== 'subscribe') throw new Error('test received the wrong step kind');
        events.push(`subscribe:${String(resolve(step.clients))}`); return {};
      },
      async mongo_write() { events.push('write'); if (failWrite) throw new Error('write failed'); return { expectedState: [{ _id: '1', value: 1 }] }; },
      async snapshot() { events.push('snapshot'); return { snapshot: [{ _id: '1', value: 1 }], provenance: { snapshot: 'mongodb' } }; },
      async seal_evidence() {
        events.push('seal');
        return { sealed: true, producers: ['mongodb'], cutoff: { sequence: 3 }, quietWindow: { startSequence: 2, endSequence: 3, eventStable: true } };
      },
    },
    wait: {}, clientLifecycle: {}, fault: {},
    async cleanup() { events.push('cleanup'); return { cleanup: true }; },
  };
}

test('interpreter executes only registered steps, resolves values, and always cleans up', async () => {
  const events: string[] = [];
  const interpreter = new DeclarativeCaseInterpreter({ registry: registry(events), interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'passed');
  assert.deepEqual(events, ['subscribe:1', 'write', 'snapshot', 'seal', 'cleanup']);
  const cleanup = execution.evidence.outputs.cleanup;
  assert.ok(cleanup);
  assert.equal(cleanup.cleanup, true);
  assert.match(execution.evidence.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => { Reflect.set(cleanup, 'cleanup', false); }, TypeError);
});

test('interpreter seals binary evidence without attempting to freeze typed-array elements', async () => {
  const events: string[] = [];
  const producerBytes = new Uint8Array([1, 2, 3]);
  const binaryRegistry = registry(events);
  binaryRegistry.steps.snapshot = async () => ({
    snapshot: [{ _id: '1', payload: producerBytes }],
    provenance: { snapshot: 'mongodb' },
  });
  const interpreter = new DeclarativeCaseInterpreter({ registry: binaryRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: caseDefinition, runId: 'run-1', fixture: {} });

  assert.equal(execution.status, 'passed');
  assert.deepEqual([...binaryPayload(execution)], [1, 2, 3]);
  assert.equal(Object.isFrozen(execution.evidence.outputs.snapshot), true);
  producerBytes[0] = 99;
  assert.deepEqual([...binaryPayload(execution)], [1, 2, 3]);
});

test('fallback oracle binds observed source, topology target, and reason presence', () => {
  const oracle = {
    id: 'fallback', family: 'fallback_identity', failureReason: 'mismatch', gate: 'hard',
    expected: { kind: 'literal' },
    observed: { producer: 'meteor_probe', stepId: 'subscribe', ledger: 'fallback_selection' },
  };
  const execution = {
    status: 'passed',
    evidence: { coordinate: { topology: 'replica_set' }, outputs: {}, provenance: {} },
  };
  const expected = {
    kind: 'fallback', from: 'changeStreams',
    to: { replica_set: 'oplog', standalone: 'polling' }, reasonRequired: true,
  };
  const fallbackIdentity = DECLARATIVE_ORACLE_HANDLERS.fallback_identity;
  assert.ok(fallbackIdentity);
  assert.equal(fallbackIdentity({
    expected,
    observed: { kind: 'fallback', from: 'changeStreams', to: 'oplog', reasonRequired: true },
    execution, oracle,
  }), true);
  assert.equal(fallbackIdentity({
    expected,
    observed: { kind: 'fallback', from: 'changeStreams', to: 'polling', reasonRequired: true },
    execution, oracle,
  }), false);
});

test('primitive coverage fails before the first side effect', () => {
  const events: string[] = [];
  assert.throws(() => validatePlanPrimitiveCoverage({ ...plan, steps: [{
    id: 'resume', kind: 'client_lifecycle', action: 'unknown',
    clients: { kind: 'literal', value: 1 }, onFailure: 'fail_case',
  }] }, registry(events)), /client_lifecycle:unknown/);
  assert.deepEqual(events, []);
});

test('step failure classification follows the declarative onFailure contract', async () => {
  const events: string[] = [];
  const interpreter = new DeclarativeCaseInterpreter({ registry: registry(events, { failWrite: true }), interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'failed');
  assert.deepEqual(events, ['subscribe:1', 'write', 'cleanup']);
  assert.deepEqual(execution.failure, { stepId: 'write', reason: 'write failed' });
});

test('named concurrency groups start members before a barrier joins them', async () => {
  const events: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
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
  const concurrentPlan: CompiledCasePlan = {
    ...plan,
    steps: [
      { ...writeStep, id: 'writer-a', concurrencyGroup: 'writers' },
      { ...writeStep, id: 'writer-b', concurrencyGroup: 'writers' },
      { id: 'join', kind: 'barrier', barrier: 'writers', schedule: 'concurrent', participants: { kind: 'literal', value: 2 }, onFailure: 'fail_case' },
    ],
  };
  const interpreter = new DeclarativeCaseInterpreter({ registry: concurrentRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: concurrentPlan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'passed');
  assert.deepEqual(events, ['start:writer-a', 'start:writer-b', 'finish:writer-b', 'finish:writer-a', 'barrier:join', 'cleanup']);
  assert.deepEqual(execution.evidence.stepLedger.map(({ stepId }) => stepId), ['writer-a', 'writer-b', 'join']);
});

test('failed race steps restore trusted faults before pending members settle', async () => {
  const events: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const abortRegistry = registry(events);
  abortRegistry.steps.subscribe = async () => { events.push('pending'); await gate; events.push('settled'); return {}; };
  abortRegistry.steps.mongo_write = async () => { throw new Error('race failed'); };
  abortRegistry.abort = async () => { events.push('abort'); release(); };
  const abortPlan: CompiledCasePlan = {
    ...plan,
    steps: [
      { ...subscribeStep, id: 'pending', concurrencyGroup: 'race' },
      { ...writeStep, id: 'failure' },
    ],
  };
  const interpreter = new DeclarativeCaseInterpreter({ registry: abortRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: abortPlan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'failed');
  assert.deepEqual(events, ['pending', 'abort', 'settled', 'cleanup']);
});

test('step deadlines abort and settle a primitive before cleanup starts', async () => {
  const events: string[] = [];
  const slowPlan: CompiledCasePlan = {
    ...plan,
    steps: [{ ...subscribeStep, timeoutMs: 5 }],
  };
  const slowRegistry = registry(events);
  slowRegistry.steps.subscribe = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      events.push('primitive-settled');
      resolve({});
    }, { once: true });
  });
  const interpreter = new DeclarativeCaseInterpreter({ registry: slowRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: slowPlan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'incomplete');
  assert.ok(execution.failure);
  assert.match(execution.failure.reason, /deadline exceeded/);
  assert.deepEqual(events, ['primitive-settled', 'cleanup']);
});

test('cleanup has a bounded deadline and must settle after cancellation', async () => {
  const events: string[] = [];
  const cleanupPlan = { ...plan, budget: { ...plan.budget, stepTimeoutMs: 5 } };
  const slowRegistry = registry(events);
  slowRegistry.cleanup = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      events.push('cleanup-settled');
      resolve({});
    }, { once: true });
  });
  const interpreter = new DeclarativeCaseInterpreter({ registry: slowRegistry, interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan: cleanupPlan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  assert.equal(execution.status, 'incomplete');
  assert.ok(execution.failure);
  assert.deepEqual(events, ['subscribe:1', 'write', 'snapshot', 'seal', 'cleanup-settled']);
  assert.match(execution.failure.reason, /deadline exceeded/);
});

test('oracle evaluator compares independent snapshots and fails closed on absence', async () => {
  const interpreter = new DeclarativeCaseInterpreter({ registry: registry([]), interpreterVersion: 'test-v1' });
  const execution = await interpreter.execute({ plan, definition: caseDefinition, runId: 'run-1', fixture: {} });
  const oracleDefinition = { oracles: [{
    id: 'snapshot', family: 'snapshot_exact', producer: 'mongodb', gate: 'hard',
    expected: { kind: 'step', stepId: 'write', output: 'expectedState' },
    observed: { producer: 'mongodb', stepId: 'snapshot', ledger: 'snapshot' },
    failureReason: 'content_digest_mismatch',
  }] };
  assert.equal(evaluateDeclarativeOracles({
    definition: oracleDefinition,
    execution: evaluatorExecution(execution),
  }).status, 'passed');
  const forged = {
    ...execution,
    evidence: { ...execution.evidence, provenance: { snapshot: { snapshot: 'ddp_client' } } },
  };
  const forgedResult = evaluateDeclarativeOracles({
    definition: oracleDefinition,
    execution: evaluatorExecution(forged),
  });
  assert.equal(forgedResult.status, 'failed');
  assert.equal(forgedResult.results[0]?.reason, 'evidence_provenance_mismatch');
  const missing = { ...execution, evidence: { ...execution.evidence, outputs: {} } };
  assert.equal(evaluateDeclarativeOracles({
    definition: oracleDefinition,
    execution: evaluatorExecution(missing),
  }).status, 'incomplete');
});

test('event absence requires provenance-bound evidence sealed after a quiet window', () => {
  const definition = { oracles: [{
    id: 'absent', family: 'event_absent', producer: 'ddp_client', gate: 'hard',
    expected: { kind: 'literal', value: { type: 'changed' } },
    observed: { producer: 'ddp_client', stepId: 'events', ledger: 'ledger' },
    failureReason: 'unexpected_event',
  }] };
  const outputs: Record<string, Record<string, unknown>> = { events: { ledger: [] } };
  const evidence = {
    coordinate: {},
    outputs,
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
