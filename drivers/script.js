// Spin up the Meteor app, attach collectors, run a Node script (e.g.
// tests/fanout-bench.js), parse its last-line JSON as fanout metrics, tear
// down, build the result object. Caller persists.

import path from 'node:path';
import { io } from '../runner/_io.js';
import {
  ensureAppDeps,
  resetMeteorApp,
  startMeteorApp,
  stopMeteorApp,
} from '../runner/meteor-process.js';
import { waitForApp } from '../runner/wait-for-app.js';
import {
  prepareGcOutput,
  startCollectors,
  stopCollectors,
  drainPostStopGc,
} from '../runner/collectors.js';
import { buildResult } from '../reporters/json-reporter.js';

const HERE = import.meta.dirname;
const SCRIPT_TIMEOUT_MS = 300_000;

export async function runScriptDriver({ scenario, scenarioName, app, appName, source, env, tag, config }) {
  ensureAppDeps(app.path);
  resetMeteorApp(source, app.path);

  const { gcMonitorPath, gcOutputPath } = prepareGcOutput(tag);

  console.log('Starting Meteor app...');
  const meteorProc = startMeteorApp({
    source, appPath: app.path, port: config.appPort, env, gcMonitorPath, gcOutputPath,
  });

  console.log('Waiting for app to start...');
  await waitForApp(config.appPort);
  console.log('App started.');

  const collectors = startCollectors({ appName, gcOutputPath });

  const scriptPath = path.resolve(HERE, '..', scenario.script);
  const scriptArgs = (scenario.args || '').split(/\s+/).filter(Boolean);
  console.log(`\nRunning: node ${scenario.script} ${scenario.args || ''}\n`);

  const scriptStart = Date.now();
  let scriptOutput = '';
  try {
    scriptOutput = io.execFileSync('node', [scriptPath, ...scriptArgs], {
      cwd: path.resolve(HERE, '..'),
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SCRIPT_TIMEOUT_MS,
    });
  } catch (err) {
    console.error('Script failed:', err.stderr || err.message);
    scriptOutput = err.stdout || '';
  }
  const wallClockMs = Date.now() - scriptStart;

  let scriptMetrics = {};
  const jsonLine = scriptOutput.trim().split('\n').pop();
  if (jsonLine) {
    try { scriptMetrics = JSON.parse(jsonLine); } catch {}
  }

  const collectorResults = await stopCollectors(collectors);
  await stopMeteorApp(meteorProc);
  collectorResults.push(...drainPostStopGc(gcOutputPath));
  collectorResults.push({ metric: 'fanout', ...scriptMetrics });

  if (scriptMetrics.fanout_avg_ms) {
    console.log(`Fanout: avg=${scriptMetrics.fanout_avg_ms}ms p50=${scriptMetrics.fanout_p50_ms}ms p95=${scriptMetrics.fanout_p95_ms}ms max=${scriptMetrics.fanout_max_ms}ms`);
  }

  return buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteor: { version: source.version, sha: source.sha },
    collectorResults,
    wallClockMs,
  });
}
