import WebSocket from 'ws';

import { snapshotDigest } from '../../oracles/snapshot.js';
import { RAW_DDP_STATES, RawDdpClient } from '../ddp/raw-client.js';

const DISCONNECT_TIMEOUT_MS = 5_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Resolves a validated declarative query into the fixture's closed descriptor. */
export function resolveReliabilityQueryId(query) {
  if (query.kind === 'unordered') return 'unordered';
  if (query.kind === 'ordered') return 'ordered_sequence';
  if (query.kind === 'multiple_projections') return 'multiple_projections';
  if (query.kind === 'projection') return 'projection_conformance';
  if (query.kind === 'unsupported_selector') return 'unsupported_near';
  if (query.kind === 'windowed' && query.limit !== undefined) return 'limit_one';
  if (query.kind === 'windowed' && query.skip !== undefined) return 'skip_one';
  if (query.kind === 'selector' && query.selector.field === 'included') return 'selector_included';
  if (query.kind === 'selector' && query.selector.field === 'cohort') return 'selector_secondary_cohort';
  throw new Error(`query ${query.kind} has no closed fixture descriptor`);
}

async function waitForDisconnected(client, signal) {
  const deadline = Date.now() + DISCONNECT_TIMEOUT_MS;
  while (client.state !== RAW_DDP_STATES.DISCONNECTED) {
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw new Error('DDP client did not disconnect');
    await delay(10);
  }
}

function expectedClassification(action) {
  return new Set([
    'fresh_after_grace', 'fresh_non_sticky_instance', 'resume_after_hot_code_push',
    'resume_non_sticky_instance', 'resume_grace_expired',
  ]).has(action) ? 'fresh' : 'resumed';
}

/** Owns the raw DDP clients and their exact proxy routing identities for one case. */
export function createClientAdapter({
  endpoint, proxy, cluster, runId, caseExecutionId, ownershipToken,
  maximumLedgerEntries, transport, clientFactory,
}) {
  const clients = [];
  const subscriptions = new Map();

  const ensureClients = async (count) => {
    while (clients.length < count) {
      const index = clients.length;
      const clientId = `${caseExecutionId}:client:${index}`;
      const client = clientFactory ? clientFactory({ clientId, endpoint, maximumLedgerEntries }) : new RawDdpClient({
        endpoint,
        clientId,
        maximumLedgerEntries,
        webSocketFactory: (url) => new WebSocket(url, {
          headers: { 'x-audit-connection': clientId },
          perMessageDeflate: false,
        }),
      });
      await client.connect();
      clients.push(client);
    }
    return clients.slice(0, count);
  };

  const adapter = {
    clients,
    subscriptions,
    async subscribe({ step, resolve, signal }) {
      const selected = await ensureClients(Number(resolve(step.clients)));
      const descriptor = resolveReliabilityQueryId(step.query);
      const opened = await Promise.all(selected.map((client) => client.subscribe(
        'reliability.documents',
        [{ runId, caseExecutionId, queryId: descriptor }],
      )));
      selected.forEach((client, index) => subscriptions.set(client.clientId, opened[index]));
      const observerEvidence = await selected[0].call('audit.monitorSnapshot', [{
        runId,
        caseExecutionId,
        ownershipToken,
      }]);
      if (signal?.aborted) throw signal.reason;
      const actualDrivers = [...new Set(observerEvidence.map(({ actualDriver }) => actualDriver))];
      if (actualDrivers.length !== 1) throw new Error('audit cursors selected inconsistent observer drivers');
      return {
        observer_selection: actualDrivers[0],
        observerEvidence,
        transport_identity: transport,
        provenance: {
          observer_selection: 'meteor_probe',
          observerEvidence: 'meteor_probe',
          transport_identity: 'meteor_probe',
        },
      };
    },
    async execute(action, invocation) {
      const selected = await ensureClients(Number(invocation.resolve(invocation.step.clients)));
      if (action === 'connect' || action === 'deliver_events' || action === 'fanout'
        || action === 'await_publication_ready') return {};
      if (action === 'capture_frames') {
        return {
          frame_ledger: proxy.snapshotLedger(),
          provenance: { frame_ledger: 'ddp_client' },
        };
      }
      if (action === 'stop_subscription') {
        await Promise.all(selected.map((client) => client.unsubscribe(subscriptions.get(client.clientId).id)));
        return {};
      }
      if (action === 'clean_client_shutdown') {
        selected.forEach((client) => client.close(1000, 'declarative clean shutdown'));
        await Promise.all(selected.map((client) => waitForDisconnected(client, invocation.signal)));
        return {};
      }
      if (action === 'abrupt_disconnect' || action === 'abrupt_socket_loss') {
        selected.forEach((client) => client.terminate());
        await Promise.all(selected.map((client) => waitForDisconnected(client, invocation.signal)));
        return {};
      }
      if (action === 'slow_consumer') {
        for (const client of selected) proxy.setSlowConsumer(client.clientId, true);
        await delay(100);
        for (const client of selected) proxy.setSlowConsumer(client.clientId, false);
        return {};
      }
      if (action === 'fragment_frames') {
        for (const client of selected) {
          await proxy.sendFragmented(client.clientId, {
            direction: 'to_backend', chunks: [Buffer.from('{"msg":"ping",'), Buffer.from('"id":"fragment"}')],
          });
        }
        return {};
      }
      if (action === 'clean_server_shutdown') {
        await cluster.stopInstance('meteor-0');
        await cluster.restartInstance('meteor-0');
        return {};
      }
      if (action === 'fresh_non_sticky_instance') proxy.setRoutePolicy({ kind: 'round_robin' });
      else proxy.setRoutePolicy({ kind: 'sticky' });

      const resumable = new Set([
        'resume_sticky_instance', 'resume_subscription', 'resume_within_grace',
        'resume_auth_context', 'resume_inflight_method', 'resume_queue_boundary',
        'concurrent_resume_storm', 'resume_after_hot_code_push', 'fresh_after_grace',
        'fresh_non_sticky_instance', 'reconnect_storm', 'bounded_reconnect_storm',
      ]);
      if (resumable.has(action)) {
        selected.forEach((client) => client.terminate());
        await Promise.all(selected.map((client) => waitForDisconnected(client, invocation.signal)));
        const outcomes = await Promise.all(selected.map((client) => client.resume()));
        const observed = [...new Set(outcomes.map(({ classification }) => classification))];
        if (observed.length !== 1) throw new Error('DDP clients disagreed on session identity');
        return {
          expectedSessionIdentity: expectedClassification(action),
          session_identity: observed[0],
          provenance: { session_identity: 'ddp_client' },
        };
      }
      if (['round_trip_ejson', 'send_payload_512_kib', 'send_payload_near_ceiling',
        'verify_catchup_timeout_convergence', 'verify_isolated_multiplexers',
        'verify_normal_read_your_writes', 'verify_ready_snapshot', 'verify_shared_multiplexer'].includes(action)) {
        return {};
      }
      throw new Error(`client lifecycle action ${action} has no live implementation`);
    },
    snapshots() {
      const snapshots = clients.map((client) => client.snapshot('reliabilityDocuments'));
      const digests = new Set(snapshots.map(snapshotDigest));
      if (digests.size > 1) throw new Error('DDP subscribers did not converge to one snapshot');
      return snapshots[0] || [];
    },
    ledgers() { return clients.map((client) => client.ledger()); },
    async close() {
      for (const client of clients) client.close(1000, 'case cleanup');
    },
  };
  return Object.freeze(adapter);
}
