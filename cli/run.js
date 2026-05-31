// `bench.js run` — validates scenario+app, picks a driver, persists the
// result. Owns the inline splitEnvArgs helper (the only consumer is here).

import path from 'node:path';
import { resolveMeteorSource } from '../meteor-source.js';
import { writeResult, appendToHistory } from '../reporters/json-reporter.js';
import { drivers } from '../drivers/index.js';

export function splitEnvArgs(rawEnvArray) {
  const out = {};
  if (!rawEnvArray) return out;
  const list = Array.isArray(rawEnvArray) ? rawEnvArray : [rawEnvArray];
  for (const e of list) {
    const idx = e.indexOf('=');
    if (idx > 0) out[e.slice(0, idx)] = e.slice(idx + 1);
  }
  return out;
}

function exitUnknown(kind, name, validNames) {
  console.error(`Unknown ${kind}: ${name}`);
  console.error(`Available ${kind}s: ${validNames.join(', ')}`);
  process.exit(1);
}

function pickDriver(scenarioName, scenario) {
  if (scenario.driver === 'script') return drivers.runScriptDriver;
  if (scenario.driver === 'artillery' || scenario.driver === 'artillery-playwright') {
    return drivers.runArtilleryDriver;
  }
  if (scenario.driver === 'cli') {
    if (scenarioName === 'cold-start') return drivers.runColdStartDriver;
    if (scenarioName === 'bundle-size') return drivers.runBundleSizeDriver;
    return null;
  }
  return null;
}

export async function runBenchmark({ values, config }) {
  const source = resolveMeteorSource({ flags: values, env: process.env, config });
  const extraEnv = splitEnvArgs(values.env);
  const scenarioName = values.scenario || 'reactive-light';
  const appName = values.app || config.defaultApp;
  const tag = values.tag || source.version;
  const outputPath = values.output || path.join(config.results.dir, `${scenarioName}-${tag}-${Date.now()}.json`);

  const scenario = config.scenarios[scenarioName];
  if (!scenario) exitUnknown('scenario', scenarioName, Object.keys(config.scenarios));
  const app = config.apps[appName];
  if (!app) exitUnknown('app', appName, Object.keys(config.apps));

  console.log(`\n🔧 Benchmark: ${scenarioName}`);
  console.log(`   App: ${appName}`);
  console.log(`   Meteor: ${source.version} (${source.sha})`);
  console.log(`   Tag: ${tag}`);
  if (Object.keys(extraEnv).length > 0) {
    console.log(`   Env: ${Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');

  const driver = pickDriver(scenarioName, scenario);
  if (!driver) {
    console.log(`CLI scenario "${scenarioName}" — not yet implemented.`);
    process.exit(0);
  }

  const runs = scenarioName === 'cold-start' ? parseInt(values.runs || '3', 10) : undefined;
  const result = await driver({
    scenario, scenarioName, app, appName, source, env: extraEnv, tag, config, runs,
  });

  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`\nResults written to: ${outputPath}`);
  console.log(`Wall clock: ${(result.wall_clock_ms / 1000).toFixed(1)}s`);

  for (const r of Object.values(result.metrics)) {
    if (r.cpu) console.log(`${r.name} CPU: avg ${r.cpu.avg}% max ${r.cpu.max}%`);
    if (r.memory) console.log(`${r.name} RAM: avg ${r.memory.avg_mb}MB max ${r.memory.max_mb}MB`);
  }
}
