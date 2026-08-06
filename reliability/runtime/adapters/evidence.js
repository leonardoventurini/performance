const QUIET_WINDOW_MS = 100;

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

/** Produces independent MongoDB/DDP snapshots and immutable evidence cutoffs. */
export function createEvidenceAdapter({ collection, clients, database, proxy, runId, caseExecutionId }) {
  let sequence = 0;
  return Object.freeze({
    async snapshot({ step }) {
      sequence += 1;
      if (step.producer === 'mongodb') {
        const snapshot = await collection.find({ runId, caseExecutionId }).sort({ _id: 1 }).toArray();
        return { snapshot, provenance: { snapshot: 'mongodb' } };
      }
      if (step.producer === 'ddp_client') {
        return { snapshot: clients.snapshots(), provenance: { snapshot: 'ddp_client' } };
      }
      if (step.producer === 'expected_model') {
        return { snapshot: database.expectedSnapshot(), provenance: { snapshot: 'expected_model' } };
      }
      throw new Error(`snapshot producer ${step.producer} requires a dedicated adapter`);
    },
    async seal({ signal }) {
      const startSequence = sequence;
      const eventCount = () => clients.ledgers().map((ledger) => ledger.filter(({ direction, message }) => (
        direction === 'in' && ['added', 'changed', 'removed'].includes(message.msg)
      )).length);
      const before = eventCount();
      await delay(QUIET_WINDOW_MS, signal);
      const after = eventCount();
      sequence += 1;
      return {
        sealed: true,
        producers: ['mongodb', 'ddp_client', 'meteor_probe', 'fault_controller'],
        cutoff: {
          sequence,
          ddpLedgerEntries: after,
          proxyLedgerEntries: proxy.snapshotLedger().length,
        },
        quietWindow: {
          startSequence,
          endSequence: sequence,
          eventStable: before.every((count, index) => count === after[index]),
        },
      };
    },
  });
}
