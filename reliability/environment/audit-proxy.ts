import crypto from 'node:crypto';
import http from 'node:http';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

const MAX_LEDGER_ENTRIES = 100_000;
const BACKEND_HEADER = 'x-audit-backend';
const CONNECTION_HEADER = 'x-audit-connection';
const CONNECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

/** Declarative loopback backend accepted by the audit proxy. */
export interface AuditProxyBackendInput {
  readonly id: string;
  readonly httpUrl: string;
  readonly webSocketUrl: string;
}

interface AuditProxyBackend {
  readonly id: string;
  readonly httpUrl: URL;
  readonly webSocketUrl: URL;
}

/** Closed routing strategies available to declarative audit cases. */
export type AuditRoutePolicy =
  | Readonly<{ kind: 'sticky' }>
  | Readonly<{ kind: 'round_robin' }>
  | Readonly<{ kind: 'force_backend'; backendId: string }>;

/** Construction contract for an owned audit proxy. */
export interface AuditProxyOptions {
  readonly auditId: string;
  readonly backends: readonly AuditProxyBackendInput[];
  readonly routePolicy?: AuditRoutePolicy;
}

/** Attributable monotonic evidence emitted by proxy operations and faults. */
export interface AuditProxyLedgerEntry extends Readonly<Record<string, unknown>> {
  readonly sequence: number;
  readonly monotonicNs: string;
  readonly kind: string;
}

interface ProxyConnection {
  readonly connectionId: string;
  readonly backendId: string;
  readonly downstream: WebSocket;
  readonly upstream: WebSocket;
  paused: boolean;
}

interface PendingFrame {
  readonly data: RawData;
  readonly isBinary: boolean;
}

interface FragmentOptions {
  readonly direction: 'to_backend' | 'to_client';
  readonly chunks: readonly Buffer[];
  readonly binary?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}

function rawDataLength(data: RawData): number {
  return Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.length, 0) : data.byteLength;
}

function validateBackends(backends: readonly AuditProxyBackendInput[]): readonly AuditProxyBackend[] {
  if (!Array.isArray(backends) || backends.length < 2 || backends.length > 8) {
    throw new TypeError('Audit proxy requires two to eight backends');
  }
  const ids = new Set<string>();
  return backends.map((backend, index) => {
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
      throw new TypeError(`Audit proxy backend ${index} must be an object`);
    }
    for (const key of Object.keys(backend)) {
      if (!['id', 'httpUrl', 'webSocketUrl'].includes(key)) {
        throw new TypeError(`Audit proxy backend ${index}.${key} is unknown`);
      }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(backend.id) || ids.has(backend.id)) {
      throw new TypeError(`Audit proxy backend ${index}.id is invalid or duplicated`);
    }
    ids.add(backend.id);
    const httpUrl = new URL(backend.httpUrl);
    const webSocketUrl = new URL(backend.webSocketUrl);
    if (httpUrl.protocol !== 'http:' || webSocketUrl.protocol !== 'ws:') {
      throw new TypeError('Audit proxy backends must use local http/ws URLs');
    }
    if (!['127.0.0.1', 'localhost'].includes(httpUrl.hostname)
      || !['127.0.0.1', 'localhost'].includes(webSocketUrl.hostname)) {
      throw new TypeError('Audit proxy backends must be loopback-only');
    }
    return Object.freeze({ id: backend.id, httpUrl, webSocketUrl });
  });
}

function cookieValue(header: string | undefined, name: string): string | null {
  const match = String(header || '').split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Validates a closed routing policy selected by a declarative case. */
export function validateRoutePolicy(value: unknown, backendIds: readonly string[]): AuditRoutePolicy {
  if (!isRecord(value)) {
    throw new TypeError('Audit proxy route policy must be an object');
  }
  const allowed = value.kind === 'force_backend' ? ['kind', 'backendId'] : ['kind'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Audit proxy route policy.${key} is unknown`);
  }
  if (value.kind !== 'sticky' && value.kind !== 'round_robin' && value.kind !== 'force_backend') {
    throw new TypeError('Audit proxy route policy kind is unknown');
  }
  if (value.kind === 'force_backend') {
    if (typeof value.backendId !== 'string' || !backendIds.includes(value.backendId)) {
      throw new TypeError('Audit proxy forced backend is not owned by this proxy');
    }
    return Object.freeze({ kind: value.kind, backendId: value.backendId });
  }
  return Object.freeze({ kind: value.kind });
}

/**
 * Loopback-only terminating HTTP/WebSocket proxy with attributable faults.
 * Every connection and mutation is recorded in an append-only bounded ledger.
 */
export class AuditProxy {
  readonly auditId: string;
  readonly backends: readonly AuditProxyBackend[];
  readonly backendIds: readonly string[];
  routePolicy: AuditRoutePolicy;
  readonly token: string;
  sequence: number;
  roundRobinIndex: number;
  readonly ledger: AuditProxyLedgerEntry[];
  readonly connections: Map<string, ProxyConnection>;
  httpServer: http.Server | null;
  webSocketServer: WebSocketServer | null;
  port: number | null;

  constructor({ auditId, backends, routePolicy = { kind: 'sticky' } }: AuditProxyOptions) {
    if (typeof auditId !== 'string' || auditId.length === 0) throw new TypeError('auditId is required');
    this.auditId = auditId;
    this.backends = validateBackends(backends);
    this.backendIds = this.backends.map(({ id }) => id);
    this.routePolicy = validateRoutePolicy(routePolicy, this.backendIds);
    this.token = crypto.randomBytes(32).toString('hex');
    this.sequence = 0;
    this.roundRobinIndex = 0;
    this.ledger = [];
    this.connections = new Map();
    this.httpServer = null;
    this.webSocketServer = null;
    this.port = null;
  }

  record(kind: string, fields: Readonly<Record<string, unknown>> = {}): AuditProxyLedgerEntry {
    if (this.ledger.length >= MAX_LEDGER_ENTRIES) {
      throw new Error('Audit proxy evidence ledger overflow');
    }
    const entry = Object.freeze({
      sequence: ++this.sequence,
      monotonicNs: process.hrtime.bigint().toString(),
      kind,
      ...fields,
    });
    this.ledger.push(entry);
    return entry;
  }

  setRoutePolicy(policy: AuditRoutePolicy): void {
    this.routePolicy = validateRoutePolicy(policy, this.backendIds);
    this.record('route_policy_changed', { policy: this.routePolicy });
  }

  chooseBackend(request: http.IncomingMessage): AuditProxyBackend {
    const requestedHeader = request.headers[BACKEND_HEADER];
    const requested = (Array.isArray(requestedHeader) ? requestedHeader[0] : requestedHeader)
      || cookieValue(request.headers.cookie, 'audit_backend');
    let backend: AuditProxyBackend | undefined;
    const policy = this.routePolicy;
    if (policy.kind === 'force_backend') {
      backend = this.backends.find(({ id }) => id === policy.backendId);
    } else if (this.routePolicy.kind === 'sticky' && requested) {
      backend = this.backends.find(({ id }) => id === requested);
    }
    if (!backend) {
      backend = this.backends[this.roundRobinIndex % this.backends.length];
      this.roundRobinIndex += 1;
    }
    if (!backend) throw new Error('Audit proxy has no configured backend');
    return backend;
  }

  async start(): Promise<this> {
    if (this.httpServer) throw new Error('Audit proxy is already started');
    this.webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.httpServer = http.createServer((request, response) => this.handleHttp(request, response));
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.webSocketServer?.handleUpgrade(request, socket, head, (client) => {
        this.handleWebSocket(request, client);
      });
    });
    const server = this.httpServer;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Audit proxy did not bind a TCP port');
    this.port = address.port;
    this.record('proxy_started', { port: this.port });
    return this;
  }

  handleHttp(request: http.IncomingMessage, response: http.ServerResponse): void {
    const backend = this.chooseBackend(request);
    const target = new URL(request.url ?? '/', backend.httpUrl);
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      const upstreamCookies = upstreamResponse.headers['set-cookie'] || [];
      response.writeHead(upstreamResponse.statusCode ?? 502, {
        ...upstreamResponse.headers,
        'set-cookie': [...upstreamCookies, `audit_backend=${encodeURIComponent(backend.id)}; Path=/; HttpOnly; SameSite=Strict`],
        [BACKEND_HEADER]: backend.id,
      });
      upstreamResponse.pipe(response);
    });
    const connectionId = crypto.randomUUID();
    this.record('http_routed', { connectionId, backendId: backend.id, method: request.method });
    upstream.once('error', (error) => {
      this.record('http_error', { connectionId, backendId: backend.id, code: errorCode(error) });
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  handleWebSocket(request: http.IncomingMessage, downstream: WebSocket): void {
    const backend = this.chooseBackend(request);
    const requestedConnectionId = request.headers[CONNECTION_HEADER];
    const connectionId = (Array.isArray(requestedConnectionId) ? requestedConnectionId[0] : requestedConnectionId)
      ?? crypto.randomUUID();
    if (!CONNECTION_ID.test(connectionId) || this.connections.has(connectionId)) {
      this.record('websocket_rejected', { reason: 'invalid_or_duplicate_connection_id' });
      downstream.close(1008, 'invalid audit connection identity');
      return;
    }
    const target = new URL(request.url ?? '/', backend.webSocketUrl);
    const upstream = new WebSocket(target, {
      headers: {
        [CONNECTION_HEADER]: connectionId,
        [BACKEND_HEADER]: backend.id,
      },
      perMessageDeflate: false,
    });
    const pendingUpstream: PendingFrame[] = [];
    const connection = { connectionId, backendId: backend.id, downstream, upstream, paused: false };
    this.connections.set(connectionId, connection);
    this.record('websocket_routed', { connectionId, backendId: backend.id });

    downstream.on('message', (data, isBinary) => {
      this.record('frame_downstream_to_upstream', {
        connectionId, backendId: backend.id, byteLength: rawDataLength(data), binary: isBinary,
      });
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pendingUpstream.push({ data, isBinary });
    });
    upstream.once('open', () => {
      for (const { data, isBinary } of pendingUpstream.splice(0)) {
        upstream.send(data, { binary: isBinary });
      }
      this.record('websocket_backend_connected', { connectionId, backendId: backend.id });
    });
    upstream.on('message', (data, isBinary) => {
      this.record('frame_upstream_to_downstream', {
        connectionId, backendId: backend.id, byteLength: rawDataLength(data), binary: isBinary,
      });
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
    });
    const close = (side: 'downstream' | 'upstream', code: number): void => {
      this.record('websocket_closed', { connectionId, backendId: backend.id, side, code });
      this.connections.delete(connectionId);
      if (downstream.readyState < WebSocket.CLOSING) downstream.close();
      if (upstream.readyState < WebSocket.CLOSING) upstream.close();
    };
    downstream.once('close', (code) => close('downstream', code));
    upstream.once('close', (code) => close('upstream', code));
    downstream.once('error', (error) => this.record('websocket_error', {
      connectionId, backendId: backend.id, side: 'downstream', code: errorCode(error),
    }));
    upstream.once('error', (error) => this.record('websocket_error', {
      connectionId, backendId: backend.id, side: 'upstream', code: errorCode(error),
    }));
  }

  ownedConnection(connectionId: string): ProxyConnection {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error('Audit proxy connection is not owned or no longer active');
    return connection;
  }

  /** Returns the owned backend currently carrying one exact audit connection. */
  backendIdForConnection(connectionId: string): string {
    return this.ownedConnection(connectionId).backendId;
  }

  dropConnection(connectionId: string): void {
    const connection = this.ownedConnection(connectionId);
    this.record('fault_socket_drop', { connectionId, backendId: connection.backendId });
    connection.downstream.terminate();
    connection.upstream.terminate();
  }

  setSlowConsumer(connectionId: string, paused: boolean): void {
    const connection = this.ownedConnection(connectionId);
    if (paused) connection.downstream.pause();
    else connection.downstream.resume();
    connection.paused = paused;
    this.record(paused ? 'fault_consumer_paused' : 'fault_consumer_resumed', {
      connectionId, backendId: connection.backendId,
    });
  }

  async sendFragmented(connectionId: string, { direction, chunks, binary = false }: FragmentOptions): Promise<void> {
    const connection = this.ownedConnection(connectionId);
    if (!Array.isArray(chunks) || chunks.length < 2 || chunks.some((chunk) => !Buffer.isBuffer(chunk))) {
      throw new TypeError('Fragment fault requires at least two Buffer chunks');
    }
    const socket = direction === 'to_backend' ? connection.upstream : connection.downstream;
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Fragment target socket is not open');
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) throw new Error('Fragment chunk disappeared during send');
      await new Promise<void>((resolve, reject) => socket.send(chunk, {
        binary,
        fin: index === chunks.length - 1,
      }, (error) => error ? reject(error) : resolve()));
    }
    this.record('fault_fragmented_message', {
      connectionId,
      backendId: connection.backendId,
      direction,
      fragments: chunks.length,
      byteLength: chunks.reduce((total, chunk) => total + chunk.length, 0),
    });
  }

  snapshotLedger(): readonly AuditProxyLedgerEntry[] {
    return Object.freeze(this.ledger.map((entry) => Object.freeze({ ...entry })));
  }

  async stop(): Promise<Readonly<{ networkRestored: boolean }>> {
    if (!this.httpServer) return Object.freeze({ networkRestored: true });
    for (const connection of this.connections.values()) {
      connection.downstream.terminate();
      connection.upstream.terminate();
    }
    this.connections.clear();
    const webSocketServer = this.webSocketServer;
    const httpServer = this.httpServer;
    await new Promise<void>((resolve) => webSocketServer?.close(() => resolve()));
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    this.record('proxy_stopped');
    this.httpServer = null;
    this.webSocketServer = null;
    this.port = null;
    return Object.freeze({
      networkRestored: this.connections.size === 0
        && this.httpServer === null
        && this.webSocketServer === null
        && this.port === null,
    });
  }
}
