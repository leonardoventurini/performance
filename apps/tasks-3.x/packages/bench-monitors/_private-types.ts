/** Structured message shape exposed by Meteor's private DDP hooks. */
export interface DdpMessage { readonly msg?: string; readonly [field: string]: unknown }

/** Mutable server session surface used only after runtime member checks. */
export interface PrivateSession {
  send(message: DdpMessage): unknown;
  sendAdded(collection: string, id: unknown, fields: Record<string, unknown>): unknown;
  sendChanged(collection: string, id: unknown, fields: Record<string, unknown>): unknown;
  [field: string]: unknown;
}

export interface PrivateMeteorServer { readonly sessions: Map<string, PrivateSession> | Record<string, PrivateSession> }

export interface PrivateMeteor {
  readonly server?: PrivateMeteorServer;
  onMessage(callback: (message: DdpMessage) => void): void;
}

export interface ObserveDriver { readonly constructor?: { readonly name?: string }; readonly _sharedStream?: unknown; readonly _cursorDescription?: unknown }
export interface ObserveMultiplexer { readonly _observeDriver?: ObserveDriver; readonly _handles?: Record<string, unknown> | null }
export interface ObserveHandle { readonly _multiplexer?: ObserveMultiplexer }
export interface PrivateMongoConnection {
  _observeChanges(...arguments_: unknown[]): Promise<ObserveHandle>;
  readonly _observeMultiplexers?: Record<string, ObserveMultiplexer>;
}

/** Narrows the private Mongo connection after validating its required hook. */
export function privateMongo(value: unknown): PrivateMongoConnection | null {
  if (value === null || typeof value !== 'object' || !('_observeChanges' in value)
    || typeof value._observeChanges !== 'function') return null;
  return value as PrivateMongoConnection;
}

/** Narrows Meteor's undocumented monitoring hooks at their runtime boundary. */
export function privateMeteor(value: unknown): PrivateMeteor {
  if (value === null || typeof value !== 'object') throw new TypeError('Meteor runtime is unavailable');
  return value as PrivateMeteor;
}
