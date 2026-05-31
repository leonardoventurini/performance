// `bench.js push` and `bench.js baseline` — both connect to the dashboard
// over DDP, call one method, disconnect. Shared connection helper at the top.

import { io } from '../runner/_io.js';

const DEFAULT_URL = 'ws://localhost:4000/websocket';
const DEFAULT_KEY = 'dev-bench-key-change-in-prod';

function resolveUrl(values, config) {
  return values.url || config.dashboardUrl || DEFAULT_URL;
}

function resolveKey(values, config) {
  return values.key || process.env.BENCH_API_KEY || config.dashboardApiKey || DEFAULT_KEY;
}

function connect(url) {
  return new io.SimpleDDP({
    endpoint: url,
    SocketConstructor: io.ws,
    reconnectInterval: 5000,
  });
}

export async function runPush({ values, config }) {
  const resultPath = values.result;
  const url = resolveUrl(values, config);
  const apiKey = resolveKey(values, config);

  if (!resultPath) {
    console.error('Usage: node bench.js push --result <file.json> [--url <ws-url>] [--key <api-key>]');
    process.exit(1);
  }

  const result = JSON.parse(io.readFileSync(resultPath, 'utf8'));
  console.log(`Pushing ${resultPath} to ${url}...`);

  const ddp = connect(url);
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

export async function runBaseline({ values, config }) {
  const scenario = values.scenario;
  const runId = values['run-id'] || values.runId;
  const url = resolveUrl(values, config);
  const apiKey = resolveKey(values, config);

  if (!scenario || !runId) {
    console.error('Usage: node bench.js baseline --scenario <name> --run-id <id> [--url <ws-url>]');
    process.exit(1);
  }

  console.log(`Setting baseline for "${scenario}" to run ${runId}...`);

  const ddp = connect(url);
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
