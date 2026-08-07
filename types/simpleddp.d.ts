declare module 'simpleddp' {
  import type { EventEmitter } from 'node:events';

  /** Options used by the audit DDP adapter. */
  export interface SimpleDdpOptions {
    readonly endpoint: string;
    readonly SocketConstructor: unknown;
    readonly reconnectInterval?: number;
  }

  /** Narrow client surface consumed by this repository. */
  export default class SimpleDDP extends EventEmitter {
    constructor(options: SimpleDdpOptions, ejson: unknown);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    call(method: string, ...parameters: readonly unknown[]): Promise<unknown>;
    sub(name: string, ...parameters: readonly unknown[]): Promise<unknown>;
  }
}
