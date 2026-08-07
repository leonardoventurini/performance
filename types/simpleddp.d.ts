declare module 'simpleddp' {
  import type { EventEmitter } from 'node:events';

  /** Options used by the audit DDP adapter. */
  export interface SimpleDdpOptions {
    readonly endpoint: string;
    readonly SocketConstructor: unknown;
    readonly reconnectInterval?: number;
  }

  /** Subscription lifecycle returned by the high-level client API. */
  export interface SubscriptionHandle {
    ready(): Promise<void>;
  }

  /** Stop handle for a reactive collection listener. */
  export interface ReactiveListener {
    stop(): void;
  }

  /** Reactive view exposed by a named DDP collection. */
  export interface ReactiveCollection {
    onChange(handler: (change: unknown) => void): ReactiveListener;
  }

  /** Named collection surface consumed by protocol workloads. */
  export interface CollectionHandle {
    reactive(): ReactiveCollection;
  }

  /** Narrow client surface consumed by this repository. */
  export default class SimpleDDP extends EventEmitter {
    constructor(options: SimpleDdpOptions, ejson?: unknown);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    call(method: string, ...parameters: readonly unknown[]): Promise<unknown>;
    sub(name: string, ...parameters: readonly unknown[]): Promise<unknown>;
    subscribe(name: string, ...parameters: readonly unknown[]): SubscriptionHandle;
    collection(name: string): CollectionHandle;
  }
}
