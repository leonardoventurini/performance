const AUTO_RESTORE_MS = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resumeAfterDisconnect(client) {
  const deadline = Date.now() + 5_000;
  while (client.state !== 'disconnected') {
    if (Date.now() >= deadline) throw new Error('faulted DDP client did not disconnect');
    await delay(10);
  }
  return client.resume();
}

function digestibleWitness(controller, faultId, activated, restored) {
  return Object.freeze({ controller, faultId, activated, restored });
}

/** Controls only resources owned by the current audit environment. */
export function createFaultAdapter({ environment, clients, runId, caseExecutionId, ownershipToken }) {
  const active = new Map();
  const controlClient = () => {
    const client = clients.clients[0];
    if (!client) throw new Error('fault control requires an authenticated owned DDP client');
    return client;
  };
  const internal = async (controller, operation, faultId) => controlClient().call(
    'audit.faultControl',
    [{ runId, caseExecutionId, ownershipToken, controller, operation, faultId }],
  );
  return Object.freeze({
    state: active,
    async execute(controller, operation, { step }) {
      const key = step.faultId;
      if (operation === 'activate') {
        if (active.has(key)) throw new Error(`fault ${key} is already active`);
        let recovery;
        if (['mongodb_primary_step_down', 'replica_set_election'].includes(controller)) {
          recovery = environment.replicaSet.stepDownPrimary();
        } else if (controller === 'meteor_mongo_interruption') {
          environment.replicaSet.suspendAll();
          recovery = new Promise((resolve, reject) => {
            const timer = setTimeout(() => environment.replicaSet.resumeAll().then(resolve, reject), AUTO_RESTORE_MS);
            timer.unref?.();
          });
        } else if (controller === 'ddp_client_disconnect') {
          const selected = clients.clients;
          selected.forEach((client) => client.terminate());
          recovery = Promise.all(selected.map(resumeAfterDisconnect));
        } else {
          await internal(controller, 'activate', key);
          recovery = null;
        }
        const tracked = recovery ? Promise.resolve(recovery).then(
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
      let restored;
      if (fault.recovery) {
        const outcome = await fault.recovery;
        if (!outcome.restored) throw outcome.error;
        restored = true;
      } else {
        const witness = await internal(controller, 'restore', key);
        restored = witness.restored === true;
      }
      active.delete(key);
      return {
        fault_witness: { activated: true, restored },
        faultDetails: digestibleWitness(controller, key, true, restored),
        provenance: { fault_witness: 'fault_controller', faultDetails: 'fault_controller' },
      };
    },
    async restoreAll() {
      const failures = [];
      for (const [faultId, fault] of [...active]) {
        try {
          if (fault.recovery) {
            const outcome = await fault.recovery;
            if (!outcome.restored) throw outcome.error;
          } else {
            await internal(fault.controller, 'restore', faultId);
          }
          active.delete(faultId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'fault restoration was incomplete');
    },
  });
}
