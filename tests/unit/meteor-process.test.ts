// Lifecycle helpers in runner/meteor-process.js. All shell-outs and fs reads
// go through the `io` object exported from runner/_io.js, so tests stub them
// with mock.method at that single seam.

import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { io } from '../../runner/_io.js';
import type { MeteorSource } from '../../lib/benchmark-types.js';
import {
  ensureAppDeps,
  resetMeteorApp,
  startMeteorApp,
  findPid,
  stopMeteorApp,
} from '../../runner/meteor-process.js';

afterEach(() => mock.restoreAll());

const SYSTEM_SOURCE: MeteorSource = { mode: 'system', meteorCmd: 'meteor', releaseArg: null, checkoutPath: null, version: 'system', sha: 'unknown' };
const CHECKOUT_SOURCE: MeteorSource = { mode: 'checkout', meteorCmd: '/checkout/meteor', releaseArg: null, checkoutPath: '/checkout', version: 'test', sha: 'test' };
const RELEASE_SOURCE: MeteorSource = { mode: 'release', meteorCmd: 'meteor', releaseArg: '--release=3.1.2', checkoutPath: null, version: '3.1.2', sha: 'release:3.1.2' };
interface ExecCall { readonly cmd: string; readonly args: readonly string[]; readonly opts: Record<string, unknown> | undefined }
interface SpawnOptions { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
interface SpawnCall { readonly cmd: string; readonly args: readonly string[]; readonly opts: SpawnOptions }

describe('ensureAppDeps', () => {
  const source = CHECKOUT_SOURCE;

  test('skips Meteor npm when node_modules already exists', () => {
    mock.method(io, 'existsSync', () => true);
    const spy = mock.method(io, 'execFileSync', () => '');
    ensureAppDeps(source, '/some/app');
    assert.equal(spy.mock.callCount(), 0);
  });

  test('runs meteor npm ci via execFileSync when node_modules is missing', () => {
    mock.method(io, 'existsSync', () => false);
    const calls: ExecCall[] = [];
    mock.method(io, 'execFileSync', (cmd: string, args: readonly string[], opts?: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return '';
    });
    ensureAppDeps(source, '/path/to/app');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cmd, '/checkout/meteor');
    assert.deepEqual(calls[0]?.args, ['npm', 'ci']);
    assert.equal(calls[0]?.opts?.cwd, '/path/to/app');
    assert.equal(calls[0]?.opts?.stdio, 'inherit');
  });

  test('pins Meteor npm to the requested published release', () => {
    mock.method(io, 'existsSync', () => false);
    const calls: ExecCall[] = [];
    mock.method(io, 'execFileSync', (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args, opts: undefined });
      return '';
    });
    ensureAppDeps({ ...RELEASE_SOURCE, releaseArg: '--release=3.5.1-beta.0', version: '3.5.1-beta.0', sha: 'release:3.5.1-beta.0' }, '/path/to/app');
    assert.deepEqual(calls[0], {
      cmd: 'meteor',
      args: ['--release=3.5.1-beta.0', 'npm', 'ci'],
      opts: undefined,
    });
  });

  test('checks for the node_modules path inside appPath', () => {
    const checked: string[] = [];
    mock.method(io, 'existsSync', (p: string) => { checked.push(p); return true; });
    ensureAppDeps(source, '/my/app');
    assert.equal(checked[0], path.join('/my/app', 'node_modules'));
  });
});

describe('resetMeteorApp', () => {
  test('spawns meteorCmd with ["reset"] and appPath as cwd (checkout/system source)', () => {
    const calls: ExecCall[] = [];
    mock.method(io, 'execFileSync', (cmd: string, args: readonly string[], opts?: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return '';
    });
    resetMeteorApp(
      { ...CHECKOUT_SOURCE, meteorCmd: '/path/to/meteor' },
      '/path/to/app'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cmd, '/path/to/meteor');
    assert.deepEqual(calls[0]?.args, ['reset']);
    assert.equal(calls[0]?.opts?.cwd, '/path/to/app');
    assert.equal(calls[0]?.opts?.stdio, 'inherit');
  });

  test('prepends --release=<version> when source is release-mode', () => {
    const calls: ExecCall[] = [];
    mock.method(io, 'execFileSync', (cmd: string, args: readonly string[]) => { calls.push({ cmd, args, opts: undefined }); return ''; });
    resetMeteorApp(
      RELEASE_SOURCE,
      '/some/app'
    );
    assert.equal(calls[0]?.cmd, 'meteor');
    assert.deepEqual(calls[0]?.args, ['--release=3.1.2', 'reset']);
  });
});

describe('startMeteorApp', () => {
  // Tiny event-emitter that records the `data` handler so tests can simulate
  // the spawned process emitting stderr/stdout chunks.
  function fakeStream(): PassThrough { return new PassThrough(); }
  function fakeProc({ stdout = fakeStream(), stderr = fakeStream() }: { readonly stdout?: PassThrough; readonly stderr?: PassThrough } = {}): ChildProcess {
    const proc = new ChildProcess();
    Object.defineProperty(proc, 'pid', { value: 12345 });
    proc.kill = (): boolean => true;
    proc.stdout = stdout;
    proc.stderr = stderr;
    return proc;
  }

  test('spawns meteorCmd with run+port argv and returns the proc handle', () => {
    let captured: SpawnCall | undefined;
    mock.method(io, 'spawn', (cmd: string, args: readonly string[], opts: SpawnOptions) => {
      captured = { cmd, args, opts };
      return fakeProc();
    });
    const { proc, getRuntimeInfo } = startMeteorApp({
      source: { ...CHECKOUT_SOURCE, meteorCmd: '/path/to/meteor' },
      appPath: '/my/app',
      port: 3000,
    });
    assert.ok(captured);
    assert.equal(captured.cmd, '/path/to/meteor');
    assert.deepEqual(captured.args, ['run', '--port', '3000']);
    assert.equal(captured.opts.cwd, '/my/app');
    assert.equal(captured.opts.env?.METEOR_NO_DEPRECATION, 'true');
    assert.equal(proc.pid, 12345);
    assert.equal(typeof getRuntimeInfo, 'function');
    assert.deepEqual(getRuntimeInfo(), {});
  });

  test('getRuntimeInfo captures [runtime-info] lines emitted on stderr', () => {
    const stderr = fakeStream();
    mock.method(io, 'spawn', () => fakeProc({ stderr }));
    const { getRuntimeInfo } = startMeteorApp({
      source: SYSTEM_SOURCE,
      appPath: '/app', port: 3000,
    });
    stderr.emit('data', '=> Meteor server running\n');
    stderr.emit('data', '[runtime-info] observer_driver=oplog\n');
    stderr.emit('data', '[runtime-info] transport=uws\n');
    assert.deepEqual(getRuntimeInfo(), { observer_driver: 'oplog', transport: 'uws' });
  });

  test('getRuntimeInfo also captures lines emitted on stdout', () => {
    const stdout = fakeStream();
    mock.method(io, 'spawn', () => fakeProc({ stdout }));
    const { getRuntimeInfo } = startMeteorApp({
      source: SYSTEM_SOURCE,
      appPath: '/app', port: 3000,
    });
    stdout.emit('data', '[runtime-info] observer_driver=changeStreams\n');
    assert.deepEqual(getRuntimeInfo(), { observer_driver: 'changeStreams' });
  });

  test('prepends --release arg when source is release-mode', () => {
    let capturedArgs: readonly string[] = [];
    mock.method(io, 'spawn', (_cmd: string, args: readonly string[]) => { capturedArgs = args; return fakeProc(); });
    startMeteorApp({
      source: RELEASE_SOURCE,
      appPath: '/app', port: 3000,
    });
    assert.deepEqual(capturedArgs, ['--release=3.1.2', 'run', '--port', '3000']);
  });

  test('sets SERVER_NODE_OPTIONS + GC_MONITOR_OUTPUT when gcMonitorPath + gcOutputPath provided', () => {
    let captured: SpawnOptions | undefined;
    mock.method(io, 'spawn', (_cmd: string, _args: readonly string[], opts: SpawnOptions) => { captured = opts; return fakeProc(); });
    startMeteorApp({
      source: SYSTEM_SOURCE,
      appPath: '/app',
      port: 3000,
      gcMonitorPath: '/path/to/gc-monitor.cjs',
      gcOutputPath: '/tmp/gc-out.json',
    });
    assert.ok(captured);
    assert.equal(captured.env?.SERVER_NODE_OPTIONS, '--require /path/to/gc-monitor.cjs');
    assert.equal(captured.env?.GC_MONITOR_OUTPUT, '/tmp/gc-out.json');
  });

  test('omits GC env vars when gcMonitorPath is not provided (cold-start scenarios)', () => {
    let captured: SpawnOptions | undefined;
    mock.method(io, 'spawn', (_cmd: string, _args: readonly string[], opts: SpawnOptions) => { captured = opts; return fakeProc(); });
    startMeteorApp({
      source: SYSTEM_SOURCE,
      appPath: '/app',
      port: 3000,
    });
    assert.ok(captured);
    assert.equal(captured.env?.SERVER_NODE_OPTIONS, undefined);
    assert.equal(captured.env?.GC_MONITOR_OUTPUT, undefined);
  });

  test('merges caller env into spawn env (custom MONGO_URL etc.)', () => {
    let captured: SpawnOptions | undefined;
    mock.method(io, 'spawn', (_cmd: string, _args: readonly string[], opts: SpawnOptions) => { captured = opts; return fakeProc(); });
    startMeteorApp({
      source: SYSTEM_SOURCE,
      appPath: '/app',
      port: 3000,
      env: { MONGO_URL_TASKS_3_X: 'mongodb://x:27017/y' },
    });
    assert.ok(captured);
    assert.equal(captured.env?.MONGO_URL_TASKS_3_X, 'mongodb://x:27017/y');
  });
});

describe('findPid', () => {
  test('returns the first pid from pgrep -f <pattern>', () => {
    const calls: ExecCall[] = [];
    mock.method(io, 'execFileSync', (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args, opts: undefined });
      return 'pid1\npid2\npid3\n';
    });
    const pid = findPid('app/.meteor/local/build/main.js');
    assert.equal(pid, 'pid1');
    assert.equal(calls[0]?.cmd, 'pgrep');
    assert.deepEqual(calls[0]?.args, ['-f', 'app/.meteor/local/build/main.js']);
  });

  test('returns null when pgrep exits non-zero (no match)', () => {
    mock.method(io, 'execFileSync', () => {
      const err = new Error('pgrep exit 1');
      throw err;
    });
    assert.equal(findPid('nonexistent-pattern'), null);
  });

  test('returns null on empty stdout (defensive — pgrep can theoretically succeed with no output)', () => {
    mock.method(io, 'execFileSync', () => '\n');
    assert.equal(findPid('whatever'), null);
  });
});

describe('stopMeteorApp', () => {
  test('SIGTERMs the proc and awaits sleep(graceMs=3000) by default', async () => {
    const sleeps: number[] = [];
    mock.method(io, 'sleep', (ms: number) => { sleeps.push(ms); return Promise.resolve(); });
    let killed: NodeJS.Signals | number | undefined;
    const proc = new ChildProcess();
    proc.kill = (sig?: NodeJS.Signals | number): boolean => {
      killed = sig;
      queueMicrotask(() => proc.emit('exit', 0, sig));
      return true;
    };
    await stopMeteorApp(proc);
    assert.equal(killed, 'SIGTERM');
    assert.deepEqual(sleeps, [3000]);
  });

  test('honors a custom graceMs', async () => {
    const sleeps: number[] = [];
    mock.method(io, 'sleep', (ms: number) => { sleeps.push(ms); return Promise.resolve(); });
    const proc = new ChildProcess();
    proc.kill = (signal?: NodeJS.Signals | number): boolean => {
      queueMicrotask(() => proc.emit('exit', 0, signal));
      return true;
    };
    await stopMeteorApp(proc, { graceMs: 500 });
    assert.deepEqual(sleeps, [500]);
  });

  test('no-op when proc is null/undefined (defensive)', async () => {
    const sleeps: number[] = [];
    mock.method(io, 'sleep', (ms: number) => { sleeps.push(ms); return Promise.resolve(); });
    await stopMeteorApp(null);
    await stopMeteorApp(undefined);
    assert.deepEqual(sleeps, []);
  });

  test('escalates through the same process handle when SIGTERM does not produce an exit', async () => {
    mock.method(io, 'sleep', () => Promise.resolve());
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const proc = new ChildProcess();
    proc.kill = (signal?: NodeJS.Signals | number): boolean => {
      signals.push(signal);
      if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('exit', null, 'SIGKILL'));
      return true;
    };

    await stopMeteorApp(proc, { graceMs: 1 });
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });

  test('rejects when exit cannot be attested after escalation', async () => {
    mock.method(io, 'sleep', () => Promise.resolve());
    const proc = new ChildProcess();
    proc.kill = (): boolean => true;
    await assert.rejects(stopMeteorApp(proc, { graceMs: 1 }), /did not attest exit after SIGKILL/);
  });
});
