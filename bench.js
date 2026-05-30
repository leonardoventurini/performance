#!/usr/bin/env node

/**
 * Meteor Benchmark Framework — CLI
 *
 * Usage:
 *   node bench.js run [--scenario <name>] [--app <name>] [--tag <label>]
 *   node bench.js compare --baseline <file> --target <file> [--format markdown|json]
 *   node bench.js list
 *
 * For version comparison:
 *   1. cd $METEOR_CHECKOUT_PATH && git checkout release/3.5
 *   2. node bench.js run --tag v3.5 --output results/v3.5.json
 *   3. cd $METEOR_CHECKOUT_PATH && git checkout devel
 *   4. node bench.js run --tag devel --output results/devel.json
 *   5. node bench.js compare --baseline results/v3.5.json --target results/devel.json
 */

import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import SimpleDDP from 'simpleddp';
import ws from 'ws';
import config from './bench.config.js';
import { resolveMeteorSource } from './meteor-source.js';
import { buildResult, writeResult, appendToHistory } from './reporters/json-reporter.js';
import { compare, toMarkdown } from './reporters/regression-detector.js';

const __dirname = import.meta.dirname;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    scenario: { type: 'string' },
    app: { type: 'string' },
    tag: { type: 'string' },
    output: { type: 'string' },
    runs: { type: 'string' },
    env: { type: 'string', multiple: true },
    baseline: { type: 'string' },
    target: { type: 'string' },
    format: { type: 'string' },
    result: { type: 'string' },
    url: { type: 'string' },
    key: { type: 'string' },
    'run-id': { type: 'string' },
    runId: { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
});
const command = positionals[0];

function splitEnvArgs(rawEnvArray) {
  const out = {};
  if (!rawEnvArray) return out;
  const list = Array.isArray(rawEnvArray) ? rawEnvArray : [rawEnvArray];
  for (const e of list) {
    const idx = e.indexOf('=');
    if (idx > 0) out[e.slice(0, idx)] = e.slice(idx + 1);
  }
  return out;
}
const extraEnv = splitEnvArgs(values.env);

function resolveSource() {
  return resolveMeteorSource({ flags: values, env: process.env, config });
}

function waitForApp(port, timeoutSec = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}`, { encoding: 'utf8' });
      return true;
    } catch {
      execSync('sleep 1');
    }
  }
  throw new Error(`App did not start within ${timeoutSec}s`);
}

function getPid(pattern) {
  try {
    return execSync(`pgrep -f "${pattern}"`, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

// ─── Commands ────────────────────────────────────────────────────────

function cmdList() {
  console.log('\nAvailable scenarios:');
  for (const [name, s] of Object.entries(config.scenarios)) {
    console.log(`  ${name.padEnd(20)} ${s.description}`);
  }
  console.log('\nAvailable apps:');
  for (const [name, a] of Object.entries(config.apps)) {
    console.log(`  ${name.padEnd(20)} ${a.description}`);
  }
  const source = resolveSource();
  console.log(`\nMeteor source: ${source.mode}`);
  if (source.mode === 'checkout') console.log(`  Checkout: ${source.checkoutPath}`);
  console.log(`  Version: ${source.version}  SHA: ${source.sha}\n`);
}

async function cmdRun() {
  const source = resolveSource();
  const scenarioName = values.scenario || 'reactive-crud';
  const appName = values.app || config.defaultApp;
  const tag = values.tag || source.version;
  const outputPath = values.output || path.join(config.results.dir, `${scenarioName}-${tag}-${Date.now()}.json`);

  const scenario = config.scenarios[scenarioName];
  const app = config.apps[appName];
  if (!scenario) { console.error(`Unknown scenario: ${scenarioName}`); process.exit(1); }
  if (!app) { console.error(`Unknown app: ${appName}`); process.exit(1); }

  console.log(`\n🔧 Benchmark: ${scenarioName}`);
  console.log(`   App: ${appName}`);
  console.log(`   Meteor: ${source.version} (${source.sha})`);
  console.log(`   Tag: ${tag}`);
  if (Object.keys(extraEnv).length > 0) {
    console.log(`   Env: ${Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');

  if (scenario.driver === 'script') {
    return cmdScript({ scenarioName, scenario, appName, app, tag, outputPath, source });
  }

  if (scenario.driver === 'cli') {
    if (scenarioName === 'cold-start') {
      return cmdColdStart({ scenarioName, appName, app, tag, outputPath, source });
    }
    if (scenarioName === 'bundle-size') {
      return cmdBundleSize({ scenarioName, appName, app, tag, outputPath, source });
    }
    console.log(`CLI scenario "${scenarioName}" — not yet implemented.`);
    process.exit(0);
  }

  // Install app npm deps if needed
  const nodeModulesPath = path.join(app.path, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('Installing app npm dependencies...');
    execSync('npm install', { cwd: app.path, stdio: 'inherit' });
  }

  // Clean and start Meteor app
  const meteorCmd = source.meteorCmd;
  console.log('Cleaning app state...');
  execSync(`${meteorCmd} reset`, { cwd: app.path, stdio: 'inherit' });

  // GC monitor: inject into Meteor's server process via SERVER_NODE_OPTIONS
  const gcMonitorPath = path.resolve(__dirname, 'collectors/gc-monitor.cjs');
  const resultsDir = path.resolve(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const gcOutputPath = path.join(resultsDir, `gc-${tag}-${Date.now()}.json`);
  const serverNodeOptions = `--require ${gcMonitorPath}`;
  console.log(`GC monitor: ${gcMonitorPath}`);
  console.log(`GC output: ${gcOutputPath}`);

  console.log(`Starting Meteor app (with GC monitor)...`);
  console.log(`SERVER_NODE_OPTIONS=${serverNodeOptions}`);
  const meteorProc = spawn(meteorCmd, ['run', '--port', String(config.appPort)], {
    cwd: app.path,
    env: {
      ...process.env, ...extraEnv,
      SERVER_NODE_OPTIONS: serverNodeOptions,
      GC_MONITOR_OUTPUT: gcOutputPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Log meteor output to stderr
  meteorProc.stdout.on('data', (d) => process.stderr.write(d));
  meteorProc.stderr.on('data', (d) => process.stderr.write(d));

  console.log('Waiting for app to start...');
  const startTime = Date.now();
  waitForApp(config.appPort);
  const startupMs = Date.now() - startTime;
  console.log(`App started in ${(startupMs / 1000).toFixed(1)}s`);

  // Start collectors
  const collectorProcs = [];
  const collectorResults = [];

  // Process monitor for app
  const appPid = getPid(`${appName}/.meteor/local/build/main.js`);
  if (appPid) {
    const proc = spawn('node', [path.resolve(__dirname, 'collectors/process-monitor.js'), appPid, 'APP'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    collectorProcs.push({ proc, getResult: () => stdout });
  }

  // Process monitor for MongoDB
  const dbPid = getPid(`${appName}/.meteor/local/db`);
  if (dbPid) {
    const proc = spawn('node', [path.resolve(__dirname, 'collectors/process-monitor.js'), dbPid, 'DB'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    collectorProcs.push({ proc, getResult: () => stdout });
  }

  // Run Artillery
  console.log(`\nRunning Artillery: ${scenario.config}...`);
  const artilleryStart = Date.now();
  try {
    execSync(`npx artillery run "${path.resolve(__dirname, scenario.config)}"`, {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err) {
    console.error('Artillery failed:', err.message);
  }
  const wallClockMs = Date.now() - artilleryStart;

  // Stop collectors and gather results
  for (const { proc, getResult } of collectorProcs) {
    proc.kill('SIGTERM');
    // Give collector time to output
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const raw = getResult().trim();
    if (raw) {
      try { collectorResults.push(JSON.parse(raw)); } catch {}
    }
  }

  // Stop Meteor (SIGTERM triggers gc-monitor output)
  meteorProc.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Collect GC metrics from output file
  if (fs.existsSync(gcOutputPath)) {
    try {
      const gcData = JSON.parse(fs.readFileSync(gcOutputPath, 'utf8'));
      collectorResults.push(gcData);
      console.log(`GC: ${gcData.count} collections, ${gcData.total_pause_ms}ms total pause, ${gcData.max_pause_ms}ms max`);
      console.log(`  Minor: ${gcData.minor.count} (${gcData.minor.total_ms}ms) | Major: ${gcData.major.count} (${gcData.major.total_ms}ms)`);
      fs.unlinkSync(gcOutputPath); // cleanup temp file
    } catch (err) {
      console.error('Could not read GC metrics:', err.message);
    }
  } else {
    console.log(`GC metrics not collected — file not found: ${gcOutputPath}`);
    // List results dir to debug
    try {
      const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('gc-'));
      if (files.length > 0) console.log(`  Found GC files: ${files.join(', ')}`);
    } catch {}
  }

  // Build and write result
  const result = buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteor: { version: source.version, sha: source.sha },
    collectorResults,
    wallClockMs,
  });

  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`\nResults written to: ${outputPath}`);
  console.log(`Wall clock: ${(wallClockMs / 1000).toFixed(1)}s`);

  for (const r of collectorResults) {
    if (r.cpu) console.log(`${r.name} CPU: avg ${r.cpu.avg}% max ${r.cpu.max}%`);
    if (r.memory) console.log(`${r.name} RAM: avg ${r.memory.avg_mb}MB max ${r.memory.max_mb}MB`);
  }
}

async function cmdScript({ scenarioName, scenario, appName, app, tag, outputPath, source }) {
  const meteorCmd = source.meteorCmd;

  // Install app npm deps if needed
  const nodeModulesPath = path.join(app.path, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('Installing app npm dependencies...');
    execSync('npm install', { cwd: app.path, stdio: 'inherit' });
  }

  // Clean and start Meteor app
  console.log('Cleaning app state...');
  execSync(`${meteorCmd} reset`, { cwd: app.path, stdio: 'inherit' });

  // GC monitor
  const gcMonitorPath = path.resolve(__dirname, 'collectors/gc-monitor.cjs');
  const resultsDir = path.resolve(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const gcOutputPath = path.join(resultsDir, `gc-${tag}-${Date.now()}.json`);

  console.log('Starting Meteor app...');
  const meteorProc = spawn(meteorCmd, ['run', '--port', String(config.appPort)], {
    cwd: app.path,
    env: {
      ...process.env, ...extraEnv,
      SERVER_NODE_OPTIONS: `--require ${gcMonitorPath}`,
      GC_MONITOR_OUTPUT: gcOutputPath,
      METEOR_NO_DEPRECATION: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  meteorProc.stdout.on('data', (d) => process.stderr.write(d));
  meteorProc.stderr.on('data', (d) => process.stderr.write(d));

  console.log('Waiting for app to start...');
  waitForApp(config.appPort);
  console.log('App started.');

  // Start process collectors
  const collectorProcs = [];
  const collectorResults = [];

  const appPid = getPid(`${appName}/.meteor/local/build/main.js`);
  if (appPid) {
    const proc = spawn('node', [path.resolve(__dirname, 'collectors/process-monitor.js'), appPid, 'APP'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    collectorProcs.push({ proc, getResult: () => stdout });
  }

  const dbPid = getPid(`${appName}/.meteor/local/db`);
  if (dbPid) {
    const proc = spawn('node', [path.resolve(__dirname, 'collectors/process-monitor.js'), dbPid, 'DB'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    collectorProcs.push({ proc, getResult: () => stdout });
  }

  // Run the benchmark script
  const scriptPath = path.resolve(__dirname, scenario.script);
  const scriptArgs = scenario.args || '';
  console.log(`\nRunning: node ${scenario.script} ${scriptArgs}\n`);

  const artilleryStart = Date.now();
  let scriptOutput = '';
  try {
    scriptOutput = execSync(`node "${scriptPath}" ${scriptArgs}`, {
      cwd: __dirname,
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
  } catch (err) {
    console.error('Script failed:', err.stderr || err.message);
    scriptOutput = err.stdout || '';
  }
  const wallClockMs = Date.now() - artilleryStart;

  // Parse script JSON output
  let scriptMetrics = {};
  const jsonLine = scriptOutput.trim().split('\n').pop();
  if (jsonLine) {
    try { scriptMetrics = JSON.parse(jsonLine); } catch {}
  }

  // Stop collectors
  for (const { proc, getResult } of collectorProcs) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const raw = getResult().trim();
    if (raw) {
      try { collectorResults.push(JSON.parse(raw)); } catch {}
    }
  }

  // Stop Meteor
  meteorProc.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Collect GC metrics
  if (fs.existsSync(gcOutputPath)) {
    try {
      const gcData = JSON.parse(fs.readFileSync(gcOutputPath, 'utf8'));
      collectorResults.push(gcData);
      console.log(`GC: ${gcData.count} collections, ${gcData.total_pause_ms}ms total pause`);
      fs.unlinkSync(gcOutputPath);
    } catch {}
  }

  // Add script metrics as a collector result
  collectorResults.push({ metric: 'fanout', ...scriptMetrics });

  const result = buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteor: { version: source.version, sha: source.sha },
    collectorResults,
    wallClockMs,
  });

  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`\nResults written to: ${outputPath}`);
  console.log(`Wall clock: ${(wallClockMs / 1000).toFixed(1)}s`);

  if (scriptMetrics.fanout_avg_ms) {
    console.log(`Fanout: avg=${scriptMetrics.fanout_avg_ms}ms p50=${scriptMetrics.fanout_p50_ms}ms p95=${scriptMetrics.fanout_p95_ms}ms max=${scriptMetrics.fanout_max_ms}ms`);
  }

  for (const r of collectorResults) {
    if (r.cpu) console.log(`${r.name} CPU: avg ${r.cpu.avg}% max ${r.cpu.max}%`);
    if (r.memory) console.log(`${r.name} RAM: avg ${r.memory.avg_mb}MB max ${r.memory.max_mb}MB`);
  }
}

async function cmdColdStart({ scenarioName, appName, app, tag, outputPath, source }) {
  const meteorCmd = source.meteorCmd;
  const runs = parseInt(values.runs || '3', 10);
  const startupTimes = [];

  console.log(`\nCold-start benchmark: ${runs} runs\n`);

  for (let i = 0; i < runs; i++) {
    console.log(`--- Run ${i + 1}/${runs} ---`);

    // Clean state
    execSync(`${meteorCmd} reset`, { cwd: app.path, stdio: 'inherit' });

    // Start Meteor
    const meteorProc = spawn(meteorCmd, ['run', '--port', String(config.appPort)], {
      cwd: app.path,
      env: {
        ...process.env, ...extraEnv,
          METEOR_NO_DEPRECATION: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    meteorProc.stdout.on('data', (d) => process.stderr.write(d));
    meteorProc.stderr.on('data', (d) => process.stderr.write(d));

    const startTime = Date.now();
    waitForApp(config.appPort);
    const startupMs = Date.now() - startTime;
    startupTimes.push(startupMs);
    console.log(`Startup: ${(startupMs / 1000).toFixed(1)}s`);

    // Stop Meteor
    meteorProc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Sort and take median
  startupTimes.sort((a, b) => a - b);
  const median = startupTimes[Math.floor(startupTimes.length / 2)];
  const min = startupTimes[0];
  const max = startupTimes[startupTimes.length - 1];

  console.log(`\nResults: median=${(median / 1000).toFixed(1)}s min=${(min / 1000).toFixed(1)}s max=${(max / 1000).toFixed(1)}s`);

  const result = buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteor: { version: source.version, sha: source.sha },
    collectorResults: [{
      metric: 'cold_start',
      startup_median_ms: median,
      startup_min_ms: min,
      startup_max_ms: max,
      runs: startupTimes,
    }],
    wallClockMs: median,
  });

  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`Results written to: ${outputPath}`);
}

async function cmdBundleSize({ scenarioName, appName, app, tag, outputPath, source }) {
  const meteorCmd = source.meteorCmd;
  const buildDir = path.join('/tmp', `meteor-bundle-${Date.now()}`);

  console.log(`\nBundle size benchmark\n`);

  // Install deps if needed
  const nodeModulesPath = path.join(app.path, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('Installing app npm dependencies...');
    execSync('npm install', { cwd: app.path, stdio: 'inherit' });
  }

  // Build
  console.log('Building production bundle...');
  const buildStart = Date.now();
  execSync(`${meteorCmd} build ${buildDir} --directory`, {
    cwd: app.path,
    stdio: 'inherit',
    env: {
      ...process.env, ...extraEnv,
    },
  });
  const buildTimeMs = Date.now() - buildStart;
  console.log(`Build time: ${(buildTimeMs / 1000).toFixed(1)}s`);

  // Measure client bundle size
  const webBrowserDir = path.join(buildDir, 'bundle', 'programs', 'web.browser');
  let clientSizeKb = 0;
  if (fs.existsSync(webBrowserDir)) {
    const jsFiles = fs.readdirSync(webBrowserDir).filter(f => f.endsWith('.js'));
    for (const f of jsFiles) {
      clientSizeKb += fs.statSync(path.join(webBrowserDir, f)).size / 1024;
    }
  }

  // Measure server bundle size
  const serverDir = path.join(buildDir, 'bundle', 'programs', 'server');
  let serverSizeKb = 0;
  if (fs.existsSync(serverDir)) {
    const du = execSync(`du -sk "${serverDir}"`, { encoding: 'utf8' }).trim();
    serverSizeKb = parseInt(du.split('\t')[0], 10);
  }

  // Total bundle
  const totalDu = execSync(`du -sk "${path.join(buildDir, 'bundle')}"`, { encoding: 'utf8' }).trim();
  const totalSizeKb = parseInt(totalDu.split('\t')[0], 10);

  console.log(`Client JS: ${clientSizeKb.toFixed(0)} KB`);
  console.log(`Server: ${serverSizeKb} KB`);
  console.log(`Total bundle: ${totalSizeKb} KB`);

  // Cleanup
  execSync(`rm -rf "${buildDir}"`);

  const result = buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteor: { version: source.version, sha: source.sha },
    collectorResults: [{
      metric: 'bundle_size',
      client_js_kb: Math.round(clientSizeKb),
      server_kb: serverSizeKb,
      total_kb: totalSizeKb,
      build_time_ms: buildTimeMs,
    }],
    wallClockMs: buildTimeMs,
  });

  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`Results written to: ${outputPath}`);
}

function cmdCompare() {
  const baselinePath = values.baseline;
  const targetPath = values.target;
  const format = values.format || 'markdown';

  if (!baselinePath || !targetPath) {
    console.error('Usage: node bench.js compare --baseline <file> --target <file>');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  const report = compare(baseline, target);

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(toMarkdown(report));
  }

  process.exit(report.summary.passed ? 0 : 1);
}

async function cmdPush() {
  const resultPath = values.result;
  const url = values.url || config.dashboardUrl || 'ws://localhost:4000/websocket';
  const apiKey = values.key || process.env.BENCH_API_KEY || config.dashboardApiKey || 'dev-bench-key-change-in-prod';

  if (!resultPath) {
    console.error('Usage: node bench.js push --result <file.json> [--url <ws-url>] [--key <api-key>]');
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  console.log(`Pushing ${resultPath} to ${url}...`);

  const ddp = new SimpleDDP({
    endpoint: url,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  });

  try {
    await ddp.connect();
    const docId = await ddp.call('runs.insert', apiKey, result);
    console.log(`Pushed successfully. Document ID: ${docId}`);
  } catch (err) {
    console.error('Push failed:', err.message || err);
    process.exit(1);
  } finally {
    ddp.disconnect();
  }
}

async function cmdBaseline() {
  const scenario = values.scenario;
  const runId = values['run-id'] || values.runId;
  const url = values.url || config.dashboardUrl || 'ws://localhost:4000/websocket';
  const apiKey = values.key || process.env.BENCH_API_KEY || config.dashboardApiKey || 'dev-bench-key-change-in-prod';

  if (!scenario || !runId) {
    console.error('Usage: node bench.js baseline --scenario <name> --run-id <id> [--url <ws-url>]');
    process.exit(1);
  }

  console.log(`Setting baseline for "${scenario}" to run ${runId}...`);

  const ddp = new SimpleDDP({
    endpoint: url,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  });

  try {
    await ddp.connect();
    await ddp.call('baselines.set', apiKey, scenario, runId);
    console.log('Baseline set successfully.');
  } catch (err) {
    console.error('Failed:', err.message || err);
    process.exit(1);
  } finally {
    ddp.disconnect();
  }
}

// ─── Main ────────────────────────────────────────────────────────────

switch (command) {
  case 'list':
    cmdList();
    break;
  case 'run':
    cmdRun().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'compare':
    cmdCompare();
    break;
  case 'push':
    cmdPush().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'baseline':
    cmdBaseline().catch((err) => { console.error(err); process.exit(1); });
    break;
  default:
    console.log(`
Meteor Benchmark Framework

Usage:
  node bench.js list                                    List scenarios and apps
  node bench.js run [--scenario X] [--app Y] [--tag Z]  Run a benchmark
  node bench.js compare --baseline A --target B          Compare two results
  node bench.js push --result <file.json> [--url <ws>]   Push results to dashboard
  node bench.js baseline --scenario X --run-id Y         Set baseline for a scenario

Dashboard:
  Default URL: ${config.dashboardUrl || 'ws://localhost:4000/websocket'}
  Set BENCH_API_KEY env var or use --key flag for authentication

Version comparison workflow:
  cd ${config.meteorCheckoutPath} && git checkout release/3.5
  node bench.js run --tag v3.5 --output results/v3.5.json

  cd ${config.meteorCheckoutPath} && git checkout devel
  node bench.js run --tag devel --output results/devel.json

  node bench.js compare --baseline results/v3.5.json --target results/devel.json
  node bench.js push --result results/devel.json
`);
}
