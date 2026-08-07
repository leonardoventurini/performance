const QUIET_WINDOW_MS = 100;

interface EvidenceCollection {
  find?(selector: Readonly<Record<string, unknown>>): {
    sort(specification: Readonly<Record<string, 1 | -1>>): { toArray(): Promise<readonly unknown[]> };
  };
}

interface EvidenceClients {
  snapshots(): readonly Readonly<Record<string, unknown>>[];
  ledgers(): readonly (readonly Readonly<{ direction: string; message: Readonly<{ msg?: string }> }>[])[];
  verifyPostconditions?(): unknown;
}

interface ExpectedModel {
  expectedSnapshot?(): readonly Readonly<Record<string, unknown>>[];
}

interface EvidenceProxy {
  snapshotLedger?(): readonly unknown[];
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

/** Produces independent MongoDB/DDP snapshots and immutable evidence cutoffs. */
export function createEvidenceAdapter({ collection, clients, database, proxy, runId, caseExecutionId }: Readonly<{
  collection: EvidenceCollection;
  clients: EvidenceClients;
  database: ExpectedModel;
  proxy: EvidenceProxy;
  runId: string;
  caseExecutionId: string;
}>) {
  let sequence = 0;
  return Object.freeze({
    async snapshot({ step }: Readonly<{ step: Readonly<{ producer: string }> }>) {
      sequence += 1;
      if (step.producer === 'mongodb') {
        if (!collection.find) throw new Error('MongoDB snapshot producer is unavailable');
        const snapshot = await collection.find({ runId, caseExecutionId }).sort({ _id: 1 }).toArray();
        return { snapshot, provenance: { snapshot: 'mongodb' } };
      }
      if (step.producer === 'ddp_client') {
        return { snapshot: clients.snapshots(), provenance: { snapshot: 'ddp_client' } };
      }
      if (step.producer === 'expected_model') {
        if (!database.expectedSnapshot) throw new Error('expected-model snapshot producer is unavailable');
        return { snapshot: database.expectedSnapshot(), provenance: { snapshot: 'expected_model' } };
      }
      throw new Error(`snapshot producer ${step.producer} requires a dedicated adapter`);
    },
    async seal({ signal }: Readonly<{ signal?: AbortSignal }> = {}) {
      clients.verifyPostconditions?.();
      const startSequence = sequence;
      const eventCount = (): number[] => clients.ledgers().map((ledger) => ledger.filter(({ direction, message }) => (
        direction === 'in' && typeof message.msg === 'string'
          && ['added', 'changed', 'removed'].includes(message.msg)
      )).length);
      const before = eventCount();
      await delay(QUIET_WINDOW_MS, signal);
      const after = eventCount();
      sequence += 1;
      if (!proxy.snapshotLedger) throw new Error('proxy evidence ledger is unavailable');
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
