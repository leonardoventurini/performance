import EJSON from 'ejson';

const DDP_VERSION = '1';
const IGNORED_RESUMPTION_MESSAGES = new Set(['ping', 'pong']);

/** States exposed by the raw DDP client. */
export const RAW_DDP_STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  SOCKET_OPEN: 'socket_open',
  NEGOTIATING: 'negotiating',
  CONNECTED: 'connected',
  CLOSING: 'closing',
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function immutable(value) {
  const clone = structuredClone(value);
  const freeze = (entry) => {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
      Object.freeze(entry);
      for (const child of Object.values(entry)) freeze(child);
    }
    return entry;
  };
  return freeze(clone);
}

function normalizeIncoming(event) {
  const data = event && typeof event === 'object' && Object.hasOwn(event, 'data')
    ? event.data
    : event;
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
}

function addListener(socket, event, listener) {
  if (typeof socket.on === 'function') socket.on(event, listener);
  else socket[`on${event}`] = listener;
}

function redactLedgerMessage(message) {
  if (message?.msg !== 'method' || message.method !== 'audit.monitorSnapshot') return message;
  return {
    ...message,
    params: message.params?.map((parameter) => (
      parameter && typeof parameter === 'object'
        ? { ...parameter, ownershipToken: '[redacted]' }
        : parameter
    )),
  };
}

/**
 * Minimal DDP v1 client whose wire state is explicit and suitable for audit evidence.
 * Lifecycle timing and reconnect policy intentionally belong to the caller.
 */
export class RawDdpClient {
  /** Creates a raw client around an injected WebSocket-compatible factory. */
  constructor({ endpoint, webSocketFactory, clientId, maximumLedgerEntries }) {
    if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('endpoint must be a non-empty string');
    if (typeof webSocketFactory !== 'function') throw new TypeError('webSocketFactory must be a function');
    if (typeof clientId !== 'string' || clientId.length === 0) throw new TypeError('clientId must be a non-empty string');
    if (!Number.isSafeInteger(maximumLedgerEntries) || maximumLedgerEntries < 1) {
      throw new TypeError('maximumLedgerEntries must be a positive integer');
    }
    this.endpoint = endpoint;
    this.webSocketFactory = webSocketFactory;
    this.clientId = clientId;
    this.maximumLedgerEntries = maximumLedgerEntries;
    this.state = RAW_DDP_STATES.DISCONNECTED;
    this.sessionId = null;
    this.receivedCount = 0;
    this.socket = null;
    this.connectionAttempt = 0;
    this.sequence = 0;
    this.nextOperationId = 0;
    this.ledgerEntries = [];
    this.collections = new Map();
    this.pendingMessages = new Set();
  }

  /** Returns an immutable copy of the bounded wire ledger. */
  ledger() {
    return immutable(this.ledgerEntries);
  }

  /** Returns an immutable snapshot of a DDP collection. */
  snapshot(collectionName) {
    const collection = this.collections.get(collectionName);
    return immutable(collection ? [...collection.values()] : []);
  }

  /** Opens one connection attempt and resolves after DDP negotiation. */
  connect({ sessionId = null, receivedCount = null } = {}) {
    if (this.state !== RAW_DDP_STATES.DISCONNECTED) {
      throw new Error(`cannot connect while ${this.state}`);
    }
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0)) {
      throw new TypeError('sessionId must be null or a non-empty string');
    }
    if (sessionId !== null && (!Number.isSafeInteger(receivedCount) || receivedCount < 0)) {
      throw new TypeError('receivedCount must be a non-negative integer when resuming');
    }

    const outcome = deferred();
    const requestedSessionId = sessionId;
    this.connectionAttempt += 1;
    const socket = this.webSocketFactory(this.endpoint);
    this.socket = socket;

    addListener(socket, 'open', () => {
      if (socket !== this.socket) return;
      this.state = RAW_DDP_STATES.SOCKET_OPEN;
      const message = { msg: 'connect', version: DDP_VERSION, support: [DDP_VERSION] };
      if (requestedSessionId !== null) {
        message.session = requestedSessionId;
        message.receivedCount = receivedCount;
      }
      this.state = RAW_DDP_STATES.NEGOTIATING;
      this.#send(message);
    });
    addListener(socket, 'message', (event) => this.#receive(socket, event, requestedSessionId, outcome));
    addListener(socket, 'error', (error) => {
      if (socket === this.socket && this.state !== RAW_DDP_STATES.CONNECTED) outcome.reject(error);
    });
    addListener(socket, 'close', () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.state = RAW_DDP_STATES.DISCONNECTED;
      outcome.reject(new Error('socket closed before DDP negotiation completed'));
      for (const pending of this.pendingMessages) pending.reject(new Error('socket closed while awaiting DDP message'));
      this.pendingMessages.clear();
    });
    return outcome.promise;
  }

  /** Reconnects using the last accepted session and exact DDP receive count. */
  resume() {
    if (this.sessionId === null) throw new Error('cannot resume before a session has been established');
    return this.connect({ sessionId: this.sessionId, receivedCount: this.receivedCount });
  }

  /** Sends a subscription and resolves on its matching ready message. */
  async subscribe(name, params = []) {
    this.#assertConnected();
    const id = this.#operationId('sub');
    const ready = this.#waitFor((message) => (
      (message.msg === 'ready' && message.subs?.includes(id))
      || (message.msg === 'nosub' && message.id === id)
    ));
    this.#send({ msg: 'sub', id, name, params });
    const message = await ready;
    if (message.msg === 'nosub') throw new Error(`subscription ${name} failed`);
    return immutable({ id, name, params });
  }

  /** Sends a method invocation and resolves with its matching result. */
  async call(method, params = []) {
    this.#assertConnected();
    const id = this.#operationId('method');
    const result = this.#waitFor((message) => message.msg === 'result' && message.id === id);
    this.#send({ msg: 'method', id, method, params });
    const message = await result;
    if (message.error) throw new Error(message.error.reason || `method ${method} failed`);
    return immutable(message.result);
  }

  /** Performs a graceful WebSocket close without reconnecting. */
  close(code, reason) {
    if (!this.socket) return;
    this.state = RAW_DDP_STATES.CLOSING;
    this.socket.close(code, reason);
  }

  /** Abruptly destroys the current transport when supported by the socket. */
  terminate() {
    if (!this.socket) return;
    if (typeof this.socket.terminate !== 'function') throw new Error('socket does not support abrupt termination');
    this.socket.terminate();
  }

  #assertConnected() {
    if (this.state !== RAW_DDP_STATES.CONNECTED) throw new Error(`DDP client is ${this.state}`);
  }

  #operationId(prefix) {
    this.nextOperationId += 1;
    return `${prefix}-${this.nextOperationId}`;
  }

  #record(direction, raw, message) {
    const entry = immutable({
      sequence: ++this.sequence,
      timestampNs: process.hrtime.bigint().toString(),
      clientId: this.clientId,
      connectionAttempt: this.connectionAttempt,
      direction,
      byteLength: Buffer.byteLength(raw),
      message: redactLedgerMessage(message),
    });
    this.ledgerEntries.push(entry);
    if (this.ledgerEntries.length > this.maximumLedgerEntries) this.ledgerEntries.shift();
  }

  #send(message) {
    if (!this.socket) throw new Error('socket is not open');
    const raw = EJSON.stringify(message);
    this.socket.send(raw);
    this.#record('out', raw, message);
  }

  #receive(socket, event, requestedSessionId, outcome) {
    if (socket !== this.socket) return;
    const raw = normalizeIncoming(event);
    let message;
    try {
      message = EJSON.parse(raw);
    } catch {
      this.#record('in', raw, { msg: 'malformed' });
      return;
    }
    this.#record('in', raw, message);
    if (!IGNORED_RESUMPTION_MESSAGES.has(message.msg)) this.receivedCount += 1;

    if (message.msg === 'ping') {
      this.#send(message.id === undefined ? { msg: 'pong' } : { msg: 'pong', id: message.id });
    } else if (message.msg === 'connected') {
      const classification = requestedSessionId === null
        ? 'initial'
        : message.session === requestedSessionId ? 'resumed' : 'fresh';
      this.sessionId = message.session;
      if (classification === 'fresh') this.receivedCount = 1;
      this.state = RAW_DDP_STATES.CONNECTED;
      outcome.resolve(immutable({ classification, sessionId: message.session, receivedCount: this.receivedCount }));
    } else if (message.msg === 'failed') {
      outcome.reject(new Error(`DDP negotiation failed; server requested version ${message.version}`));
    } else {
      this.#applyCollectionMessage(message);
    }
    for (const pending of [...this.pendingMessages]) {
      if (pending.predicate(message)) {
        this.pendingMessages.delete(pending);
        pending.resolve(message);
      }
    }
  }

  #waitFor(predicate) {
    const result = deferred();
    const pending = { predicate, resolve: result.resolve, reject: result.reject };
    this.pendingMessages.add(pending);
    return result.promise;
  }

  #applyCollectionMessage(message) {
    if (!['added', 'changed', 'removed'].includes(message.msg)) return;
    let collection = this.collections.get(message.collection);
    if (!collection) {
      collection = new Map();
      this.collections.set(message.collection, collection);
    }
    if (message.msg === 'removed') {
      collection.delete(message.id);
      return;
    }
    const previous = collection.get(message.id) || { _id: message.id };
    const next = { ...previous, ...(message.fields || {}), _id: message.id };
    for (const field of message.cleared || []) delete next[field];
    collection.set(message.id, next);
  }
}
