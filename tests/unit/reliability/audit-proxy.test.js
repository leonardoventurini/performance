import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import WebSocket, { WebSocketServer } from 'ws';

import {
  AuditProxy,
  validateRoutePolicy,
} from '../../../reliability/environment/audit-proxy.js';

async function backend(id) {
  const server = http.createServer((_request, response) => response.end(id));
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, (ws) => {
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  }));
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const port = server.address().port;
  return {
    id,
    httpUrl: `http://127.0.0.1:${port}`,
    webSocketUrl: `ws://127.0.0.1:${port}`,
    stop: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function proxyBackend(value) {
  return { id: value.id, httpUrl: value.httpUrl, webSocketUrl: value.webSocketUrl };
}

function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, headers }, (response) => {
      const chunks = [];
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
  const first = await backend('one');
  const second = await backend('two');
  const proxy = await new AuditProxy({
    auditId: 'audit-1', backends: [proxyBackend(first), proxyBackend(second)],
  }).start();
  try {
    const initial = await request(proxy.port);
    assert.equal(initial.body, 'one');
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
    assert.equal(proxy.connections.get(connectionId).backendId, 'two');
    assert.throws(() => proxy.dropConnection('foreign'), /not owned/u);
    proxy.dropConnection(connectionId);
    await new Promise((resolve) => socket.once('close', resolve));
    assert.ok(proxy.snapshotLedger().some(({ kind }) => kind === 'fault_socket_drop'));
  } finally {
    await proxy.stop();
    await Promise.all([first.stop(), second.stop()]);
  }
});
