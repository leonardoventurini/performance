// Meteor app lifecycle: install deps, reset, start, find by PID, stop.
//
// All shell-outs go through argv arrays (spawn / execFileSync), never
// template-literal exec strings — keeps user-controlled inputs like
// app paths and release versions out of shell parsing.

import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { MeteorSource } from '../lib/benchmark-types.js';
import { io } from './_io.js';
import { createRuntimeInfoExtractor } from './runtime-info-extractor.js';

function meteorArgv(source: MeteorSource, subcommandArgs: readonly string[]): string[] {
  return source.releaseArg ? [source.releaseArg, ...subcommandArgs] : [...subcommandArgs];
}

export function ensureAppDeps(source: MeteorSource, appPath: string): void {
  const nodeModules = path.join(appPath, 'node_modules');
  if (io.existsSync(nodeModules)) return;
  console.log('Installing app dependencies with Meteor npm...');
  io.execFileSync(source.meteorCmd, meteorArgv(source, ['npm', 'ci']), {
    cwd: appPath,
    stdio: 'inherit',
  });
}

export function resetMeteorApp(source: MeteorSource, appPath: string): void {
  console.log('Cleaning app state...');
  io.execFileSync(source.meteorCmd, meteorArgv(source, ['reset']), {
    cwd: appPath,
    stdio: 'inherit',
  });
}

// Returns `{ proc, getRuntimeInfo }`. The returned ChildProcess is the same
// shape callers used to get; getRuntimeInfo() returns the latest captured
// `[runtime-info]` values (observer_driver, transport) the app printed.
// `methodTimingPath` / `subTimingPath` / `propagationTimingPath` /
// `observerPoolPath` / `ddpMessagePath` / `frameSizePath` /
// `compressionPath` / `driverFallbackPath` (optional) — when set, the
// spawned Meteor sees them as METHOD_TIMING_OUTPUT / SUB_TIMING_OUTPUT
// / PROPAGATION_TIMING_OUTPUT / OBSERVER_POOL_OUTPUT / DDP_MESSAGE_OUTPUT
// / DDP_FRAME_SIZE_OUTPUT / DDP_COMPRESSION_OUTPUT / DRIVER_FALLBACK_OUTPUT
// and the matching in-app bench-monitors collector dumps to that path
// on SIGTERM. The harness reads them in stopCollectors.
export interface StartMeteorAppOptions {
  source: MeteorSource; appPath: string; port: number; env?: Readonly<Record<string, string>>;
  gcMonitorPath?: string; gcOutputPath?: string; methodTimingPath?: string; subTimingPath?: string;
  propagationTimingPath?: string; observerPoolPath?: string; ddpMessagePath?: string;
  frameSizePath?: string; compressionPath?: string; driverFallbackPath?: string;
}
export function startMeteorApp({ source, appPath, port, env = {}, gcMonitorPath, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath, frameSizePath, compressionPath, driverFallbackPath }: StartMeteorAppOptions) {
  const spawnEnv: Record<string, string | undefined> = { ...process.env, ...env, METEOR_NO_DEPRECATION: 'true' };
  if (gcMonitorPath) {
    /* PATCH-PROF: respect existing SERVER_NODE_OPTIONS (e.g. --prof passed
       via shell). Concat instead of overwrite. */
    const existing = spawnEnv.SERVER_NODE_OPTIONS ? spawnEnv.SERVER_NODE_OPTIONS + ' ' : '';
    spawnEnv.SERVER_NODE_OPTIONS = `${existing}--require ${gcMonitorPath}`;
    if (gcOutputPath) spawnEnv.GC_MONITOR_OUTPUT = gcOutputPath;
  }
  if (methodTimingPath) spawnEnv.METHOD_TIMING_OUTPUT = methodTimingPath;
  if (subTimingPath) spawnEnv.SUB_TIMING_OUTPUT = subTimingPath;
  if (propagationTimingPath) spawnEnv.PROPAGATION_TIMING_OUTPUT = propagationTimingPath;
  if (observerPoolPath) spawnEnv.OBSERVER_POOL_OUTPUT = observerPoolPath;
  if (ddpMessagePath) spawnEnv.DDP_MESSAGE_OUTPUT = ddpMessagePath;
  if (frameSizePath) spawnEnv.DDP_FRAME_SIZE_OUTPUT = frameSizePath;
  if (compressionPath) spawnEnv.DDP_COMPRESSION_OUTPUT = compressionPath;
  if (driverFallbackPath) spawnEnv.DRIVER_FALLBACK_OUTPUT = driverFallbackPath;
  const proc = io.spawn(source.meteorCmd, meteorArgv(source, ['run', '--port', String(port)]), {
    cwd: appPath,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runtime = createRuntimeInfoExtractor();
  const tee = (d: Uint8Array): void => { runtime.feed(d); process.stderr.write(d); };
  proc.stdout.on('data', tee);
  proc.stderr.on('data', tee);
  return { proc, getRuntimeInfo: runtime.get };
}

// pgrep exits 1 when there's no match. That's an "expected absence" — every
// caller (the collectors layer) treats null as "skip this collector". Catch
// here so callers don't need to.
export function findPid(pattern: string): string | null {
  try {
    const out = io.execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export async function stopMeteorApp(proc: ChildProcess | null | undefined, { graceMs = 3000 }: { graceMs?: number } = {}): Promise<void> {
  if (!proc) return;
  const hasExited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
  const waitForExit = async (): Promise<boolean> => {
    if (hasExited()) return true;
    const exited = (): void => resolveExit(true);
    let resolveExit: (exited: true) => void = () => undefined;
    const exit = new Promise<true>((resolve) => { resolveExit = resolve; });
    proc.once('exit', exited);
    const attested = await Promise.race([
      exit,
      io.sleep(graceMs).then(() => false),
    ]);
    if (!attested) proc.off('exit', exited);
    return attested;
  };

  if (!hasExited() && !proc.kill('SIGTERM') && !hasExited()) {
    throw new Error('Meteor process rejected SIGTERM before exit could be attested');
  }
  if (await waitForExit()) return;

  // Escalate only through the original ChildProcess handle. Looking up or
  // signaling its numeric PID after the grace period risks killing a reused PID.
  if (!proc.kill('SIGKILL') && !hasExited()) {
    throw new Error('Meteor process rejected SIGKILL before exit could be attested');
  }
  if (!await waitForExit()) {
    throw new Error('Meteor process did not attest exit after SIGKILL');
  }
}
