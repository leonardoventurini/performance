// Meteor app lifecycle: install deps, reset, start, find by PID, stop.
//
// All shell-outs go through argv arrays (spawn / execFileSync), never
// template-literal exec strings — keeps user-controlled inputs like
// app paths and release versions out of shell parsing.

import path from 'node:path';
import { io } from './_io.js';

function meteorArgv(source, subcommandArgs) {
  return source.releaseArg ? [source.releaseArg, ...subcommandArgs] : subcommandArgs;
}

export function ensureAppDeps(appPath) {
  const nodeModules = path.join(appPath, 'node_modules');
  if (io.existsSync(nodeModules)) return;
  console.log('Installing app npm dependencies...');
  io.execFileSync('npm', ['install'], { cwd: appPath, stdio: 'inherit' });
}

export function resetMeteorApp(source, appPath) {
  console.log('Cleaning app state...');
  io.execFileSync(source.meteorCmd, meteorArgv(source, ['reset']), {
    cwd: appPath,
    stdio: 'inherit',
  });
}

export function startMeteorApp({ source, appPath, port, env = {}, gcMonitorPath, gcOutputPath }) {
  const spawnEnv = { ...process.env, ...env, METEOR_NO_DEPRECATION: 'true' };
  if (gcMonitorPath) {
    spawnEnv.SERVER_NODE_OPTIONS = `--require ${gcMonitorPath}`;
    if (gcOutputPath) spawnEnv.GC_MONITOR_OUTPUT = gcOutputPath;
  }
  const proc = io.spawn(source.meteorCmd, meteorArgv(source, ['run', '--port', String(port)]), {
    cwd: appPath,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stderr.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));
  return proc;
}

// pgrep exits 1 when there's no match. That's an "expected absence" — every
// caller (the collectors layer) treats null as "skip this collector". Catch
// here so callers don't need to.
export function findPid(pattern) {
  try {
    const out = io.execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export async function stopMeteorApp(proc, { graceMs = 3000 } = {}) {
  if (!proc) return;
  proc.kill('SIGTERM');
  await io.sleep(graceMs);
}
