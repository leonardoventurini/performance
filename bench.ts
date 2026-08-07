#!/usr/bin/env node

/**
 * Meteor Benchmark Framework — CLI entry point.
 *
 * This file is intentionally thin: parse argv, dispatch to one cli/ handler,
 * exit. All actual work (validating inputs, spawning Meteor, running load,
 * collecting metrics, writing results) lives behind those handlers. Adding a
 * new subcommand means: re-export it from cli/index.js, destructure here,
 * add a case.
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
import type { Environment } from './lib/benchmark-types.js';

const {
  runList,
  runBenchmark,
  runCompare,
  runPush,
  runBaseline,
  runClear,
  runBundleDelta,
  runAudit,
  runReleaseAudit,
  runReleaseAuditValidate,
} = cli;

// One shared schema for every subcommand — parseArgs is the single source of
// truth for which flags exist. `multiple: true` for --env lets it be passed
// repeatedly (`--env A=1 --env B=2`). `strict: false` makes unknown flags
// non-fatal so future subcommands can add flags without breaking old shells.
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
  // runId is a kebab-vs-camel alias that some workflows passed pre-refactor;
  // kept for backwards-compat with already-deployed dispatchers.
  runId: { type: 'string' },
  // bundle-delta flags. Strings here (parseArgs has no number type); the
  // handler coerces. limit = how many recent runs, warn-kb = ⚠️ threshold.
  limit: { type: 'string' },
  'warn-kb': { type: 'string' },
  // `clear` guard — wiping the dashboard is destructive, so require an
  // explicit opt-in flag (boolean, no value).
  confirm: { type: 'boolean' },
  profile: { type: 'string' },
  seed: { type: 'string' },
  'observer-driver': { type: 'string' },
  'allow-remote-mongo': { type: 'boolean' },
  release: { type: 'string' },
  manifest: { type: 'string' },
} as const;

function printHelp(): void {
  console.log(`
Meteor Benchmark Framework

Usage:
  node bench.js list                                    List scenarios and apps
  node bench.js run [--scenario X] [--app Y] [--tag Z]  Run a benchmark
  node bench.js compare --baseline A --target B          Compare two results
  node bench.js push --result <file.json> [--url <ws>]   Push results to dashboard
  node bench.js baseline --scenario X --run-id Y         Set baseline for a scenario
  node bench.js clear --confirm [--url <ws>] [--key K]   Wipe ALL runs from the dashboard
  node bench.js bundle-delta [--limit N] [--format markdown|json] [--warn-kb N]
                                                         Bundle-size trend across saved runs
  node bench.js audit [--profile smoke|extreme]
                            [--observer-driver changeStreams|oplog]
                                                         Verify reactive correctness under adversarial load
  node bench.js release-audit --meteor-version <exact-release>
                                                         Run the release conformance matrix
  node bench.js release-audit-validate --manifest <manifest.json>
                                                         Validate a sealed release artifact

Dashboard:
  Default URL: ${config.dashboardUrl || 'ws://localhost:4000/websocket'}
  Set BENCH_API_KEY env var or use --key flag for authentication

Meteor source:
  --meteor-version <v> | METEOR_RELEASE=<v>   Pinned published release
  --meteor-checkout <path> | METEOR_CHECKOUT_PATH=<path>   Local Meteor checkout
  (mutually exclusive; see README "Meteor source" for details)
`);
}

// Sync handlers (list, compare) run inline; async handlers (run, push, baseline)
// get a .catch so an unhandled rejection still surfaces as a non-zero exit
// code instead of a stack trace and exit 0. Unknown command → help, no error.
/** Inputs supplied by the stable checked-JavaScript launcher. */
export interface MainInputs {
  readonly argv: readonly string[];
  readonly env: Environment;
  readonly repositoryRoot: string;
}

/** Parses and dispatches one CLI invocation without auto-executing on import. */
export async function main({ argv, env, repositoryRoot }: MainInputs): Promise<void> {
  void repositoryRoot;
  const { values, positionals } = parseArgs({
    args: [...argv], options: OPTIONS, allowPositionals: true, strict: false,
  });
  const command = positionals[0];

switch (command) {
  case 'list': {
    // list is the only sync command that needs the resolved source up front
    // (to print "Meteor source: …" in its header). Others resolve internally.
    const source = resolveMeteorSource({ flags: values, env, config });
    runList({ config, source });
    break;
  }
  case 'run':
    await runBenchmark({ values, config });
    break;
  case 'compare':
    runCompare({ values });
    break;
  case 'push':
    await runPush({ values, config });
    break;
  case 'baseline':
    await runBaseline({ values, config });
    break;
  case 'clear':
    await runClear({ values, config });
    break;
  case 'bundle-delta':
    runBundleDelta({ values, config });
    break;
  case 'audit':
    await runAudit({ values, config });
    break;
  case 'release-audit':
    await runReleaseAudit({ values, config });
    break;
  case 'release-audit-validate':
    try {
      runReleaseAuditValidate({ values });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
    break;
  default:
    printHelp();
}
}
