// Spin up the Meteor app, attach collectors, run `npx artillery` against the
// scenario's YAML config, tear down, build the result object. Caller persists.

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

export async function runArtilleryDriver({ scenario, scenarioName, app, appName, source, env, tag, config }) {
  ensureAppDeps(app.path);
  resetMeteorApp(source, app.path);

  const { gcMonitorPath, gcOutputPath } = prepareGcOutput(tag);
  console.log(`GC monitor: ${gcMonitorPath}`);
  console.log(`GC output: ${gcOutputPath}`);

  console.log('Starting Meteor app (with GC monitor)...');
  const meteorProc = startMeteorApp({
    source, appPath: app.path, port: config.appPort, env, gcMonitorPath, gcOutputPath,
  });

  console.log('Waiting for app to start...');
  const startTime = Date.now();
  await waitForApp(config.appPort);
  console.log(`App started in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  const collectors = startCollectors({ appName, gcOutputPath });

  console.log(`\nRunning Artillery: ${scenario.config}...`);
  const artilleryStart = Date.now();
  try {
    io.execFileSync('npx', ['artillery', 'run', path.resolve(HERE, '..', scenario.config)], {
      cwd: path.resolve(HERE, '..'),
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err) {
    console.error('Artillery failed:', err.message);
  }
  const wallClockMs = Date.now() - artilleryStart;

  const collectorResults = await stopCollectors(collectors);
  await stopMeteorApp(meteorProc);
  collectorResults.push(...drainPostStopGc(gcOutputPath));

  return buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteor: { version: source.version, sha: source.sha },
    collectorResults,
    wallClockMs,
  });
}
