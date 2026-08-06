import { contractDigest } from '../contracts/digest.js';

const STEP_KINDS = Object.freeze([
  'subscribe', 'mongo_write', 'wait', 'barrier', 'client_lifecycle', 'fault',
  'snapshot', 'seal_evidence',
]);

function immutable(value) {
  const result = structuredClone(value);
  const freeze = (entry) => {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
      Object.freeze(entry);
      for (const child of Object.values(entry)) freeze(child);
    }
    return entry;
  };
  return freeze(result);
}

function timeoutSignal(milliseconds, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`deadline exceeded after ${milliseconds}ms`)), milliseconds);
  timer.unref?.();
  const abort = () => controller.abort(parentSignal.reason);
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

async function bounded(operation, signal) {
  if (signal.aborted) throw signal.reason;
  let abort;
  const aborted = new Promise((resolve, reject) => {
    abort = () => reject(signal.reason || new Error('operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function resolveValue(reference, state) {
  if (!reference || typeof reference !== 'object' || !Object.hasOwn(reference, 'kind')) return reference;
  switch (reference.kind) {
    case 'literal': return immutable(reference.value);
    case 'parameter': return state.plan.resolvedParameters[reference.name];
    case 'coordinate': return immutable(state.plan.coordinate[reference.field]);
    case 'run': return state.runId;
    case 'fixture': return immutable(state.fixture[reference.field]);
    case 'step': {
      if (!state.outputs.has(reference.stepId)) throw new Error(`step ${reference.stepId} has no output`);
      const output = state.outputs.get(reference.stepId);
      if (!Object.hasOwn(output, reference.output)) {
        throw new Error(`step ${reference.stepId} has no output named ${reference.output}`);
      }
      return immutable(output[reference.output]);
    }
    default: throw new Error(`unknown value reference kind ${reference.kind}`);
  }
}

function registryHandler(registry, step) {
  if (step.kind === 'client_lifecycle') return registry.clientLifecycle?.[step.action];
  if (step.kind === 'fault') return registry.fault?.[step.controller]?.[step.operation];
  if (step.kind === 'wait') return registry.wait?.[step.predicate];
  return registry.steps?.[step.kind];
}

/** Proves that every compiled step resolves to one trusted primitive before side effects. */
export function validatePlanPrimitiveCoverage(plan, registry) {
  const missing = [];
  for (const step of plan.steps) {
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
  constructor({ registry, interpreterVersion }) {
    if (!registry || typeof registry !== 'object') throw new TypeError('primitive registry is required');
    if (typeof interpreterVersion !== 'string' || interpreterVersion.length === 0) {
      throw new TypeError('interpreterVersion is required');
    }
    this.registry = registry;
    this.interpreterVersion = interpreterVersion;
  }

  async execute({ plan, definition, runId, fixture, context = {} }) {
    validatePlanPrimitiveCoverage(plan, this.registry);
    const caseDeadline = timeoutSignal(plan.budget.caseTimeoutMs);
    const state = {
      plan,
      definition,
      runId,
      fixture: immutable(fixture),
      context,
      outputs: new Map(),
      ledger: [],
      sealed: null,
    };
    let status = 'passed';
    let failure = null;
    try {
      for (const step of plan.steps) {
        const stepDeadline = timeoutSignal(
          Math.min(step.timeoutMs || plan.budget.stepTimeoutMs, plan.budget.stepTimeoutMs),
          caseDeadline.signal,
        );
        try {
          const handler = registryHandler(this.registry, step);
          const output = await bounded(handler({
            step: immutable(step),
            signal: stepDeadline.signal,
            resolve: (reference) => resolveValue(reference, state),
            state,
          }), stepDeadline.signal);
          state.outputs.set(step.id, immutable(output || {}));
          state.ledger.push(immutable({ stepId: step.id, status: 'completed' }));
          if (state.ledger.length > plan.budget.maximumEvidenceEntries) {
            throw new Error('case evidence budget exceeded');
          }
        } catch (error) {
          status = step.onFailure === 'fail_case' ? 'failed' : 'incomplete';
          failure = { stepId: step.id, reason: String(error.message || error) };
          state.ledger.push(immutable({ stepId: step.id, status, reason: failure.reason }));
          break;
        } finally {
          stepDeadline.dispose();
        }
      }
    } finally {
      caseDeadline.dispose();
      try {
        const cleanup = await this.registry.cleanup({ state, definition, runId });
        state.outputs.set('cleanup', immutable(cleanup || {}));
      } catch (error) {
        status = 'incomplete';
        failure = { stepId: 'cleanup', reason: String(error.message || error) };
      }
    }
    const outputs = Object.fromEntries(state.outputs);
    const unsignedEvidence = {
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
    };
    const evidence = immutable({ ...unsignedEvidence, digest: contractDigest(unsignedEvidence) });
    return Object.freeze({ status, failure, evidence });
  }
}
