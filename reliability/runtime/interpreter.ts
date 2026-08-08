import { contractDigest } from '../contracts/digest.js';
import type {
  CompiledCasePlan,
  DeclarativeCaseDefinition,
  DeclarativeStep,
  DeclarativeValueRef,
} from '../contracts/declarative-audit.js';
import { immutableClone } from './immutable.js';

const STEP_KINDS = Object.freeze([
  'subscribe', 'mongo_write', 'wait', 'barrier', 'client_lifecycle', 'fault',
  'snapshot', 'seal_evidence',
]);
const ABORT_SETTLEMENT_TIMEOUT_MS = 250;

type RuntimeRecord = Record<string, unknown>;
type StepOutput = Readonly<Record<string, unknown>>;

/** Stable evidence envelope emitted by one interpreter execution. */
export interface DeclarativeExecutionEvidence {
  readonly schemaVersion: 1;
  readonly interpreterVersion: string;
  readonly contractDigest: string;
  readonly planDigest: string;
  readonly caseDefinitionDigest: string;
  readonly runId: string;
  readonly coordinate: CompiledCasePlan['coordinate'];
  readonly status: 'passed' | 'failed' | 'incomplete';
  readonly failure: Readonly<{ stepId: string; reason: string }> | null;
  readonly stepLedger: readonly RuntimeRecord[];
  readonly outputs: Readonly<Record<string, StepOutput>>;
  readonly provenance: Readonly<Record<string, RuntimeRecord>>;
  readonly digest: string;
}

/** Complete result returned by the trusted interpreter. */
export interface DeclarativeExecution {
  readonly status: 'passed' | 'failed' | 'incomplete';
  readonly failure: Readonly<{ stepId: string; reason: string }> | null;
  readonly evidence: DeclarativeExecutionEvidence;
}

/** Invocation passed only to a primitive selected by the closed registry. */
export interface PrimitiveInvocation {
  readonly step: DeclarativeStep;
  readonly signal: AbortSignal;
  readonly resolve: (reference: DeclarativeValueRef) => unknown;
  readonly state: InterpreterState;
}

/** Runtime adapters installed for one isolated execution. */
export interface RuntimeContext extends Readonly<Record<string, unknown>> {}

/** Mutable interpreter state owned exclusively by one execution. */
export interface InterpreterState {
  readonly plan: CompiledCasePlan;
  readonly definition: DeclarativeCaseDefinition;
  readonly runId: string;
  readonly fixture: RuntimeRecord;
  readonly context: RuntimeContext;
  readonly outputs: Map<string, StepOutput>;
  readonly provenance: Map<string, RuntimeRecord>;
  readonly ledger: RuntimeRecord[];
  sealed: RuntimeRecord | null;
  cleanupUnsafe?: boolean;
}

type PrimitiveHandler = (invocation: PrimitiveInvocation) => Promise<unknown>;

/** Closed primitive registry consumed by the interpreter. */
export interface DeclarativePrimitiveRegistry {
  readonly steps: Readonly<Record<string, PrimitiveHandler | undefined>>;
  readonly wait: Readonly<Record<string, PrimitiveHandler>>;
  readonly clientLifecycle: Readonly<Record<string, PrimitiveHandler>>;
  readonly fault: Readonly<Record<string, Readonly<Record<'activate' | 'restore', PrimitiveHandler>>>>;
  readonly abort?: (input: Readonly<{ state: InterpreterState; definition: DeclarativeCaseDefinition; runId: string }>) => Promise<void>;
  readonly cleanup: (input: Readonly<{ state: InterpreterState; definition: DeclarativeCaseDefinition; runId: string; signal: AbortSignal }>) => Promise<unknown>;
}

interface CleanupUnsafeError extends Error { cleanupUnsafe: true }
interface ConcurrencyError extends Error { concurrencyStep: DeclarativeStep }

function isConcurrencyError(error: Error): error is ConcurrencyError {
  return 'concurrencyStep' in error && isRuntimeRecord(error.concurrencyStep)
    && typeof error.concurrencyStep.id === 'string';
}

function immutable<Value>(value: Value): Value {
  return immutableClone(value);
}

function timeoutSignal(milliseconds: number, parentSignal?: AbortSignal): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`deadline exceeded after ${milliseconds}ms`)), milliseconds);
  timer.unref?.();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

async function waitForSettlement(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function bounded<Value>(operation: () => Value | Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) throw signal.reason;
  const pending = Promise.resolve().then(operation);
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason || new Error('operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (signal.aborted) {
      const settled = await waitForSettlement(pending, ABORT_SETTLEMENT_TIMEOUT_MS);
      if (!settled) {
        const settlementError: CleanupUnsafeError = Object.assign(
          new Error('aborted primitive did not settle; cleanup is unsafe'),
          { cleanupUnsafe: true as const },
        );
        throw settlementError;
      }
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValueRef(value: unknown): value is DeclarativeValueRef {
  return isRuntimeRecord(value) && typeof value.kind === 'string';
}

function resolveValue(reference: DeclarativeValueRef | unknown, state: InterpreterState): unknown {
  if (!isValueRef(reference)) return reference;
  switch (reference.kind) {
    case 'literal': return immutable(reference.value);
    case 'parameter': return state.plan.resolvedParameters[reference.name];
    case 'coordinate': return immutable(state.plan.coordinate[reference.field]);
    case 'run': return state.runId;
    case 'fixture': return immutable(state.fixture[reference.field]);
    case 'step': {
      if (!state.outputs.has(reference.stepId)) throw new Error(`step ${reference.stepId} has no output`);
      const output = state.outputs.get(reference.stepId);
      if (!output || !Object.hasOwn(output, reference.output)) {
        throw new Error(`step ${reference.stepId} has no output named ${reference.output}`);
      }
      return immutable(output[reference.output]);
    }
  }
}

interface CoverageStep {
  readonly kind: string;
  readonly action?: string;
  readonly controller?: string;
  readonly operation?: string;
  readonly predicate?: string;
}

function isCoverageStep(value: unknown): value is CoverageStep {
  return isRuntimeRecord(value) && typeof value.kind === 'string';
}

function registryHandler(registry: DeclarativePrimitiveRegistry, step: CoverageStep): PrimitiveHandler | undefined {
  if (step.kind === 'client_lifecycle' && step.action) return registry.clientLifecycle?.[step.action];
  if (step.kind === 'fault' && step.controller
      && (step.operation === 'activate' || step.operation === 'restore')) {
    return registry.fault?.[step.controller]?.[step.operation];
  }
  if (step.kind === 'wait' && step.predicate) return registry.wait?.[step.predicate];
  return registry.steps?.[step.kind];
}

/** Proves that every compiled step resolves to one trusted primitive before side effects. */
export function validatePlanPrimitiveCoverage(
  plan: Readonly<{ steps: readonly unknown[] }>,
  registry: DeclarativePrimitiveRegistry,
): void {
  const missing: string[] = [];
  for (const candidate of plan.steps) {
    if (!isCoverageStep(candidate)) {
      missing.push('invalid_step');
      continue;
    }
    const step = candidate;
    if (!STEP_KINDS.includes(step.kind) || typeof registryHandler(registry, step) !== 'function') {
      const identity = step.kind === 'client_lifecycle'
        ? `${step.kind}:${step.action}`
        : step.kind === 'fault'
          ? `${step.kind}:${step.controller}:${step.operation}`
          : step.kind === 'wait'
            ? `${step.kind}:${step.predicate}`
            : step.kind;
      missing.push(identity);
    }
  }
  if (typeof registry.cleanup !== 'function') missing.push('cleanup');
  if (missing.length > 0) {
    throw new Error(`compiled plan has unavailable trusted primitives: ${[...new Set(missing)].sort().join(', ')}`);
  }
}

/** @typedef {'passed'|'failed'|'incomplete'} DeclarativeExecutionStatus */

/**
 * Executes a compiled case through a closed trusted registry.
 * Definitions can select registered behavior but can never inject executable code.
 */
export class DeclarativeCaseInterpreter {
  readonly registry: DeclarativePrimitiveRegistry;
  readonly interpreterVersion: string;

  constructor({ registry, interpreterVersion }: Readonly<{
    registry: DeclarativePrimitiveRegistry;
    interpreterVersion: string;
  }>) {
    if (!registry || typeof registry !== 'object') throw new TypeError('primitive registry is required');
    if (typeof interpreterVersion !== 'string' || interpreterVersion.length === 0) {
      throw new TypeError('interpreterVersion is required');
    }
    this.registry = registry;
    this.interpreterVersion = interpreterVersion;
  }

  async execute({ plan, definition, runId, fixture, context = {} }: Readonly<{
    plan: CompiledCasePlan;
    definition: DeclarativeCaseDefinition;
    runId: string;
    fixture: RuntimeRecord;
    context?: RuntimeContext;
  }>): Promise<DeclarativeExecution> {
    validatePlanPrimitiveCoverage(plan, this.registry);
    const caseDeadline = timeoutSignal(plan.budget.caseTimeoutMs);
    const state: InterpreterState = {
      plan,
      definition,
      runId,
      fixture: immutable(fixture),
      context,
      outputs: new Map<string, StepOutput>(),
      provenance: new Map<string, RuntimeRecord>(),
      ledger: [] as RuntimeRecord[],
      sealed: null,
    };
    let status: 'passed' | 'failed' | 'incomplete' = 'passed';
    let failure: Readonly<{ stepId: string; reason: string }> | null = null;
    const pendingGroups = new Map<string, Array<Readonly<{ step: DeclarativeStep; operation: Promise<unknown> }>>>();
    const recordCompleted = (step: DeclarativeStep, output: unknown): void => {
      const normalizedOutput = isRuntimeRecord(output) ? output : {};
      state.outputs.set(step.id, immutable(normalizedOutput));
      if (isRuntimeRecord(normalizedOutput.provenance)) {
        state.provenance.set(step.id, immutable(normalizedOutput.provenance));
      }
      state.ledger.push(immutable({ stepId: step.id, status: 'completed' }));
      if (state.ledger.length > plan.budget.maximumEvidenceEntries) {
        throw new Error('case evidence budget exceeded');
      }
    };
    const invokeStep = (step: DeclarativeStep, parentSignal: AbortSignal): Promise<unknown> => {
      const stepDeadline = timeoutSignal(
        Math.min(step.timeoutMs || plan.budget.stepTimeoutMs, plan.budget.stepTimeoutMs),
        parentSignal,
      );
      const handler = registryHandler(this.registry, step);
      if (!handler) throw new Error(`trusted primitive for step ${step.id} is unavailable`);
      const operation = bounded(() => handler({
        step: immutable(step),
        signal: stepDeadline.signal,
        resolve: (reference) => resolveValue(reference, state),
        state,
      }), stepDeadline.signal).finally(() => stepDeadline.dispose());
      operation.catch(() => {});
      return operation;
    };
    try {
      for (const step of plan.steps) {
        try {
          if (step.concurrencyGroup !== undefined) {
            const entries = pendingGroups.get(step.concurrencyGroup) || [];
            entries.push({ step, operation: invokeStep(step, caseDeadline.signal) });
            pendingGroups.set(step.concurrencyGroup, entries);
            continue;
          }
          if (step.kind === 'barrier') {
            const entries = pendingGroups.get(step.barrier);
            if (!entries || entries.length === 0) throw new Error(`concurrency group ${step.barrier} has no pending members`);
            const declaredParticipants = Number(resolveValue(step.participants, state));
            if (declaredParticipants !== entries.length) {
              throw new Error(`concurrency group ${step.barrier} declared ${declaredParticipants} participants but started ${entries.length}`);
            }
            const outcomes = await Promise.allSettled(entries.map(({ operation }) => operation));
            for (let index = 0; index < entries.length; index += 1) {
              const entry = entries[index];
              const outcome = outcomes[index];
              if (!entry || !outcome) throw new Error('concurrency settlement lost a declared member');
              const member = entry.step;
              if (outcome.status === 'rejected') {
                const reason = outcome.reason instanceof Error
                  ? outcome.reason
                  : new Error(String(outcome.reason));
                throw Object.assign(reason, { concurrencyStep: member });
              }
              recordCompleted(member, outcome.value);
            }
            pendingGroups.delete(step.barrier);
          }
          const output = await invokeStep(step, caseDeadline.signal);
          recordCompleted(step, output);
        } catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          const failedStep = isConcurrencyError(error)
            ? error.concurrencyStep
            : step;
          status = failedStep.onFailure === 'fail_case' ? 'failed' : 'incomplete';
          failure = { stepId: failedStep.id, reason: String(error.message || error) };
          if ('cleanupUnsafe' in error && error.cleanupUnsafe === true) state.cleanupUnsafe = true;
          state.ledger.push(immutable({ stepId: failedStep.id, status, reason: failure.reason }));
          break;
        }
      }
    } finally {
      caseDeadline.dispose();
      if (pendingGroups.size > 0) {
        try {
          await this.registry.abort?.({ state, definition, runId });
        } catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          status = 'incomplete';
          const abortFailure = { stepId: 'abort', status: 'incomplete', reason: String(error.message || error) };
          state.ledger.push(immutable(abortFailure));
          failure ||= { stepId: 'abort', reason: abortFailure.reason };
        }
        const unsettled = [...pendingGroups.values()].flat().map(({ operation }) => operation);
        const settled = await waitForSettlement(Promise.allSettled(unsettled), ABORT_SETTLEMENT_TIMEOUT_MS);
        if (!settled) state.cleanupUnsafe = true;
      }
      if (!state.cleanupUnsafe) {
        const cleanupDeadline = timeoutSignal(plan.budget.stepTimeoutMs);
        try {
          const cleanup = await bounded(
            () => this.registry.cleanup({ state, definition, runId, signal: cleanupDeadline.signal }),
            cleanupDeadline.signal,
          );
          state.outputs.set('cleanup', immutable(isRuntimeRecord(cleanup) ? cleanup : {}));
          if (isRuntimeRecord(cleanup) && isRuntimeRecord(cleanup.provenance)) {
            state.provenance.set('cleanup', immutable(cleanup.provenance));
          }
        } catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          status = 'incomplete';
          failure = { stepId: 'cleanup', reason: String(error.message || error) };
        } finally {
          cleanupDeadline.dispose();
        }
      }
    }
    const outputs = Object.fromEntries(state.outputs);
    const unsignedEvidence: Omit<DeclarativeExecutionEvidence, 'digest'> = {
      schemaVersion: 1,
      interpreterVersion: this.interpreterVersion,
      contractDigest: plan.contractDigest,
      planDigest: plan.digest,
      caseDefinitionDigest: plan.caseDefinitionDigest,
      runId,
      coordinate: plan.coordinate,
      status,
      failure,
      stepLedger: state.ledger,
      outputs,
      provenance: Object.fromEntries(state.provenance),
    };
    const evidence: DeclarativeExecutionEvidence = immutable({
      ...unsignedEvidence,
      digest: contractDigest(unsignedEvidence),
    });
    return Object.freeze({ status, failure, evidence });
  }
}
