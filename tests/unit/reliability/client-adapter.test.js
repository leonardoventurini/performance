import assert from 'node:assert/strict';
import test from 'node:test';

import { createClientAdapter, resolveReliabilityQueryId } from '../../../reliability/runtime/adapters/clients.js';
import { RAW_DDP_STATES } from '../../../reliability/runtime/ddp/raw-client.js';

test('every declarative query shape maps to one closed fixture descriptor', () => {
  assert.equal(resolveReliabilityQueryId({ kind: 'unordered' }), 'unordered');
  assert.throws(
    () => resolveReliabilityQueryId({ kind: 'ordered' }),
    /dedicated server-side observe primitive/u,
  );
  assert.equal(resolveReliabilityQueryId({ kind: 'projection' }), 'projection_conformance');
  assert.equal(resolveReliabilityQueryId({ kind: 'multiple_projections' }), 'multiple_projections');
  assert.equal(resolveReliabilityQueryId({ kind: 'windowed', limit: 1 }), 'limit_one');
  assert.throws(
    () => resolveReliabilityQueryId({ kind: 'windowed', skip: 1 }),
    /query-scoped expected-model primitive/u,
  );
  assert.equal(resolveReliabilityQueryId({
    kind: 'selector', selector: { field: 'included' },
  }), 'selector_included');
  assert.equal(resolveReliabilityQueryId({
    kind: 'selector', selector: { field: 'cohort' },
  }), 'selector_secondary_cohort');
  assert.equal(resolveReliabilityQueryId({ kind: 'unsupported_selector' }), 'unsupported_json_schema');
  assert.equal(resolveReliabilityQueryId({ kind: 'change_stream_unavailable' }), 'change_stream_unavailable');
  assert.throws(() => resolveReliabilityQueryId({ kind: 'arbitrary' }), /no closed fixture descriptor/u);
});

function harness({ backendIds, resumeClassification = 'resumed' }) {
  const clients = [];
  const stopped = [];
  const restarted = [];
  const adapter = createClientAdapter({
    endpoint: 'ws://127.0.0.1:3000/websocket',
    proxy: {
      backendIdForConnection(clientId) {
        return backendIds[Number(clientId.split(':').at(-1))];
      },
      setRoutePolicy() {},
    },
    cluster: {
      backends: [...new Set(backendIds)].map((id) => ({ id })),
      async stopInstance(backendId) {
        stopped.push(backendId);
        clients.forEach((client, index) => {
          if (backendIds[index] === backendId) client.state = RAW_DDP_STATES.DISCONNECTED;
        });
      },
      async restartInstance(backendId) { restarted.push(backendId); },
    },
    runId: 'run-1',
    caseExecutionId: 'case-1',
    ownershipToken: 'owned-token',
    maximumLedgerEntries: 100,
    transport: 'sockjs',
    clientFactory({ clientId }) {
      const client = {
        clientId,
        state: RAW_DDP_STATES.DISCONNECTED,
        async connect() { this.state = RAW_DDP_STATES.CONNECTED; },
        async resume() {
          this.state = RAW_DDP_STATES.CONNECTED;
          return { classification: resumeClassification };
        },
      };
      clients.push(client);
      return client;
    },
  });
  return { adapter, stopped, restarted };
}

function invocation(clientCount) {
  return {
    step: { clients: { kind: 'literal', value: clientCount } },
    resolve: () => clientCount,
    signal: new AbortController().signal,
  };
}

test('clean server shutdown targets every subscriber backend and emits a recovery witness', async () => {
  const { adapter, stopped, restarted } = harness({ backendIds: ['meteor-1', 'meteor-0', 'meteor-1'] });
  const result = await adapter.execute('clean_server_shutdown', invocation(3));

  assert.deepEqual(stopped, ['meteor-1', 'meteor-0']);
  assert.deepEqual(restarted, ['meteor-1', 'meteor-0']);
  assert.equal(result.shutdown_recovered, true);
  assert.deepEqual(result.shutdown_witness.targetedBackends, ['meteor-1', 'meteor-0']);
  assert.equal(result.provenance.shutdown_recovered, 'ddp_client');
});

test('auth-context resume fails closed until an authenticated DDP fixture exists', async () => {
  const { adapter } = harness({ backendIds: ['meteor-0'] });
  await assert.rejects(
    adapter.execute('resume_auth_context', invocation(1)),
    /requires an authenticated DDP fixture/u,
  );
});
