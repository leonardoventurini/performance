// Spawn the process-monitor collectors for APP + DB pids, then on stop
// SIGTERM + drain + parse their JSON output. GC metrics are read from the
// gc-monitor output file that the in-process collector dumps on Meteor's
// SIGTERM.
//
// Each collector self-identifies via its `metric` field — `app_resources`,
// `db_resources`, `gc` — which is what the dashboard's result-JSON contract
// reads. No key renaming here; we trust the collectors' output and pass it
// through.

import path from 'node:path';
import { io } from './_io.js';
import { findPid } from './meteor-process.js';

const HERE = import.meta.dirname;
const PROCESS_MONITOR = path.resolve(HERE, '..', 'collectors', 'process-monitor.js');
const COLLECTOR_DRAIN_MS = 1000;

function spawnProcessMonitor(pid, name) {
  const proc = io.spawn('node', [PROCESS_MONITOR, pid, name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name, getResult: () => stdout };
}

export function startCollectors({ appName, gcOutputPath }) {
  const procs = [];

  const appPid = findPid(`${appName}/.meteor/local/build/main.js`);
  if (appPid) {
    procs.push(spawnProcessMonitor(appPid, 'APP'));
  } else {
    console.error(`No APP pid found for ${appName}; skipping app_resources collector.`);
  }

  const dbPid = findPid(`${appName}/.meteor/local/db`);
  if (dbPid) {
    procs.push(spawnProcessMonitor(dbPid, 'DB'));
  } else {
    console.error(`No DB pid found for ${appName}; skipping db_resources collector.`);
  }

  return { procs, gcOutputPath };
}

export async function stopCollectors({ procs, gcOutputPath }) {
  const results = [];

  for (const { proc, name, getResult } of procs) {
    proc.kill('SIGTERM');
    await io.sleep(COLLECTOR_DRAIN_MS);
    const raw = getResult().trim();
    if (!raw) continue;
    try {
      results.push(JSON.parse(raw));
    } catch (err) {
      console.error(`Dropping malformed JSON from ${name} collector: ${err.message}`);
    }
  }

  if (gcOutputPath && io.existsSync(gcOutputPath)) {
    try {
      const gcData = JSON.parse(io.readFileSync(gcOutputPath, 'utf8'));
      results.push(gcData);
      console.log(`GC: ${gcData.count} collections, ${gcData.total_pause_ms}ms total pause, ${gcData.max_pause_ms}ms max`);
      if (gcData.minor && gcData.major) {
        console.log(`  Minor: ${gcData.minor.count} (${gcData.minor.total_ms}ms) | Major: ${gcData.major.count} (${gcData.major.total_ms}ms)`);
      }
      io.unlinkSync(gcOutputPath);
    } catch (err) {
      console.error(`Could not read GC metrics from ${gcOutputPath}: ${err.message}`);
    }
  }

  return results;
}
