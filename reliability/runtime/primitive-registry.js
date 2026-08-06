import {
  DECLARATIVE_AUDIT_CLIENT_ACTIONS,
  DECLARATIVE_AUDIT_FAULT_CONTROLLERS,
} from '../contracts/declarative-audit.js';

const WAIT_PREDICATES = Object.freeze([
  'all_subscribers_ready', 'event_ledger_contains', 'all_subscribers_converged',
  'observer_driver_witnessed', 'fault_activated', 'fault_recovered',
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

function requireAdapter(state, name, method) {
  const adapter = state.context[name];
  if (!adapter || typeof adapter[method] !== 'function') {
    throw new Error(`trusted runtime adapter ${name}.${method} is unavailable`);
  }
  return adapter;
}

function actionHandlers(actions, adapterName) {
  return Object.freeze(Object.fromEntries(actions.map((action) => [action, async (invocation) => {
    const adapter = requireAdapter(invocation.state, adapterName, 'execute');
    return adapter.execute(action, invocation);
  }])));
}

/**
 * Creates the complete trusted primitive registry for CaseDefinitionV1.
 * Adapter absence is explicit execution incompleteness, never silent filtering.
 */
export function createDeclarativePrimitiveRegistry() {
  const fault = Object.fromEntries(DECLARATIVE_AUDIT_FAULT_CONTROLLERS.map((controller) => [
    controller,
    Object.freeze({
      activate: async (invocation) => requireAdapter(invocation.state, 'faults', 'execute')
        .execute(controller, 'activate', invocation),
      restore: async (invocation) => requireAdapter(invocation.state, 'faults', 'execute')
        .execute(controller, 'restore', invocation),
    }),
  ]));
  return Object.freeze({
    steps: Object.freeze({
      subscribe: async (invocation) => requireAdapter(invocation.state, 'clients', 'subscribe').subscribe(invocation),
      mongo_write: async (invocation) => requireAdapter(invocation.state, 'database', 'write').write(invocation),
      barrier: async (invocation) => requireAdapter(invocation.state, 'barriers', 'execute').execute(invocation),
      snapshot: async (invocation) => requireAdapter(invocation.state, 'evidence', 'snapshot').snapshot(invocation),
      seal_evidence: async (invocation) => {
        const evidence = requireAdapter(invocation.state, 'evidence', 'seal');
        const cutoff = await evidence.seal(invocation);
        if (
          !cutoff || typeof cutoff !== 'object' || cutoff.sealed !== true
          || !Array.isArray(cutoff.producers) || cutoff.producers.length === 0
          || !cutoff.producers.every((producer) => typeof producer === 'string' && producer.length > 0)
          || !cutoff.cutoff || typeof cutoff.cutoff !== 'object'
          || !cutoff.quietWindow || typeof cutoff.quietWindow !== 'object'
          || !Number.isInteger(cutoff.quietWindow.startSequence)
          || !Number.isInteger(cutoff.quietWindow.endSequence)
          || cutoff.quietWindow.endSequence < cutoff.quietWindow.startSequence
        ) {
          throw new Error('trusted evidence adapter returned an invalid immutable cutoff');
        }
        return immutable(cutoff);
      },
    }),
    wait: actionHandlers(WAIT_PREDICATES, 'waits'),
    clientLifecycle: actionHandlers(DECLARATIVE_AUDIT_CLIENT_ACTIONS, 'clients'),
    fault: Object.freeze(fault),
    cleanup: async ({ state, definition, runId }) => {
      const database = requireAdapter(state, 'database', 'cleanup');
      return database.cleanup({ state, definition, runId });
    },
  });
}
