const AUTO_RESTORE_MS = 250;

interface FaultClient {
  readonly state: string;
  call?(method: string, params: readonly unknown[]): Promise<unknown>;
  terminate?(): void;
  resume(): Promise<unknown>;
}

interface FaultClients {
  readonly clients: readonly FaultClient[];
  faultControlClients?(): Promise<readonly FaultClient[]>;
}

interface FaultReplicaSet {
  stepDownPrimary(): Promise<unknown>;
  suspendAll?(): void;
  resumeAll?(): Promise<unknown>;
}

interface FaultEnvironment { readonly replicaSet: FaultReplicaSet }

interface FaultStatus { readonly activated?: boolean; readonly engaged?: boolean; readonly restored?: boolean }
interface TrackedFault {
  readonly controller: string;
  readonly recovery: Promise<Readonly<{ restored: boolean; error?: unknown }>> | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function resumeAfterDisconnect(client: FaultClient): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  while (client.state !== 'disconnected') {
    if (Date.now() >= deadline) throw new Error('faulted DDP client did not disconnect');
    await delay(10);
  }
  return client.resume();
}

function digestibleWitness(controller: string, faultId: string, activated: boolean, restored: boolean) {
  return Object.freeze({ controller, faultId, activated, restored });
}

/** Controls only resources owned by the current audit environment. */
export function createFaultAdapter({ environment, clients, runId, caseExecutionId, ownershipToken }: Readonly<{
  environment: FaultEnvironment;
  clients: FaultClients;
  runId: string;
  caseExecutionId: string;
  ownershipToken: string;
}>) {
  const active = new Map<string, TrackedFault>();
  const invoke = async (client: FaultClient, controller: string, operation: string, faultId: string): Promise<FaultStatus> => {
    if (!client.call) throw new Error('fault control DDP method is unavailable');
    const result = await client.call('audit.faultControl', [{
      runId, caseExecutionId, ownershipToken, controller, operation, faultId,
    }]);
    if (!result || typeof result !== 'object') throw new Error('fault controller returned an invalid witness');
    return {
      ...(typeof Reflect.get(result, 'activated') === 'boolean' ? { activated: Reflect.get(result, 'activated') === true } : {}),
      ...(typeof Reflect.get(result, 'engaged') === 'boolean' ? { engaged: Reflect.get(result, 'engaged') === true } : {}),
      ...(typeof Reflect.get(result, 'restored') === 'boolean' ? { restored: Reflect.get(result, 'restored') === true } : {}),
    };
  };
  const internal = async (controller: string, operation: string, faultId: string): Promise<FaultStatus[]> => {
    if (!clients.faultControlClients) throw new Error('fault control clients are unavailable');
    return Promise.all((await clients.faultControlClients()).map((client) => invoke(client, controller, operation, faultId)));
  };
  const activateInternal = async (controller: string, faultId: string): Promise<void> => {
    if (!clients.faultControlClients) throw new Error('fault control clients are unavailable');
    const activated: FaultClient[] = [];
    try {
      for (const client of await clients.faultControlClients()) {
        const witness = await invoke(client, controller, 'activate', faultId);
        if (witness.activated !== true) throw new Error('fault controller did not attest activation');
        activated.push(client);
      }
    } catch (activationError) {
      const compensationFailures: unknown[] = [];
      for (const client of activated.reverse()) {
        try {
          const witness = await invoke(client, controller, 'restore', faultId);
          if (witness.restored !== true) throw new Error('fault controller did not attest compensation');
        } catch (error) {
          compensationFailures.push(error);
        }
      }
      if (compensationFailures.length > 0) {
        throw new AggregateError([activationError, ...compensationFailures], 'fault activation failed and compensation was incomplete');
      }
      throw activationError;
    }
  };
  return Object.freeze({
    state: active,
    async execute(controller: string, operation: string, { step }: Readonly<{
      step: Readonly<{ faultId: string }>;
    }>) {
      const key = step.faultId;
      if (operation === 'activate') {
        if (active.has(key)) throw new Error(`fault ${key} is already active`);
        let recovery: Promise<unknown> | null;
        if (['mongodb_primary_step_down', 'replica_set_election'].includes(controller)) {
          recovery = environment.replicaSet.stepDownPrimary();
        } else if (controller === 'meteor_mongo_interruption') {
          if (!environment.replicaSet.suspendAll || !environment.replicaSet.resumeAll) {
            throw new Error('MongoDB interruption controls are unavailable');
          }
          environment.replicaSet.suspendAll();
          const resumeAll = environment.replicaSet.resumeAll;
          recovery = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => resumeAll().then(resolve, reject), AUTO_RESTORE_MS);
            timer.unref?.();
          });
        } else if (controller === 'ddp_client_disconnect') {
          const selected = clients.clients;
          selected.forEach((client) => client.terminate?.());
          recovery = Promise.all(selected.map(resumeAfterDisconnect));
        } else {
          await activateInternal(controller, key);
          recovery = null;
        }
        const tracked: TrackedFault['recovery'] = recovery ? Promise.resolve(recovery).then(
          () => ({ restored: true }),
          (error) => ({ restored: false, error }),
        ) : null;
        active.set(key, { controller, recovery: tracked });
        return {
          fault_witness: digestibleWitness(controller, key, true, false),
          provenance: { fault_witness: 'fault_controller' },
        };
      }
      const fault = active.get(key);
      if (!fault || fault.controller !== controller) throw new Error(`fault ${key} has no matching activation`);
      let restored: boolean;
      if (fault.recovery) {
        const outcome = await fault.recovery;
        if (!outcome.restored) throw outcome.error;
        restored = true;
      } else {
        const witnesses = await internal(controller, 'restore', key);
        restored = witnesses.every((witness) => witness.restored === true);
        if (!restored) throw new Error(`fault ${key} restoration was not attested by every controller`);
      }
      active.delete(key);
      return {
        fault_witness: { activated: true, restored },
        faultDetails: digestibleWitness(controller, key, true, restored),
        provenance: { fault_witness: 'fault_controller', faultDetails: 'fault_controller' },
      };
    },
    async restoreAll() {
      const failures: unknown[] = [];
      for (const [faultId, fault] of [...active]) {
        try {
          if (fault.recovery) {
            const outcome = await fault.recovery;
            if (!outcome.restored) throw outcome.error;
          } else {
            const witnesses = await internal(fault.controller, 'restore', faultId);
            if (!witnesses.every((witness) => witness.restored === true)) {
              throw new Error(`fault ${faultId} restoration was not attested by every controller`);
            }
          }
          active.delete(faultId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'fault restoration was incomplete');
    },
    async waitUntilEngaged(signal: AbortSignal) {
      const gated = [...active.entries()].find(([, fault]) => (
        ['startup_snapshot_pause', 'watch_setup_pause'].includes(fault.controller)
      ));
      if (!gated) throw new Error('no pending lifecycle gate is active');
      const [faultId, fault] = gated;
      let lastStatuses: FaultStatus[] = [];
      while (!signal.aborted) {
        lastStatuses = await internal(fault.controller, 'status', faultId);
        if (lastStatuses.every((status) => status.engaged === true)) return { engaged: true };
        await delay(10);
      }
      throw new Error(`lifecycle gate did not engage on every Meteor instance: ${lastStatuses.map(({ engaged }) => engaged === true).join(',')}`);
    },
  });
}
