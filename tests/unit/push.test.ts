// runPush / runBaseline in cli/push.js. DDP and ws live on the io facade
// (runner/_io.ts) — same mockable seam as fs/spawn/sleep. Tests stub:
//   - io.createSimpleDdp with a fake factory returning a fake-ddp instance
//   - io.readFileSync for the result file
//   - process.exit so failure paths throw instead of terminating the runner

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { io } from '../../runner/_io.js';
import { runPush, runBaseline } from '../../cli/push.js';
import { createBenchmarkConfig } from '../../bench.config.js';
import type { BenchmarkConfig } from '../../lib/benchmark-types.js';

class ExitError extends Error {
  readonly code: string | number | null | undefined;
  constructor(code: string | number | null | undefined) { super(`process.exit(${code})`); this.code = code; }
}

let logs: string[] = [];
let errors: string[] = [];
let origLog: typeof console.log;
let origError: typeof console.error;
let origBenchKey: string | undefined;
const BASE_CONFIG = createBenchmarkConfig(import.meta.dirname, {});
const config = (overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig => ({ ...BASE_CONFIG, ...overrides });

beforeEach(() => {
  logs = [];
  errors = [];
  origLog = console.log;
  origError = console.error;
  console.log = (msg) => logs.push(String(msg));
  console.error = (msg, ...rest) => errors.push([String(msg), ...rest.map(String)].join(' '));
  mock.method(process, 'exit', (code?: string | number | null) => { throw new ExitError(code); });
  origBenchKey = process.env.BENCH_API_KEY;
  delete process.env.BENCH_API_KEY;
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
  if (origBenchKey === undefined) delete process.env.BENCH_API_KEY;
  else process.env.BENCH_API_KEY = origBenchKey;
  mock.restoreAll();
});

interface DdpCall { readonly method: string; readonly args: readonly unknown[] }
interface FakeDdpOptions { readonly endpoint: string; readonly SocketConstructor: unknown }
interface FakeDdpFactoryOptions {
  readonly callImpl?: (method: string, ...args: readonly unknown[]) => unknown | Promise<unknown>;
  readonly connectImpl?: () => void | Promise<void>;
}

function fakeDdpFactory({ callImpl, connectImpl }: FakeDdpFactoryOptions = {}) {
  const calls: DdpCall[] = [];
  let connected = false;
  let disconnected = false;
  class FakeDDP {
    static readonly calls = calls;
    static lastInstance: FakeDDP | undefined;
    readonly opts: FakeDdpOptions;
    constructor(opts: FakeDdpOptions) {
      this.opts = opts;
      FakeDDP.lastInstance = this;
    }
    async connect(): Promise<void> {
      if (connectImpl) await connectImpl();
      connected = true;
    }
    async call(method: string, ...args: readonly unknown[]): Promise<unknown> {
      calls.push({ method, args });
      return callImpl ? callImpl(method, ...args) : 'doc-id-123';
    }
    disconnect(): void { disconnected = true; }
    static wasConnected(): boolean { return connected; }
    static wasDisconnected(): boolean { return disconnected; }
  }
  return FakeDDP;
}

function installFakeDdp(factory: new (options: FakeDdpOptions) => FakeDdpInstance): void {
  mock.method(io, 'createSimpleDdp', (options: FakeDdpOptions) => new factory(options));
}

interface FakeDdpInstance { readonly opts: FakeDdpOptions }
function lastInstance(factory: { readonly lastInstance: FakeDdpInstance | undefined }): FakeDdpInstance {
  assert.ok(factory.lastInstance);
  return factory.lastInstance;
}

function lastCall(factory: { readonly calls: readonly DdpCall[] }): DdpCall {
  const call = factory.calls.at(-1);
  assert.ok(call);
  return call;
}

describe('runPush', () => {
  test('connects to URL, calls runs.insert with API key + parsed result, disconnects', async () => {
    const FakeDDP = fakeDdpFactory();
    installFakeDdp(FakeDDP);
    mock.method(io, 'readFileSync', () => JSON.stringify({ tag: 'mytag', metrics: {} }));

    await runPush({
      values: { result: '/path/to/result.json', url: 'ws://dash.example/websocket', key: 'k1' },
      config: config(),
    });

    assert.equal(lastInstance(FakeDDP).opts.endpoint, 'ws://dash.example/websocket');
    assert.equal(lastInstance(FakeDDP).opts.SocketConstructor, io.ws);
    assert.equal(FakeDDP.calls.length, 1);
    assert.equal(lastCall(FakeDDP).method, 'runs.insert');
    assert.equal(lastCall(FakeDDP).args[0], 'k1');
    assert.deepEqual(lastCall(FakeDDP).args[1], { tag: 'mytag', metrics: {} });
    assert.ok(FakeDDP.wasConnected());
    assert.ok(FakeDDP.wasDisconnected());
    assert.ok(logs.some((l) => l.includes('Document ID: doc-id-123')));
  });

  test('missing --result flag exits 1 with usage message', async () => {
    await assert.rejects(
      () => runPush({ values: {}, config: config() }),
      (err) => err instanceof ExitError && err.code === 1
    );
    assert.ok(errors.some((e) => e.includes('Usage: node bench.js push --result')));
  });

  test('URL fallback chain: flag > config.dashboardUrl > default', async () => {
    const FakeDDP = fakeDdpFactory();
    installFakeDdp(FakeDDP);
    mock.method(io, 'readFileSync', () => '{}');

    // Config wins when no flag.
    await runPush({
      values: { result: '/x' },
      config: config({ dashboardUrl: 'ws://from-config/websocket' }),
    });
    assert.equal(lastInstance(FakeDDP).opts.endpoint, 'ws://from-config/websocket');

    // Flag wins over config.
    await runPush({
      values: { result: '/x', url: 'ws://from-flag/websocket' },
      config: config({ dashboardUrl: 'ws://from-config/websocket' }),
    });
    assert.equal(lastInstance(FakeDDP).opts.endpoint, 'ws://from-flag/websocket');

    // Default when nothing set.
    await runPush({ values: { result: '/x' }, config: config({ dashboardUrl: '' }) });
    assert.equal(lastInstance(FakeDDP).opts.endpoint, 'ws://localhost:4000/websocket');
  });

  test('API-key fallback chain: flag > env.BENCH_API_KEY > config.dashboardApiKey > default', async () => {
    const FakeDDP = fakeDdpFactory();
    installFakeDdp(FakeDDP);
    mock.method(io, 'readFileSync', () => '{}');

    process.env.BENCH_API_KEY = 'k-from-env';
    await runPush({
      values: { result: '/x' },
      config: config({ dashboardApiKey: 'k-from-config' }),
    });
    assert.equal(lastCall(FakeDDP).args[0], 'k-from-env');

    await runPush({
      values: { result: '/x', key: 'k-from-flag' },
      config: config({ dashboardApiKey: 'k-from-config' }),
    });
    assert.equal(lastCall(FakeDDP).args[0], 'k-from-flag');

    delete process.env.BENCH_API_KEY;
    await runPush({
      values: { result: '/x' },
      config: config({ dashboardApiKey: 'k-from-config' }),
    });
    assert.equal(lastCall(FakeDDP).args[0], 'k-from-config');

    await runPush({ values: { result: '/x' }, config: config({ dashboardApiKey: '' }) });
    assert.equal(lastCall(FakeDDP).args[0], 'dev-bench-key-change-in-prod');
  });

  test('DDP call throwing exits 1 with "Push failed" message', async () => {
    const FakeDDP = fakeDdpFactory({
      callImpl: () => { throw new Error('boom auth fail'); },
    });
    installFakeDdp(FakeDDP);
    mock.method(io, 'readFileSync', () => '{}');

    await assert.rejects(
      () => runPush({ values: { result: '/x', url: 'ws://x' }, config: config() }),
      (err) => err instanceof ExitError && err.code === 1
    );
    assert.ok(errors.some((e) => e.includes('Push failed:') && e.includes('boom auth fail') && e.includes('ws://x')));
    // finally-block runs even on error → disconnect was called.
    assert.ok(FakeDDP.wasDisconnected());
  });
});

describe('runBaseline', () => {
  test('connects, calls baselines.set with key + scenario + runId, disconnects', async () => {
    const FakeDDP = fakeDdpFactory();
    installFakeDdp(FakeDDP);

    await runBaseline({
      values: { scenario: 'reactive-light', 'run-id': 'abc123', url: 'ws://x', key: 'k' },
      config: config(),
    });

    assert.equal(lastCall(FakeDDP).method, 'baselines.set');
    assert.deepEqual(lastCall(FakeDDP).args, ['k', 'reactive-light', 'abc123']);
    assert.ok(FakeDDP.wasDisconnected());
    assert.ok(logs.some((l) => l.includes('Baseline set successfully')));
  });

  test('accepts runId (camelCase) as an alias for run-id', async () => {
    const FakeDDP = fakeDdpFactory();
    installFakeDdp(FakeDDP);
    await runBaseline({
      values: { scenario: 's', runId: 'xyz', url: 'ws://x', key: 'k' },
      config: config(),
    });
    assert.equal(lastCall(FakeDDP).args[2], 'xyz');
  });

  test('missing --scenario exits 1 with usage', async () => {
    await assert.rejects(
      () => runBaseline({ values: { 'run-id': 'x' }, config: config() }),
      (err) => err instanceof ExitError && err.code === 1
    );
    assert.ok(errors.some((e) => e.includes('Usage: node bench.js baseline --scenario')));
  });

  test('missing --run-id exits 1 with usage', async () => {
    await assert.rejects(
      () => runBaseline({ values: { scenario: 's' }, config: config() }),
      (err) => err instanceof ExitError && err.code === 1
    );
    assert.ok(errors.some((e) => e.includes('--scenario <name> --run-id <id>')));
  });

  test('DDP call throwing exits 1 with "Failed:" message; disconnect still runs', async () => {
    const FakeDDP = fakeDdpFactory({
      callImpl: () => { throw new Error('network down'); },
    });
    installFakeDdp(FakeDDP);

    await assert.rejects(
      () => runBaseline({
        values: { scenario: 's', 'run-id': 'r', url: 'ws://x', key: 'k' },
        config: config(),
      }),
      (err) => err instanceof ExitError && err.code === 1
    );
    assert.ok(errors.some((e) => e.includes('Setting baseline failed:') && e.includes('network down') && e.includes('ws://x')));
    assert.ok(FakeDDP.wasDisconnected());
  });
});
