import WebSocket from 'ws';

import { snapshotDigest } from '../../oracles/snapshot.js';
import { RAW_DDP_STATES, RawDdpClient } from '../ddp/raw-client.js';

const DISCONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_STORM_CYCLES = 3;
const PAYLOAD_512_KIB = 512 * 1024;
const PAYLOAD_NEAR_CEILING = 15 * 1024 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Resolves a validated declarative query into the fixture's closed descriptor. */
export function resolveReliabilityQueryId(query) {
  if (query.kind === 'unordered') return 'unordered';
  if (query.kind === 'ordered') {
    throw new Error('ordered observer evidence requires a dedicated server-side observe primitive');
  }
  if (query.kind === 'multiple_projections') return 'multiple_projections';
  if (query.kind === 'projection') return 'projection_conformance';
  if (query.kind === 'unsupported_selector') return 'unsupported_json_schema';
  if (query.kind === 'change_stream_unavailable') return 'change_stream_unavailable';
  if (query.kind === 'windowed' && query.limit !== undefined) return 'limit_one';
  if (query.kind === 'windowed' && query.skip !== undefined) {
    throw new Error('skip fallback evidence requires a query-scoped expected-model primitive');
  }
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
  const faultControlClients = [];
  const subscriptions = new Map();
  const postconditions = [];

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
    async faultControlClients() {
      if (faultControlClients.length > 0) return faultControlClients;
      for (const backend of cluster.backends) {
        const clientId = `${caseExecutionId}:control:${backend.id}`;
        const client = new RawDdpClient({
          endpoint,
          clientId,
          maximumLedgerEntries,
          webSocketFactory: (url) => new WebSocket(url, {
            headers: {
              'x-audit-connection': clientId,
              'x-audit-backend': backend.id,
            },
            perMessageDeflate: false,
          }),
        });
        await client.connect();
        faultControlClients.push(client);
      }
      return faultControlClients;
    },
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
      const fallbackEvidence = observerEvidence.filter(({ fallbackFrom, fallbackReason }) => (
        typeof fallbackFrom === 'string' && typeof fallbackReason === 'string' && fallbackReason.length > 0
      ));
      const fallbackSources = [...new Set(fallbackEvidence.map(({ fallbackFrom }) => fallbackFrom))];
      const fallbackSelection = fallbackEvidence.length === observerEvidence.length
        && fallbackSources.length === 1
        ? {
          kind: 'fallback',
          from: fallbackSources[0],
          to: actualDrivers[0],
          reasonRequired: true,
        }
        : null;
      return {
        observer_selection: actualDrivers[0],
        observerEvidence,
        ...(fallbackSelection ? { fallback_selection: fallbackSelection } : {}),
        transport_identity: transport,
        provenance: {
          observer_selection: 'meteor_probe',
          observerEvidence: 'meteor_probe',
          ...(fallbackSelection ? { fallback_selection: 'meteor_probe' } : {}),
          transport_identity: 'meteor_probe',
        },
      };
    },
    async execute(action, invocation) {
      const selected = await ensureClients(Number(invocation.resolve(invocation.step.clients)));
      if (action === 'connect') {
        if (selected.some(({ state }) => state !== RAW_DDP_STATES.CONNECTED)) throw new Error('not every DDP client negotiated a connection');
        return { connectedClients: selected.length };
      }
      if (action === 'deliver_events') {
        postconditions.push({ kind: 'deliver_events', clients: selected });
        return { armedAtEntries: selected.map((client) => client.ledger().length) };
      }
      if (action === 'fanout') {
        postconditions.push({ kind: 'fanout', clients: selected });
        return { armedSubscribers: selected.length };
      }
      if (action === 'await_publication_ready') {
        if (selected.some((client) => !subscriptions.has(client.clientId))) throw new Error('publication readiness lacks an active subscription');
        return { readySubscriptions: selected.length };
      }
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
        const targetedBackends = [...new Set(selected.map((client) => (
          proxy.backendIdForConnection(client.clientId)
        )))];
        const stoppedBackends = [];
        try {
          for (const backendId of targetedBackends) {
            await cluster.stopInstance(backendId);
            stoppedBackends.push(backendId);
          }
          await Promise.all(selected.map((client) => waitForDisconnected(client, invocation.signal)));
        } finally {
          const restarts = await Promise.allSettled(stoppedBackends.map((backendId) => (
            cluster.restartInstance(backendId)
          )));
          const restartFailures = restarts
            .filter(({ status }) => status === 'rejected')
            .map(({ reason }) => reason);
          if (restartFailures.length > 0) {
            throw new AggregateError(restartFailures, 'clean server shutdown could not restore every targeted backend');
          }
        }
        const outcomes = await Promise.all(selected.map((client) => client.resume()));
        await Promise.all(selected.map(async (client, index) => {
          if (outcomes[index].classification !== 'fresh') return;
          const prior = subscriptions.get(client.clientId);
          if (!prior) throw new Error('clean server shutdown lost subscription ownership');
          const reopened = await client.subscribe(prior.name, prior.params);
          subscriptions.set(client.clientId, reopened);
        }));
        return {
          shutdown_recovered: targetedBackends.length > 0
            && targetedBackends.every((backendId) => stoppedBackends.includes(backendId))
            && outcomes.every(({ classification }) => ['fresh', 'resumed'].includes(classification)),
          shutdown_witness: { targetedBackends, stoppedBackends, reconnections: outcomes },
          provenance: { shutdown_recovered: 'ddp_client', shutdown_witness: 'ddp_client' },
        };
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
        if (['resume_inflight_method', 'resume_queue_boundary', 'resume_after_hot_code_push', 'fresh_after_grace'].includes(action)) {
          throw new Error(`client lifecycle action ${action} requires a dedicated runtime controller`);
        }
        if (action === 'resume_auth_context') {
          throw new Error('client lifecycle action resume_auth_context requires an authenticated DDP fixture');
        }
        const cycles = ['concurrent_resume_storm', 'reconnect_storm', 'bounded_reconnect_storm'].includes(action)
          ? RECONNECT_STORM_CYCLES : 1;
        let outcomes = [];
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          selected.forEach((client) => client.terminate());
          await Promise.all(selected.map((client) => waitForDisconnected(client, invocation.signal)));
          outcomes = await Promise.all(selected.map((client) => client.resume()));
        }
        const observed = [...new Set(outcomes.map(({ classification }) => classification))];
        if (observed.length !== 1) throw new Error('DDP clients disagreed on session identity');
        return {
          expectedSessionIdentity: expectedClassification(action),
          session_identity: observed[0],
          provenance: { session_identity: 'ddp_client' },
        };
      }
      if (['round_trip_ejson', 'send_payload_512_kib', 'send_payload_near_ceiling'].includes(action)) {
        const payload = action === 'round_trip_ejson'
          ? { date: new Date('2026-01-01T00:00:00.000Z'), nested: { emoji: '🚀' }, values: [null, true, 1.5] }
          : 'x'.repeat(action === 'send_payload_512_kib' ? PAYLOAD_512_KIB : PAYLOAD_NEAR_CEILING);
        const responses = await Promise.all(selected.map((client) => client.call('audit.echo', [{
          runId, ownershipToken, payload,
        }])));
        if (responses.some((response) => JSON.stringify(response.payload) !== JSON.stringify(payload))) {
          throw new Error('DDP EJSON echo changed the payload');
        }
        return { echoedBytes: responses.map(({ byteLength }) => byteLength) };
      }
      if (['verify_catchup_timeout_convergence', 'verify_normal_read_your_writes'].includes(action)) {
        postconditions.push({ kind: 'convergence', clients: selected });
        return { armedClients: selected.length };
      }
      if (['verify_isolated_multiplexers', 'verify_shared_multiplexer'].includes(action)) {
        const observations = invocation.state.outputs.get('subscribe')?.observerEvidence || [];
        const identitiesByInstance = Map.groupBy(observations, ({ instanceId }) => instanceId);
        const valid = [...identitiesByInstance.values()].every((entries) => {
          const identities = new Set(entries.map(({ multiplexerIdentity }) => multiplexerIdentity));
          return action === 'verify_shared_multiplexer' ? identities.size === 1 : identities.size === entries.length;
        });
        if (!valid || identitiesByInstance.size === 0) throw new Error('observer multiplexer identity did not satisfy the declared relationship');
        return { verifiedInstances: identitiesByInstance.size };
      }
      if (action === 'verify_ready_snapshot') {
        if (snapshotDigest(adapter.snapshots()) !== snapshotDigest([])) throw new Error('ready snapshot was not the exact initial state');
        return { readySnapshot: true };
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
    verifyPostconditions() {
      for (const condition of postconditions) {
        if (condition.kind === 'convergence') {
          adapter.snapshots();
          continue;
        }
        const delivered = condition.clients.map((client) => client.ledger().some(({ direction, message }) => (
          direction === 'in' && ['added', 'changed', 'removed'].includes(message.msg)
        )));
        if (condition.kind === 'deliver_events' && !delivered.some(Boolean)) throw new Error('no DDP collection event was delivered');
        if (condition.kind === 'fanout' && !delivered.every(Boolean)) throw new Error('DDP event did not fan out to every declared subscriber');
      }
      return { verified: postconditions.length };
    },
    async close() {
      const allClients = [...clients, ...faultControlClients];
      for (const client of allClients) client.close(1000, 'case cleanup');
      await Promise.all(allClients.map((client) => waitForDisconnected(client)));
    },
  };
  return Object.freeze(adapter);
}
