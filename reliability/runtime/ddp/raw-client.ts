import EJSON from 'ejson';
import { ObjectId } from 'mongodb';

import { immutableClone } from '../immutable.js';

const DDP_VERSION = '1';
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const IGNORED_RESUMPTION_MESSAGES = new Set(['ping', 'pong']);

type MessageDirection = 'in' | 'out';

interface DdpError {
  readonly reason?: string;
}

export interface DdpMessage {
  msg: string;
  id?: string;
  session?: string;
  version?: string;
  receivedCount?: number | null;
  support?: readonly string[];
  subs?: readonly string[];
  name?: string;
  method?: string;
  params?: readonly unknown[];
  error?: DdpError;
  result?: unknown;
  collection?: string;
  fields?: Readonly<Record<string, unknown>>;
  cleared?: readonly string[];
}

interface WebSocketLike {
  on?(event: string, listener: (event?: unknown) => void): void;
  onopen?: (event?: unknown) => void;
  onmessage?: (event?: unknown) => void;
  onerror?: (event?: unknown) => void;
  onclose?: (event?: unknown) => void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface PendingMessage {
  readonly predicate: (message: DdpMessage) => boolean;
  readonly resolve: Deferred<DdpMessage>['resolve'];
  readonly reject: Deferred<DdpMessage>['reject'];
}

interface Subscription {
  readonly id: string;
  readonly name: string;
  readonly params: readonly unknown[];
}

interface RawDdpClientOptions {
  readonly endpoint: string;
  readonly webSocketFactory: (endpoint: string) => WebSocketLike;
  readonly clientId: string;
  readonly maximumLedgerEntries: number;
  readonly operationTimeoutMs?: number;
}

/** Identifies a DDP operation that exceeded its local wire-response deadline. */
export class RawDdpTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`DDP ${operation} exceeded its ${timeoutMs}ms response deadline`);
    this.name = 'RawDdpTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** One immutable raw DDP wire-ledger entry. */
export interface RawDdpLedgerEntry {
  readonly sequence: number;
  readonly timestampNs: string;
  readonly clientId: string;
  readonly connectionAttempt: number;
  readonly direction: MessageDirection;
  readonly byteLength: number;
  readonly message: DdpMessage;
}

/** Per-operation cancellation and deadline overrides for raw DDP waits. */
export interface DdpOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface ConnectOptions extends DdpOperationOptions {
  readonly sessionId?: string | null;
  readonly receivedCount?: number | null;
}

interface ConnectResult {
  readonly classification: 'initial' | 'resumed' | 'fresh';
  readonly sessionId: string;
  readonly receivedCount: number;
}

EJSON.addType('oid', (hex: unknown) => {
  if (typeof hex !== 'string' || !/^[a-f0-9]{24}$/iu.test(hex)) {
    throw new TypeError('DDP ObjectID payload is invalid');
  }
  return new ObjectId(hex);
});

/** States exposed by the raw DDP client. */
export const RAW_DDP_STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  SOCKET_OPEN: 'socket_open',
  NEGOTIATING: 'negotiating',
  CONNECTED: 'connected',
  CLOSING: 'closing',
});
type RawDdpState = typeof RAW_DDP_STATES[keyof typeof RAW_DDP_STATES];

function deferred<Value>(): Deferred<Value> {
  let resolve: Deferred<Value>['resolve'] = () => undefined;
  let reject: Deferred<Value>['reject'] = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // DDP shutdown can reject several correlated waits in the same tick. The
  // owning operation still observes the original rejection, while this sink
  // prevents a sibling wait from becoming a process-level unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function immutable<Value>(value: Value): Value {
  return immutableClone(value);
}

function normalizeIncoming(event: unknown): string {
  const data = event && typeof event === 'object' && Object.hasOwn(event, 'data')
    ? Reflect.get(event, 'data')
    : event;
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
}

function addListener(socket: WebSocketLike, event: string, listener: (event?: unknown) => void): void {
  if (typeof socket.on === 'function') socket.on(event, listener);
  else if (event === 'open') socket.onopen = listener;
  else if (event === 'message') socket.onmessage = listener;
  else if (event === 'error') socket.onerror = listener;
  else if (event === 'close') socket.onclose = listener;
  else throw new Error(`unsupported socket event ${event}`);
}

function redactLedgerMessage(message: DdpMessage): DdpMessage {
  if (message?.msg !== 'method' || !message.method?.startsWith('audit.')) return message;
  if (message.params === undefined) return message;
  return {
    ...message,
    params: message.params.map((parameter) => (
      parameter && typeof parameter === 'object'
        ? {
          ...Object.fromEntries(Object.entries(parameter)),
          ownershipToken: '[redacted]',
          ...(Object.hasOwn(parameter, 'payload') ? {
            payload: '[redacted]',
            payloadBytes: Buffer.byteLength(JSON.stringify(Reflect.get(parameter, 'payload'))),
          } : {}),
        }
        : parameter
    )),
  };
}

function parseDdpMessage(value: unknown): DdpMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('DDP message must be an object');
  }
  const msg = Reflect.get(value, 'msg');
  if (typeof msg !== 'string' || msg.length === 0) throw new TypeError('DDP message type is invalid');
  const optionalString = (key: string): string | undefined => {
    const candidate = Reflect.get(value, key);
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string') throw new TypeError(`DDP message ${key} is invalid`);
    return candidate;
  };
  const optionalStrings = (key: string): readonly string[] | undefined => {
    const candidate = Reflect.get(value, key);
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || !candidate.every((entry) => typeof entry === 'string')) {
      throw new TypeError(`DDP message ${key} is invalid`);
    }
    return candidate;
  };
  const errorValue = Reflect.get(value, 'error');
  let error: DdpError | undefined;
  if (errorValue !== undefined) {
    if (!errorValue || typeof errorValue !== 'object' || Array.isArray(errorValue)) throw new TypeError('DDP error is invalid');
    const reason = Reflect.get(errorValue, 'reason');
    if (reason !== undefined && typeof reason !== 'string') throw new TypeError('DDP error reason is invalid');
    error = reason === undefined ? {} : { reason };
  }
  const fieldsValue = Reflect.get(value, 'fields');
  let fields: Readonly<Record<string, unknown>> | undefined;
  if (fieldsValue !== undefined) {
    if (!fieldsValue || typeof fieldsValue !== 'object' || Array.isArray(fieldsValue)) throw new TypeError('DDP fields are invalid');
    fields = Object.fromEntries(Object.entries(fieldsValue));
  }
  const paramsValue = Reflect.get(value, 'params');
  if (paramsValue !== undefined && !Array.isArray(paramsValue)) throw new TypeError('DDP params are invalid');
  const params: readonly unknown[] | undefined = Array.isArray(paramsValue)
    ? paramsValue.map((entry: unknown) => entry)
    : undefined;
  const receivedCountValue = Reflect.get(value, 'receivedCount');
  if (receivedCountValue !== undefined && receivedCountValue !== null && typeof receivedCountValue !== 'number') {
    throw new TypeError('DDP receivedCount is invalid');
  }
  const receivedCount: number | null | undefined = typeof receivedCountValue === 'number' || receivedCountValue === null
    ? receivedCountValue
    : undefined;
  const support = optionalStrings('support');
  const subs = optionalStrings('subs');
  const cleared = optionalStrings('cleared');
  const result: unknown = Reflect.get(value, 'result');
  return {
    msg,
    ...Object.fromEntries(
      ['id', 'session', 'version', 'name', 'method', 'collection']
        .map((key) => [key, optionalString(key)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
    ),
    ...(support === undefined ? {} : { support }),
    ...(subs === undefined ? {} : { subs }),
    ...(cleared === undefined ? {} : { cleared }),
    ...(params === undefined ? {} : { params }),
    ...(error === undefined ? {} : { error }),
    ...(fields === undefined ? {} : { fields }),
    ...(receivedCount === undefined ? {} : { receivedCount }),
    ...(Object.hasOwn(value, 'result') ? { result } : {}),
  };
}

/**
 * Minimal DDP v1 client whose wire state is explicit and suitable for audit evidence.
 * Lifecycle timing and reconnect policy intentionally belong to the caller.
 */
export class RawDdpClient {
  readonly endpoint: string;
  readonly webSocketFactory: (endpoint: string) => WebSocketLike;
  readonly clientId: string;
  readonly maximumLedgerEntries: number;
  readonly operationTimeoutMs: number;
  state: RawDdpState;
  sessionId: string | null;
  receivedCount: number;
  socket: WebSocketLike | null;
  connectionAttempt: number;
  sequence: number;
  nextOperationId: number;
  readonly ledgerEntries: RawDdpLedgerEntry[];
  readonly collections: Map<string, Map<string, Record<string, unknown>>>;
  readonly pendingMessages: Set<PendingMessage>;
  readonly subscriptions: Map<string, Subscription>;

  /** Creates a raw client around an injected WebSocket-compatible factory. */
  constructor({
    endpoint, webSocketFactory, clientId, maximumLedgerEntries,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  }: RawDdpClientOptions) {
    if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('endpoint must be a non-empty string');
    if (typeof webSocketFactory !== 'function') throw new TypeError('webSocketFactory must be a function');
    if (typeof clientId !== 'string' || clientId.length === 0) throw new TypeError('clientId must be a non-empty string');
    if (!Number.isSafeInteger(maximumLedgerEntries) || maximumLedgerEntries < 1) {
      throw new TypeError('maximumLedgerEntries must be a positive integer');
    }
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) {
      throw new TypeError('operationTimeoutMs must be a positive integer');
    }
    this.endpoint = endpoint;
    this.webSocketFactory = webSocketFactory;
    this.clientId = clientId;
    this.maximumLedgerEntries = maximumLedgerEntries;
    this.operationTimeoutMs = operationTimeoutMs;
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
    this.subscriptions = new Map();
  }

  /** Returns an immutable copy of the bounded wire ledger. */
  ledger(): readonly RawDdpLedgerEntry[] {
    return immutable(this.ledgerEntries);
  }

  /** Returns an immutable snapshot of a DDP collection. */
  snapshot(collectionName: string): readonly Readonly<Record<string, unknown>>[] {
    const collection = this.collections.get(collectionName);
    return immutable(collection ? [...collection.values()] : []);
  }

  /** Opens one connection attempt and resolves after DDP negotiation. */
  connect({
    sessionId = null, receivedCount = null, signal, timeoutMs,
  }: ConnectOptions = {}): Promise<ConnectResult> {
    if (this.state !== RAW_DDP_STATES.DISCONNECTED) {
      throw new Error(`cannot connect while ${this.state}`);
    }
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0)) {
      throw new TypeError('sessionId must be null or a non-empty string');
    }
    if (sessionId !== null && (!Number.isSafeInteger(receivedCount) || typeof receivedCount !== 'number' || receivedCount < 0)) {
      throw new TypeError('receivedCount must be a non-negative integer when resuming');
    }

    const outcome = deferred<ConnectResult>();
    const requestedSessionId = sessionId;
    this.connectionAttempt += 1;
    const socket = this.webSocketFactory(this.endpoint);
    this.socket = socket;

    addListener(socket, 'open', () => {
      if (socket !== this.socket) return;
      this.state = RAW_DDP_STATES.SOCKET_OPEN;
      const message: DdpMessage = { msg: 'connect', version: DDP_VERSION, support: [DDP_VERSION] };
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
    return this.#withDeadline(outcome.promise, 'connect', {}, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /** Reconnects using the last accepted session and exact DDP receive count. */
  resume(): Promise<ConnectResult> {
    if (this.sessionId === null) throw new Error('cannot resume before a session has been established');
    return this.connect({ sessionId: this.sessionId, receivedCount: this.receivedCount });
  }

  /** Sends a subscription and resolves on its matching ready message. */
  async subscribe(
    name: string,
    params: readonly unknown[] = [],
    options: DdpOperationOptions = {},
  ): Promise<Subscription> {
    this.#assertConnected();
    const id = this.#operationId('sub');
    const ready = this.#waitFor('subscribe', (message) => (
      (message.msg === 'ready' && message.subs?.includes(id))
      || (message.msg === 'nosub' && message.id === id)
    ), options);
    this.#send({ msg: 'sub', id, name, params });
    const message = await ready;
    if (message.msg === 'nosub') throw new Error(`subscription ${name} failed`);
    const subscription = immutable({ id, name, params });
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  /** Stops one exact subscription and waits until the server acknowledges it. */
  async unsubscribe(id: string, options: DdpOperationOptions = {}): Promise<void> {
    this.#assertConnected();
    if (!this.subscriptions.has(id)) throw new Error(`subscription ${id} is not active`);
    const stopped = this.#waitFor(
      'unsubscribe',
      (message) => message.msg === 'nosub' && message.id === id,
      options,
    );
    this.#send({ msg: 'unsub', id });
    await stopped;
    this.subscriptions.delete(id);
  }

  /** Sends a method invocation and resolves with its matching result. */
  async call(method: string, params: readonly unknown[] = [], options: DdpOperationOptions = {}): Promise<unknown> {
    this.#assertConnected();
    const id = this.#operationId('method');
    const result = this.#waitFor(
      'method call',
      (message) => message.msg === 'result' && message.id === id,
      options,
    );
    this.#send({ msg: 'method', id, method, params });
    const message = await result;
    if (message.error) throw new Error(message.error.reason || `method ${method} failed`);
    return immutable(message.result);
  }

  /** Performs a graceful WebSocket close without reconnecting. */
  close(code?: number, reason?: string): void {
    if (!this.socket) return;
    this.state = RAW_DDP_STATES.CLOSING;
    this.socket.close(code, reason);
  }

  /** Abruptly destroys the current transport when supported by the socket. */
  terminate(): void {
    if (!this.socket) return;
    if (typeof this.socket.terminate !== 'function') throw new Error('socket does not support abrupt termination');
    this.socket.terminate();
  }

  #assertConnected(): void {
    if (this.state !== RAW_DDP_STATES.CONNECTED) throw new Error(`DDP client is ${this.state}`);
  }

  #operationId(prefix: string): string {
    this.nextOperationId += 1;
    return `${prefix}-${this.nextOperationId}`;
  }

  #record(direction: MessageDirection, raw: string, message: DdpMessage): void {
    const entry: RawDdpLedgerEntry = immutable({
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

  #send(message: DdpMessage): void {
    if (!this.socket) throw new Error('socket is not open');
    const raw = EJSON.stringify(message);
    this.socket.send(raw);
    this.#record('out', raw, message);
  }

  #receive(socket: WebSocketLike, event: unknown, requestedSessionId: string | null, outcome: Deferred<ConnectResult>): void {
    if (socket !== this.socket) return;
    const raw = normalizeIncoming(event);
    let message;
    try {
      message = parseDdpMessage(EJSON.parse(raw));
    } catch {
      this.#record('in', raw, { msg: 'malformed' });
      return;
    }
    this.#record('in', raw, message);
    if (!IGNORED_RESUMPTION_MESSAGES.has(message.msg)) this.receivedCount += 1;

    if (message.msg === 'ping') {
      this.#send(message.id === undefined ? { msg: 'pong' } : { msg: 'pong', id: message.id });
    } else if (message.msg === 'connected') {
      if (typeof message.session !== 'string' || message.session.length === 0) {
        outcome.reject(new Error('DDP connected message omitted its session identity'));
        return;
      }
      const classification = requestedSessionId === null
        ? 'initial'
        : message.session === requestedSessionId ? 'resumed' : 'fresh';
      if (classification === 'fresh') {
        this.collections.clear();
        this.subscriptions.clear();
      }
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

  #waitFor(
    operation: string,
    predicate: (message: DdpMessage) => boolean,
    options: DdpOperationOptions,
  ): Promise<DdpMessage> {
    const result = deferred<DdpMessage>();
    const pending = { predicate, resolve: result.resolve, reject: result.reject };
    this.pendingMessages.add(pending);
    return this.#withDeadline(
      result.promise,
      operation,
      { beforeAbort: () => this.pendingMessages.delete(pending) },
      options,
    );
  }

  #withDeadline<Value>(
    promise: Promise<Value>,
    operation: string,
    hooks: Readonly<{ beforeAbort?: () => void }>,
    options: DdpOperationOptions,
  ): Promise<Value> {
    const timeoutMs = options.timeoutMs ?? this.operationTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new TypeError('DDP operation timeoutMs must be a positive integer'));
    }
    if (options.signal?.aborted) {
      hooks.beforeAbort?.();
      this.#terminateTimedOutSocket();
      return Promise.reject(options.signal.reason ?? new Error(`DDP ${operation} aborted`));
    }
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        hooks.beforeAbort?.();
        reject(new RawDdpTimeoutError(operation, timeoutMs));
        this.#terminateTimedOutSocket();
      }, timeoutMs);
      const abort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        hooks.beforeAbort?.();
        reject(options.signal?.reason ?? new Error(`DDP ${operation} aborted`));
        this.#terminateTimedOutSocket();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        action();
      };
      promise.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  #terminateTimedOutSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    if (typeof socket.terminate === 'function') socket.terminate();
    else socket.close(1011, 'DDP operation deadline exceeded');
  }

  #applyCollectionMessage(message: DdpMessage): void {
    if (!['added', 'changed', 'removed'].includes(message.msg)) return;
    if (typeof message.collection !== 'string' || typeof message.id !== 'string') return;
    let collection = this.collections.get(message.collection);
    if (!collection) {
      collection = new Map();
      this.collections.set(message.collection, collection);
    }
    if (message.msg === 'removed') {
      collection.delete(message.id);
      return;
    }
    const previous: Record<string, unknown> = collection.get(message.id) || { _id: message.id };
    const next: Record<string, unknown> = { ...previous, ...(message.fields || {}), _id: message.id };
    for (const field of message.cleared || []) delete next[field];
    collection.set(message.id, next);
  }
}
