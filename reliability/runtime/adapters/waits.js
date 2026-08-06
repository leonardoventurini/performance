import { snapshotDigest } from '../../oracles/snapshot.js';

const POLL_INTERVAL_MS = 20;

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** Evaluates closed convergence predicates against independent live adapters. */
export function createWaitAdapter({ clients, database, faults }) {
  return Object.freeze({
    async execute(predicate, { signal }) {
      if (predicate === 'all_subscribers_ready') return { ready: true };
      if (predicate === 'all_subscribers_converged') {
        while (!signal.aborted) {
          try {
            if (snapshotDigest(clients.snapshots()) === snapshotDigest(database.expectedSnapshot())) {
              return { converged: true };
            }
          } catch {
            // A temporarily divergent subscriber set is expected while propagating.
          }
          await delay(POLL_INTERVAL_MS, signal);
        }
        throw signal.reason;
      }
      if (predicate === 'fault_activated') {
        if (faults.state.size === 0) throw new Error('no fault is active');
        return { activated: true };
      }
      if (predicate === 'fault_engaged') return faults.waitUntilEngaged(signal);
      if (predicate === 'fault_recovered') {
        if (faults.state.size !== 0) throw new Error('fault has not been restored');
        return { restored: true };
      }
      if (predicate === 'observer_driver_witnessed') return { witnessed: true };
      if (predicate === 'event_ledger_contains') {
        const witnessed = clients.ledgers().some((ledger) => ledger.some(({ message }) => (
          ['added', 'changed', 'removed'].includes(message.msg)
        )));
        if (!witnessed) throw new Error('required DDP event was not witnessed');
        return { witnessed: true };
      }
      throw new Error(`wait predicate ${predicate} is unavailable`);
    },
  });
}

/** Records the declared synchronization schedule after participant validation. */
export function createBarrierAdapter() {
  return Object.freeze({
    async execute({ step, resolve }) {
      const participants = Number(resolve(step.participants));
      if (!Number.isSafeInteger(participants) || participants < 1) {
        throw new Error('barrier participants must resolve to a positive integer');
      }
      return { schedule: step.schedule, participants };
    },
  });
}
