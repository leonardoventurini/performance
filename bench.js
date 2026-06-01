#!/usr/bin/env node

/**
 * Meteor Benchmark Framework — CLI
 *
 * Usage:
 *   node bench.js list
 *   node bench.js run [--scenario <name>] [--app <name>] [--tag <label>]
 *   node bench.js compare --baseline <file> --target <file> [--format markdown|json]
 *   node bench.js push --result <file.json> [--url <ws-url>] [--key <api-key>]
 *   node bench.js baseline --scenario <name> --run-id <id> [--url <ws-url>]
 *
 * See README.md "Meteor source" for --meteor-version / --meteor-checkout usage.
 */

import { parseArgs } from 'node:util';
import config from './bench.config.js';
import { resolveMeteorSource } from './meteor-source.js';
import * as cli from './cli/index.js';

const { runList, runBenchmark, runCompare, runPush, runBaseline } = cli;

const OPTIONS = {
  scenario: { type: 'string' },
  app: { type: 'string' },
  tag: { type: 'string' },
  output: { type: 'string' },
  runs: { type: 'string' },
  env: { type: 'string', multiple: true },
  'meteor-version': { type: 'string' },
  'meteor-checkout': { type: 'string' },
  baseline: { type: 'string' },
  target: { type: 'string' },
  format: { type: 'string' },
  result: { type: 'string' },
  url: { type: 'string' },
  key: { type: 'string' },
  'run-id': { type: 'string' },
  runId: { type: 'string' },
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: OPTIONS,
  allowPositionals: true,
  strict: false,
});
const command = positionals[0];

function printHelp() {
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

Meteor source:
  --meteor-version <v> | METEOR_RELEASE=<v>   Pinned published release
  --meteor-checkout <path> | METEOR_CHECKOUT_PATH=<path>   Local Meteor checkout
  (mutually exclusive; see README "Meteor source" for details)
`);
}

switch (command) {
  case 'list': {
    const source = resolveMeteorSource({ flags: values, env: process.env, config });
    runList({ config, source });
    break;
  }
  case 'run':
    runBenchmark({ values, config }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'compare':
    runCompare({ values });
    break;
  case 'push':
    runPush({ values, config }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'baseline':
    runBaseline({ values, config }).catch((err) => { console.error(err); process.exit(1); });
    break;
  default:
    printHelp();
}
