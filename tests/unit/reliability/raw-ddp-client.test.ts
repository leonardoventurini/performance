import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ObjectId } from 'mongodb';

import {
  RawDdpClient,
  RawDdpTimeoutError,
  RAW_DDP_STATES,
  type DdpMessage,
} from '../../../reliability/runtime/ddp/raw-client.js';

type TestMessage = Record<string, unknown> & { msg: string };

class FakeSocket extends EventEmitter {
  readonly sent: TestMessage[];

  constructor() {
    super();
    this.sent = [];
  }

  send(raw: string): void {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new TypeError('test socket received an invalid DDP message');
    }
    const msg: unknown = Reflect.get(parsed, 'msg');
    if (typeof msg !== 'string') throw new TypeError('test socket received an invalid DDP message');
    this.sent.push({ ...Object.fromEntries(Object.entries(parsed)), msg });
  }
  close() { this.emit('close'); }
  terminate() { this.emit('close'); }
  open() { this.emit('open'); }
  receive(message: DdpMessage): void { this.emit('message', JSON.stringify(message)); }
  receiveRaw(raw: string): void { this.emit('message', raw); }
}

function fixture(maximumLedgerEntries = 100, operationTimeoutMs?: number) {
  const sockets: FakeSocket[] = [];
  const client = new RawDdpClient({
    endpoint: 'ws://audit.invalid/websocket',
    clientId: 'client-a',
    maximumLedgerEntries,
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
}

test('times out every unanswered DDP operation and terminates its socket', async (context) => {
  const timeoutMs = 10;
  await context.test('connect', async () => {
    const { client, sockets } = fixture(100, timeoutMs);
    const operation = client.connect();
    assert.equal(sockets.length, 1);
    await assert.rejects(operation, (error: unknown) => (
      error instanceof RawDdpTimeoutError && error.operation === 'connect'
    ));
    assert.equal(client.state, RAW_DDP_STATES.DISCONNECTED);
  });

  for (const operationName of ['method call', 'subscribe'] as const) {
    await context.test(operationName, async () => {
      const { client, sockets } = fixture(100, timeoutMs);
      await establish(client, sockets);
      const operation = operationName === 'method call'
        ? client.call('audit.monitorSnapshot')
        : client.subscribe('reliability.documents');
      await assert.rejects(operation, (error: unknown) => (
        error instanceof RawDdpTimeoutError && error.operation === operationName
      ));
      assert.equal(client.state, RAW_DDP_STATES.DISCONNECTED);
      assert.equal(client.pendingMessages.size, 0);
    });
  }

  await context.test('unsubscribe', async () => {
    const { client, sockets } = fixture(100, timeoutMs);
    const socket = await establish(client, sockets);
    const subscribing = client.subscribe('reliability.documents');
    const subscriptionId = messageId(lastSent(socket));
    socket.receive({ msg: 'ready', subs: [subscriptionId] });
    const subscription = await subscribing;
    await assert.rejects(client.unsubscribe(subscription.id), (error: unknown) => (
      error instanceof RawDdpTimeoutError && error.operation === 'unsubscribe'
    ));
    assert.equal(client.state, RAW_DDP_STATES.DISCONNECTED);
    assert.equal(client.pendingMessages.size, 0);
  });
});

test('an AbortSignal cancels an unanswered operation and clears its waiter', async () => {
  const { client, sockets } = fixture();
  await establish(client, sockets);
  const controller = new AbortController();
  const reason = new Error('readiness attempt expired');
  const operation = client.call('audit.monitorSnapshot', [], { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(operation, reason);
  assert.equal(client.state, RAW_DDP_STATES.DISCONNECTED);
  assert.equal(client.pendingMessages.size, 0);
});

function socketAt(sockets: readonly FakeSocket[], index: number): FakeSocket {
  const socket = sockets.at(index);
  if (!socket) throw new Error(`missing test socket at ${index}`);
  return socket;
}

function lastSent(socket: FakeSocket): TestMessage {
  const message = socket.sent.at(-1);
  if (!message) throw new Error('test socket has no sent message');
  return message;
}

function messageId(message: TestMessage): string {
  if (typeof message.id !== 'string') throw new Error('test message has no identifier');
  return message.id;
}

function parameterAt(message: unknown, index: number): Record<string, unknown> {
  if (!message || typeof message !== 'object') throw new Error('test message is not an object');
  const params: unknown = Reflect.get(message, 'params');
  const parameter = Array.isArray(params) ? params.at(index) : undefined;
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
    throw new Error(`test message parameter ${index} is not an object`);
  }
  return Object.fromEntries(Object.entries(parameter));
}

async function establish(client: RawDdpClient, sockets: readonly FakeSocket[], session = 'session-a'): Promise<FakeSocket> {
  const connected = client.connect();
  const socket = socketAt(sockets, -1);
  socket.open();
  socket.receive({ msg: 'connected', session });
  await connected;
  return socket;
}

test('negotiates DDP v1 and tracks the exact resumable receive count', async () => {
  const { client, sockets } = fixture();
  const initial = client.connect();
  const first = socketAt(sockets, 0);
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
  const second = socketAt(sockets, 1);
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
  const second = socketAt(sockets, 1);
  second.open();
  second.receive({ msg: 'connected', session: 'session-b' });
  assert.deepEqual(await reconnect, { classification: 'fresh', sessionId: 'session-b', receivedCount: 1 });
});

test('does not implicitly replay subscriptions on resumed or fresh connections', async () => {
  const { client, sockets } = fixture();
  const first = await establish(client, sockets);
  const subscription = client.subscribe('reliability.documents', ['run-a']);
  const sentSubscription = lastSent(first);
  assert.equal(sentSubscription.msg, 'sub');
  first.receive({ msg: 'ready', subs: [messageId(sentSubscription)] });
  await subscription;
  first.terminate();

  const resumed = client.resume();
  const second = socketAt(sockets, 1);
  second.open();
  second.receive({ msg: 'connected', session: 'session-a' });
  await resumed;
  assert.equal(second.sent.filter(({ msg }) => msg === 'sub').length, 0);
  second.terminate();

  const fresh = client.resume();
  const third = socketAt(sockets, 2);
  third.open();
  third.receive({ msg: 'connected', session: 'session-c' });
  await fresh;
  assert.equal(third.sent.filter(({ msg }) => msg === 'sub').length, 0);
});

test('unsubscribe waits for nosub and fresh sessions discard stale local state', async () => {
  const { client, sockets } = fixture();
  const first = await establish(client, sockets);
  const subscriptionPromise = client.subscribe('reliability.documents', ['run-a']);
  const subscriptionId = messageId(lastSent(first));
  first.receive({ msg: 'ready', subs: [subscriptionId] });
  const subscription = await subscriptionPromise;
  const unsubscribe = client.unsubscribe(subscription.id);
  assert.deepEqual(first.sent.at(-1), { msg: 'unsub', id: subscription.id });
  first.receive({ msg: 'nosub', id: subscription.id });
  await unsubscribe;

  first.receive({ msg: 'added', collection: 'items', id: 'one', fields: { value: 1 } });
  first.terminate();
  const reconnect = client.resume();
  const second = socketAt(sockets, 1);
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
  assert.equal(Reflect.set(client.snapshot('items')[0] ?? {}, 'keep', 4), false);
  assert.deepEqual(client.snapshot('items'), [{ _id: 'one', keep: 3 }]);
  socket.receive({ msg: 'removed', collection: 'items', id: 'one' });
  assert.deepEqual(client.snapshot('items'), []);
});

test('decodes Meteor ObjectID values into canonical binary identity', async () => {
  const { client, sockets } = fixture();
  const socket = await establish(client, sockets);
  socket.receiveRaw('{"msg":"added","collection":"items","id":"one","fields":{"objectId":{"$type":"oid","$value":"000000000000000000000001"}}}');
  const objectId = client.snapshot('items')[0]?.objectId;
  assert.ok(objectId instanceof ObjectId);
  assert.equal(objectId.toHexString(), '000000000000000000000001');
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
  assert.equal(parameterAt(lastSent(socket), 0).ownershipToken, 'secret');
  const outgoing = client.ledger().find(({ message }) => message.method === 'audit.monitorSnapshot');
  assert.ok(outgoing);
  assert.equal(parameterAt(outgoing.message, 0).ownershipToken, '[redacted]');
  socket.receive({ msg: 'result', id: 'method-1', result: [] });
  await call;

  const echo = client.call('audit.echo', [{
    runId: 'run-1', ownershipToken: 'secret', payload: 'sensitive-payload',
  }]);
  const echoOutgoing = client.ledger().find(({ message }) => message.method === 'audit.echo');
  assert.ok(echoOutgoing);
  assert.equal(parameterAt(echoOutgoing.message, 0).payload, '[redacted]');
  assert.equal(parameterAt(echoOutgoing.message, 0).payloadBytes, 19);
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
  assert.throws(() => { Reflect.apply(Array.prototype.push, ledger, [{}]); }, TypeError);
  client.close(1000, 'complete');
  assert.equal(client.state, RAW_DDP_STATES.DISCONNECTED);
});
