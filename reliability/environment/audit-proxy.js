import crypto from 'node:crypto';
import http from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

const MAX_LEDGER_ENTRIES = 100_000;
const BACKEND_HEADER = 'x-audit-backend';
const CONNECTION_HEADER = 'x-audit-connection';
const CONNECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function validateBackends(backends) {
  if (!Array.isArray(backends) || backends.length < 2 || backends.length > 8) {
    throw new TypeError('Audit proxy requires two to eight backends');
  }
  const ids = new Set();
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

function cookieValue(header, name) {
  const match = String(header || '').split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Validates a closed routing policy selected by a declarative case. */
export function validateRoutePolicy(value, backendIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Audit proxy route policy must be an object');
  }
  const allowed = value.kind === 'force_backend' ? ['kind', 'backendId'] : ['kind'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Audit proxy route policy.${key} is unknown`);
  }
  if (!['sticky', 'round_robin', 'force_backend'].includes(value.kind)) {
    throw new TypeError('Audit proxy route policy kind is unknown');
  }
  if (value.kind === 'force_backend' && !backendIds.includes(value.backendId)) {
    throw new TypeError('Audit proxy forced backend is not owned by this proxy');
  }
  return Object.freeze(structuredClone(value));
}

/**
 * Loopback-only terminating HTTP/WebSocket proxy with attributable faults.
 * Every connection and mutation is recorded in an append-only bounded ledger.
 */
export class AuditProxy {
  constructor({ auditId, backends, routePolicy = { kind: 'sticky' } }) {
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

  record(kind, fields = {}) {
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

  setRoutePolicy(policy) {
    this.routePolicy = validateRoutePolicy(policy, this.backendIds);
    this.record('route_policy_changed', { policy: this.routePolicy });
  }

  chooseBackend(request) {
    const requested = request.headers[BACKEND_HEADER]
      || cookieValue(request.headers.cookie, 'audit_backend');
    let backend;
    if (this.routePolicy.kind === 'force_backend') {
      backend = this.backends.find(({ id }) => id === this.routePolicy.backendId);
    } else if (this.routePolicy.kind === 'sticky' && requested) {
      backend = this.backends.find(({ id }) => id === requested);
    }
    if (!backend) {
      backend = this.backends[this.roundRobinIndex % this.backends.length];
      this.roundRobinIndex += 1;
    }
    return backend;
  }

  async start() {
    if (this.httpServer) throw new Error('Audit proxy is already started');
    this.webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.httpServer = http.createServer((request, response) => this.handleHttp(request, response));
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
        this.handleWebSocket(request, client);
      });
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    this.port = this.httpServer.address().port;
    this.record('proxy_started', { port: this.port });
    return this;
  }

  handleHttp(request, response) {
    const backend = this.chooseBackend(request);
    const target = new URL(request.url, backend.httpUrl);
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      const upstreamCookies = upstreamResponse.headers['set-cookie'] || [];
      response.writeHead(upstreamResponse.statusCode, {
        ...upstreamResponse.headers,
        'set-cookie': [...upstreamCookies, `audit_backend=${encodeURIComponent(backend.id)}; Path=/; HttpOnly; SameSite=Strict`],
        [BACKEND_HEADER]: backend.id,
      });
      upstreamResponse.pipe(response);
    });
    const connectionId = crypto.randomUUID();
    this.record('http_routed', { connectionId, backendId: backend.id, method: request.method });
    upstream.once('error', (error) => {
      this.record('http_error', { connectionId, backendId: backend.id, code: error.code || 'unknown' });
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  handleWebSocket(request, downstream) {
    const backend = this.chooseBackend(request);
    const requestedConnectionId = request.headers[CONNECTION_HEADER];
    const connectionId = requestedConnectionId || crypto.randomUUID();
    if (!CONNECTION_ID.test(connectionId) || this.connections.has(connectionId)) {
      this.record('websocket_rejected', { reason: 'invalid_or_duplicate_connection_id' });
      downstream.close(1008, 'invalid audit connection identity');
      return;
    }
    const target = new URL(request.url, backend.webSocketUrl);
    const upstream = new WebSocket(target, {
      headers: {
        [CONNECTION_HEADER]: connectionId,
        [BACKEND_HEADER]: backend.id,
      },
      perMessageDeflate: false,
    });
    const pendingUpstream = [];
    const connection = { connectionId, backendId: backend.id, downstream, upstream, paused: false };
    this.connections.set(connectionId, connection);
    this.record('websocket_routed', { connectionId, backendId: backend.id });

    downstream.on('message', (data, isBinary) => {
      this.record('frame_downstream_to_upstream', {
        connectionId, backendId: backend.id, byteLength: data.length, binary: isBinary,
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
        connectionId, backendId: backend.id, byteLength: data.length, binary: isBinary,
      });
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
    });
    const close = (side, code) => {
      this.record('websocket_closed', { connectionId, backendId: backend.id, side, code });
      this.connections.delete(connectionId);
      if (downstream.readyState < WebSocket.CLOSING) downstream.close();
      if (upstream.readyState < WebSocket.CLOSING) upstream.close();
    };
    downstream.once('close', (code) => close('downstream', code));
    upstream.once('close', (code) => close('upstream', code));
    downstream.once('error', (error) => this.record('websocket_error', {
      connectionId, backendId: backend.id, side: 'downstream', code: error.code || 'unknown',
    }));
    upstream.once('error', (error) => this.record('websocket_error', {
      connectionId, backendId: backend.id, side: 'upstream', code: error.code || 'unknown',
    }));
  }

  ownedConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error('Audit proxy connection is not owned or no longer active');
    return connection;
  }

  dropConnection(connectionId) {
    const connection = this.ownedConnection(connectionId);
    this.record('fault_socket_drop', { connectionId, backendId: connection.backendId });
    connection.downstream.terminate();
    connection.upstream.terminate();
  }

  setSlowConsumer(connectionId, paused) {
    const connection = this.ownedConnection(connectionId);
    const socket = connection.downstream?._socket;
    if (!socket) throw new Error('Audit proxy downstream socket is unavailable');
    if (paused) socket.pause();
    else socket.resume();
    connection.paused = paused;
    this.record(paused ? 'fault_consumer_paused' : 'fault_consumer_resumed', {
      connectionId, backendId: connection.backendId,
    });
  }

  async sendFragmented(connectionId, { direction, chunks, binary = false }) {
    const connection = this.ownedConnection(connectionId);
    if (!Array.isArray(chunks) || chunks.length < 2 || chunks.some((chunk) => !Buffer.isBuffer(chunk))) {
      throw new TypeError('Fragment fault requires at least two Buffer chunks');
    }
    const socket = direction === 'to_backend' ? connection.upstream : connection.downstream;
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Fragment target socket is not open');
    for (let index = 0; index < chunks.length; index += 1) {
      await new Promise((resolve, reject) => socket.send(chunks[index], {
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

  snapshotLedger() {
    return Object.freeze(this.ledger.map((entry) => Object.freeze({ ...entry })));
  }

  async stop() {
    if (!this.httpServer) return;
    for (const connection of this.connections.values()) {
      connection.downstream.terminate();
      connection.upstream.terminate();
    }
    this.connections.clear();
    await new Promise((resolve) => this.webSocketServer.close(resolve));
    this.httpServer.closeAllConnections?.();
    await new Promise((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve()));
    this.record('proxy_stopped');
    this.httpServer = null;
    this.webSocketServer = null;
    this.port = null;
  }
}
