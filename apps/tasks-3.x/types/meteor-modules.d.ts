interface PackageAPI {
  mainModule(path: string, architectures?: readonly string[]): void;
}

declare module 'meteor/tasks-common' {
  import type { ComponentType } from 'react';
  export const App: ComponentType;
  export function initializeTaskCollection(): unknown;
  export function registerTaskApi(): Promise<void>;
  export function tryMonitorExtras(): Promise<void>;
}

declare module 'meteor/bench-monitors' {
  export function initMethodTiming(): void;
  export function initSubTiming(): void;
  export function initPropagationTiming(): void;
  export function initObserverPoolSampler(): void;
  export function initDdpMessageCounter(): void;
  export function initFrameSizeCounter(): void;
  export function initCompressionTracker(): void;
  export function initDriverFallbackTracker(): void;
  export function initAuditObserverTracker(): void;
}

declare module 'meteor/tinytest' {
  interface TinytestAssertions {
    equal(actual: unknown, expected: unknown): void;
    throws(callback: () => unknown, expected?: RegExp): void;
    isTrue(value: unknown): void;
    isFalse(value: unknown): void;
    isNotUndefined(value: unknown): void;
  }
  export const Tinytest: {
    add(name: string, callback: (test: TinytestAssertions) => void): void;
  };
}
