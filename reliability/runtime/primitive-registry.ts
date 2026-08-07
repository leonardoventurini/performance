import {
  DECLARATIVE_AUDIT_CLIENT_ACTIONS,
  DECLARATIVE_AUDIT_FAULT_CONTROLLERS,
} from '../contracts/declarative-audit.js';
import type { DeclarativeCaseDefinition } from '../contracts/declarative-audit.js';
import type {
  DeclarativePrimitiveRegistry,
  InterpreterState,
  PrimitiveInvocation,
} from './interpreter.js';
import { immutableClone } from './immutable.js';

const WAIT_PREDICATES = Object.freeze([
  'all_subscribers_ready', 'event_ledger_contains', 'all_subscribers_converged',
  'observer_driver_witnessed', 'fault_activated', 'fault_recovered',
  'fault_engaged',
]);

type AdapterMethod = (...arguments_: readonly unknown[]) => unknown;

function immutable<Value>(value: Value): Value {
  return immutableClone(value);
}

function requireMethod(state: InterpreterState, name: string, method: string): AdapterMethod {
  const adapter = state.context[name];
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`trusted runtime adapter ${name}.${method} is unavailable`);
  }
  const candidate = Reflect.get(adapter, method);
  if (typeof candidate !== 'function') throw new Error(`trusted runtime adapter ${name}.${method} is unavailable`);
  return candidate.bind(adapter);
}

function actionHandlers(actions: readonly string[], adapterName: string): Readonly<Record<string, (invocation: PrimitiveInvocation) => Promise<unknown>>> {
  return Object.freeze(Object.fromEntries(actions.map((action) => [action, async (invocation: PrimitiveInvocation) => {
    return requireMethod(invocation.state, adapterName, 'execute')(action, invocation);
  }])));
}

function isValidCutoff(value: unknown): value is Readonly<{
  sealed: true;
  producers: readonly string[];
  cutoff: Readonly<Record<string, unknown>>;
  quietWindow: Readonly<{ startSequence: number; endSequence: number; eventStable: true }>;
}> {
  if (!value || typeof value !== 'object') return false;
  const sealed = Reflect.get(value, 'sealed');
  const producers = Reflect.get(value, 'producers');
  const cutoff = Reflect.get(value, 'cutoff');
  const quietWindow = Reflect.get(value, 'quietWindow');
  return sealed === true
    && Array.isArray(producers) && producers.length > 0
    && producers.every((producer) => typeof producer === 'string' && producer.length > 0)
    && cutoff !== null && typeof cutoff === 'object'
    && quietWindow !== null && typeof quietWindow === 'object'
    && Number.isInteger(Reflect.get(quietWindow, 'startSequence'))
    && Number.isInteger(Reflect.get(quietWindow, 'endSequence'))
    && Number(Reflect.get(quietWindow, 'endSequence')) >= Number(Reflect.get(quietWindow, 'startSequence'))
    && Reflect.get(quietWindow, 'eventStable') === true;
}

/**
 * Creates the complete trusted primitive registry for CaseDefinitionV1.
 * Adapter absence is explicit execution incompleteness, never silent filtering.
 */
export function createDeclarativePrimitiveRegistry(): DeclarativePrimitiveRegistry {
  const fault = Object.fromEntries(DECLARATIVE_AUDIT_FAULT_CONTROLLERS.map((controller) => [
    controller,
    Object.freeze({
      activate: async (invocation: PrimitiveInvocation) => requireMethod(invocation.state, 'faults', 'execute')
        (controller, 'activate', invocation),
      restore: async (invocation: PrimitiveInvocation) => requireMethod(invocation.state, 'faults', 'execute')
        (controller, 'restore', invocation),
    }),
  ]));
  return Object.freeze({
    steps: Object.freeze({
      subscribe: async (invocation: PrimitiveInvocation) => requireMethod(invocation.state, 'clients', 'subscribe')(invocation),
      mongo_write: async (invocation: PrimitiveInvocation) => requireMethod(invocation.state, 'database', 'write')(invocation),
      barrier: async (invocation: PrimitiveInvocation) => requireMethod(invocation.state, 'barriers', 'execute')(invocation),
      snapshot: async (invocation: PrimitiveInvocation) => requireMethod(invocation.state, 'evidence', 'snapshot')(invocation),
      seal_evidence: async (invocation: PrimitiveInvocation) => {
        const cutoff = await requireMethod(invocation.state, 'evidence', 'seal')(invocation);
        if (!isValidCutoff(cutoff)) {
          throw new Error('trusted evidence adapter returned an invalid immutable cutoff');
        }
        return immutable(cutoff);
      },
    }),
    wait: actionHandlers(WAIT_PREDICATES, 'waits'),
    clientLifecycle: actionHandlers(DECLARATIVE_AUDIT_CLIENT_ACTIONS, 'clients'),
    fault: Object.freeze(fault),
    abort: async ({ state }: Readonly<{ state: InterpreterState }>) => {
      const outcomes = await Promise.allSettled([
        requireMethod(state, 'faults', 'restoreAll')(),
        requireMethod(state, 'clients', 'close')(),
      ]);
      const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'trusted abort recovery was incomplete');
    },
    cleanup: async ({ state, definition, runId, signal }: Readonly<{
      state: InterpreterState;
      definition: DeclarativeCaseDefinition;
      runId: string;
      signal: AbortSignal;
    }>) => {
      return requireMethod(state, 'database', 'cleanup')({ state, definition, runId, signal });
    },
  });
}
