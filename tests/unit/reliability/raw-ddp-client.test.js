import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { RawDdpClient, RAW_DDP_STATES } from '../../../reliability/runtime/ddp/raw-client.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.emit('close'); }
  terminate() { this.emit('close'); }
  open() { this.emit('open'); }
  receive(message) { this.emit('message', JSON.stringify(message)); }
}

function fixture(maximumLedgerEntries = 100) {
  const sockets = [];
  const client = new RawDdpClient({
    endpoint: 'ws://audit.invalid/websocket',
    clientId: 'client-a',
    maximumLedgerEntries,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
}

async function establish(client, sockets, session = 'session-a') {
  const connected = client.connect();
  const socket = sockets.at(-1);
  socket.open();
  socket.receive({ msg: 'connected', session });
  await connected;
  return socket;
}

test('negotiates DDP v1 and tracks the exact resumable receive count', async () => {
  const { client, sockets } = fixture();
  const initial = client.connect();
  const first = sockets[0];
  first.open();
  assert.deepEqual(first.sent, [{ msg: 'connect', version: '1', support: ['1'] }]);
  first.receive({ msg: 'connected', session: 'session-a' });
  assert.deepEqual(await initial, { classification: 'initial', sessionId: 'session-a', receivedCount: 1 });
  first.receive({ msg: 'ping', id: 'heartbeat' });
  first.receive({ msg: 'added', collection: 'items', id: 'one', fields: { value: 1 } });
  assert.equal(client.receivedCount, 2);
  assert.deepEqual(first.sent.at(-1), { msg: 'pong', id: 'heartbeat' });

  first.terminate();
  const resumed = client.resume();
  const second = sockets[1];
  second.open();
  assert.deepEqual(second.sent[0], {
    msg: 'connect', version: '1', support: ['1'], session: 'session-a', receivedCount: 2,
  });
  second.receive({ msg: 'connected', session: 'session-a' });
  assert.equal((await resumed).classification, 'resumed');
  assert.equal(client.receivedCount, 3);
});

test('classifies a changed session as fresh and resets its receive count', async () => {
  const { client, sockets } = fixture();
  const first = await establish(client, sockets);
  first.receive({ msg: 'ready', subs: ['existing'] });
  first.terminate();
  const reconnect = client.resume();
  const second = sockets[1];
  second.open();
  second.receive({ msg: 'connected', session: 'session-b' });
  assert.deepEqual(await reconnect, { classification: 'fresh', sessionId: 'session-b', receivedCount: 1 });
});

test('does not implicitly replay subscriptions on resumed or fresh connections', async () => {
  const { client, sockets } = fixture();
  const first = await establish(client, sockets);
  const subscription = client.subscribe('reliability.documents', ['run-a']);
  assert.equal(first.sent.at(-1).msg, 'sub');
  first.receive({ msg: 'ready', subs: [first.sent.at(-1).id] });
  await subscription;
  first.terminate();

  const resumed = client.resume();
  const second = sockets[1];
  second.open();
  second.receive({ msg: 'connected', session: 'session-a' });
  await resumed;
  assert.equal(second.sent.filter(({ msg }) => msg === 'sub').length, 0);
  second.terminate();

  const fresh = client.resume();
  const third = sockets[2];
  third.open();
  third.receive({ msg: 'connected', session: 'session-c' });
  await fresh;
  assert.equal(third.sent.filter(({ msg }) => msg === 'sub').length, 0);
});

test('unsubscribe waits for nosub and fresh sessions discard stale local state', async () => {
  const { client, sockets } = fixture();
  const first = await establish(client, sockets);
  const subscriptionPromise = client.subscribe('reliability.documents', ['run-a']);
  const subscriptionId = first.sent.at(-1).id;
  first.receive({ msg: 'ready', subs: [subscriptionId] });
  const subscription = await subscriptionPromise;
  const unsubscribe = client.unsubscribe(subscription.id);
  assert.deepEqual(first.sent.at(-1), { msg: 'unsub', id: subscription.id });
  first.receive({ msg: 'nosub', id: subscription.id });
  await unsubscribe;

  first.receive({ msg: 'added', collection: 'items', id: 'one', fields: { value: 1 } });
  first.terminate();
  const reconnect = client.resume();
  const second = sockets[1];
  second.open();
  second.receive({ msg: 'connected', session: 'new-session' });
  await reconnect;
  assert.deepEqual(client.snapshot('items'), []);
});

test('merges DDP fields, applies cleared fields, and removes documents', async () => {
  const { client, sockets } = fixture();
  const socket = await establish(client, sockets);
  socket.receive({ msg: 'added', collection: 'items', id: 'one', fields: { keep: 1, clear: 2 } });
  socket.receive({ msg: 'changed', collection: 'items', id: 'one', fields: { keep: 3 }, cleared: ['clear'] });
  assert.deepEqual(client.snapshot('items'), [{ _id: 'one', keep: 3 }]);
  assert.throws(() => { client.snapshot('items')[0].keep = 4; }, TypeError);
  socket.receive({ msg: 'removed', collection: 'items', id: 'one' });
  assert.deepEqual(client.snapshot('items'), []);
});

test('uses stable operation IDs and resolves matching method results', async () => {
  const { client, sockets } = fixture();
  const socket = await establish(client, sockets);
  const call = client.call('audit.echo', ['value']);
  assert.deepEqual(socket.sent.at(-1), {
    msg: 'method', id: 'method-1', method: 'audit.echo', params: ['value'],
  });
  socket.receive({ msg: 'result', id: 'method-1', result: { echoed: true } });
  assert.deepEqual(await call, { echoed: true });
});

test('redacts audit ownership tokens from the immutable wire ledger', async () => {
  const { client, sockets } = fixture();
  const socket = await establish(client, sockets);
  const call = client.call('audit.monitorSnapshot', [{ runId: 'run-1', ownershipToken: 'secret' }]);
  assert.equal(socket.sent.at(-1).params[0].ownershipToken, 'secret');
  const outgoing = client.ledger().find(({ message }) => message.method === 'audit.monitorSnapshot');
  assert.equal(outgoing.message.params[0].ownershipToken, '[redacted]');
  socket.receive({ msg: 'result', id: 'method-1', result: [] });
  await call;

  const echo = client.call('audit.echo', [{
    runId: 'run-1', ownershipToken: 'secret', payload: 'sensitive-payload',
  }]);
  const echoOutgoing = client.ledger().find(({ message }) => message.method === 'audit.echo');
  assert.equal(echoOutgoing.message.params[0].payload, '[redacted]');
  assert.equal(echoOutgoing.message.params[0].payloadBytes, 19);
  socket.receive({ msg: 'result', id: 'method-2', result: { payload: 'sensitive-payload' } });
  await echo;
});

test('keeps an immutable bounded ledger and exposes explicit close state', async () => {
  const { client, sockets } = fixture(2);
  const socket = await establish(client, sockets);
  socket.receive({ msg: 'ping' });
  const ledger = client.ledger();
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.map(({ message }) => message.msg), ['ping', 'pong']);
  assert.throws(() => ledger.push({}), TypeError);
  client.close(1000, 'complete');
  assert.equal(client.state, RAW_DDP_STATES.DISCONNECTED);
});
