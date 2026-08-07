import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import test from 'node:test';

import WebSocket, { WebSocketServer } from 'ws';

import {
  AuditProxy,
  validateRoutePolicy,
} from '../../../reliability/environment/audit-proxy.js';

interface TestBackend {
  readonly id: string;
  readonly httpUrl: string;
  readonly webSocketUrl: string;
  stop(): Promise<void>;
}

interface HttpResult { readonly response: http.IncomingMessage; readonly body: string }

async function backend(id: string, { cookies = [] }: Readonly<{ cookies?: readonly string[] }> = {}): Promise<TestBackend> {
  const server = http.createServer((_request, response) => {
    if (cookies.length > 0) response.setHeader('set-cookie', cookies);
    response.end(id);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, (ws) => {
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  }));
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test backend did not bind TCP');
  const port = address.port;
  return {
    id,
    httpUrl: `http://127.0.0.1:${port}`,
    webSocketUrl: `ws://127.0.0.1:${port}`,
    stop: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function proxyBackend(value: TestBackend) {
  return { id: value.id, httpUrl: value.httpUrl, webSocketUrl: value.webSocketUrl };
}

function request(port: number | null, headers: IncomingHttpHeaders = {}): Promise<HttpResult> {
  if (port === null) throw new Error('proxy is not listening');
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ response, body: Buffer.concat(chunks).toString() }));
    }).once('error', reject);
  });
}

test('route policy is closed and forced targets must be owned', () => {
  assert.deepEqual(validateRoutePolicy({ kind: 'force_backend', backendId: 'one' }, ['one', 'two']), {
    kind: 'force_backend', backendId: 'one',
  });
  assert.throws(() => validateRoutePolicy({ kind: 'force_backend', backendId: 'foreign' }, ['one']), /not owned/u);
  assert.throws(() => validateRoutePolicy({ kind: 'sticky', command: 'arbitrary' }, ['one']), /unknown/u);
});

test('proxy performs sticky HTTP routing and records the actual backend', async () => {
  const first = await backend('one', { cookies: ['session=preserved; Path=/'] });
  const second = await backend('two');
  const proxy = await new AuditProxy({
    auditId: 'audit-1', backends: [proxyBackend(first), proxyBackend(second)],
  }).start();
  try {
    const initial = await request(proxy.port);
    assert.equal(initial.body, 'one');
    assert.deepEqual(initial.response.headers['set-cookie'], [
      'session=preserved; Path=/',
      'audit_backend=one; Path=/; HttpOnly; SameSite=Strict',
    ]);
    const sticky = await request(proxy.port, { cookie: 'audit_backend=one' });
    assert.equal(sticky.body, 'one');
    assert.ok(proxy.snapshotLedger().some((entry) => (
      entry.kind === 'http_routed' && entry.backendId === 'one'
    )));
  } finally {
    await proxy.stop();
    await Promise.all([first.stop(), second.stop()]);
  }
});

test('proxy attributes websocket routing and refuses foreign fault targets', async () => {
  const first = await backend('one');
  const second = await backend('two');
  const proxy = await new AuditProxy({
    auditId: 'audit-2', backends: [proxyBackend(first), proxyBackend(second)],
  }).start();
  try {
    const connectionId = 'connection-1';
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/websocket`, {
      headers: { 'x-audit-connection': connectionId, 'x-audit-backend': 'two' },
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const echoed = new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));
    socket.send('hello');
    assert.equal(await echoed, 'hello');
    assert.equal(proxy.connections.get(connectionId)?.backendId, 'two');
    const duplicate = new WebSocket(`ws://127.0.0.1:${proxy.port}/websocket`, {
      headers: { 'x-audit-connection': connectionId },
    });
    const duplicateClose = await new Promise((resolve) => duplicate.once('close', (code) => resolve(code)));
    assert.equal(duplicateClose, 1008);
    assert.throws(() => proxy.dropConnection('foreign'), /not owned/u);
    proxy.dropConnection(connectionId);
    await new Promise((resolve) => socket.once('close', resolve));
    assert.ok(proxy.snapshotLedger().some(({ kind }) => kind === 'fault_socket_drop'));
  } finally {
    await proxy.stop();
    await Promise.all([first.stop(), second.stop()]);
  }
});
