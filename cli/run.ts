// `bench.js run` — entry point for the `run` subcommand. Flow at a glance:
//
//   1. Resolve which Meteor we're running (checkout / pinned release / system)
//   2. Parse --env KEY=VALUE flags into an object for the Meteor process
//   3. Validate scenario + app names against bench.config.js, exit early
//      with a clear error and the list of valid options if either is wrong
//   4. Pick a driver based on scenario.driver (artillery / script / cli)
//   5. Hand everything to the driver; it spawns Meteor, runs the load,
//      collects metrics, returns a result object
//   6. Persist the result to --output (default: results/<scenario>-<tag>-<ts>.json)
//      AND append to the history dir, then print a quick summary
//
// Drivers are dumb data-in/data-out: this file owns the lifecycle, the
// drivers own the "how" for each scenario type.

import path from 'node:path';
import { resolveMeteorSource } from '../meteor-source.js';
import { buildResult, writeResult, appendToHistory } from '../reporters/json-reporter.js';
import { drivers } from '../drivers/index.js';
import type { BenchmarkConfig, CliValues, DriverInputs } from '../lib/benchmark-types.js';

// Parses `--env KEY=VALUE` flag occurrences into a flat object. parseArgs
// hands us either a string (one flag) or string[] (multiple), or undefined
// when the flag wasn't passed. Splitting on the FIRST `=` means values
// containing `=` survive intact (e.g. `--env MONGO_URL=mongodb://...`).
// Entries with no `=` are dropped silently — they're malformed and would
// otherwise become `{KEY: undefined}` which confuses downstream env merging.
export function splitEnvArgs(rawEnvArray: string | readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rawEnvArray) return out;
  const list = Array.isArray(rawEnvArray) ? rawEnvArray : [rawEnvArray];
  for (const e of list) {
    const idx = e.indexOf('=');
    if (idx > 0) out[e.slice(0, idx)] = e.slice(idx + 1);
  }
  return out;
}

// Bail with exit code 1 and a list of valid names, so the user's next attempt
// can use a real one without having to read bench.config.js by hand.
function exitUnknown(kind: string, name: string, validNames: readonly string[]): never {
  console.error(`Unknown ${kind}: ${name}`);
  console.error(`Available ${kind}s: ${validNames.join(', ')}`);
  process.exit(1);
}

// Maps scenario.driver (declared in bench.config.js) to one of the four
// driver functions. The `cli` driver is a meta-type — bench.config.js uses
// it for special scenarios that don't fit the artillery/script pattern
// (cold-start, bundle-size); we dispatch on the scenario name itself for
// those, and return null for any other `cli` scenario so the caller can
// print "not implemented" rather than crash.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Resolves, executes, persists, and summarizes one configured benchmark. */
export async function runBenchmark({ values, config }: Readonly<{ values: CliValues; config: BenchmarkConfig }>): Promise<ReturnType<typeof buildResult>> {
  // Resolve once at the top — every spawn of `meteor` downstream needs
  // `source.meteorCmd` and `source.releaseArg`. Reading these fresh on
  // every spawn would risk inconsistency if env or config changed mid-run.
  const source = resolveMeteorSource({ flags: values, env: process.env, config });
  const rawEnv = values.env;
  const extraEnv = splitEnvArgs(typeof rawEnv === 'string' || Array.isArray(rawEnv) ? rawEnv : undefined);

  // Defaults pulled here, not in the driver, so the driver function can
  // be unit-tested with explicit inputs (no fallback magic to mock).
  const scenarioName = typeof values.scenario === 'string' ? values.scenario : 'reactive-light';
  const appName = typeof values.app === 'string' ? values.app : config.defaultApp;
  const tag = typeof values.tag === 'string' ? values.tag : source.version;
  const outputPath = typeof values.output === 'string' ? values.output : path.join(config.results.dir, `${scenarioName}-${tag}-${Date.now()}.json`);

  // Fail-fast on bad inputs BEFORE we install npm deps, reset the app,
  // or spin up Meteor — those take ~30 s each and frustrate the operator
  // who just typo'd a name.
  const scenario = config.scenarios[scenarioName];
  if (!scenario) exitUnknown('scenario', scenarioName, Object.keys(config.scenarios));
  const app = config.apps[appName];
  if (!app) exitUnknown('app', appName, Object.keys(config.apps));

  // Header so the operator (and the saved log) shows the exact inputs
  // that produced the numbers. The env line is omitted when empty so
  // small runs don't have a noisy `Env:` line.
  console.log(`\n🔧 Benchmark: ${scenarioName}`);
  console.log(`   App: ${appName}`);
  console.log(`   Meteor: ${source.version} (${source.sha})`);
  console.log(`   Tag: ${tag}`);
  if (Object.keys(extraEnv).length > 0) {
    console.log(`   Env: ${Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');

  if (scenario.driver === 'cli' && scenarioName !== 'cold-start' && scenarioName !== 'bundle-size') {
    // `cli` scenarios without a dedicated driver (hot-reload, etc.) hit
    // this path — exit 0 so CI doesn't fail on a "not yet implemented".
    console.log(`CLI scenario "${scenarioName}" — not yet implemented.`);
    process.exit(0);
  }

  // Only the cold-start driver uses --runs (number of restart iterations
  // for the median). Other drivers ignore it; passing undefined keeps the
  // shape clean.
  const rawRuns = values.runs;
  const runs = scenarioName === 'cold-start' ? Number.parseInt(typeof rawRuns === 'string' ? rawRuns : '3', 10) : undefined;
  const baseInputs: DriverInputs = {
    scenario, scenarioName, app, appName, source, env: extraEnv, tag, config,
    ...(runs === undefined ? {} : { runs }),
  };
  const result = scenario.driver === 'script'
    ? await drivers.runScriptDriver({ ...baseInputs, scenario })
    : scenario.driver === 'artillery' || scenario.driver === 'artillery-playwright'
      ? await drivers.runArtilleryDriver({ ...baseInputs, scenario })
      : scenario.driver === 'build-profile'
        ? await drivers.runBuildProfileDriver({ ...baseInputs, scenario })
        : scenarioName === 'cold-start'
          ? await drivers.runColdStartDriver(baseInputs)
          : await drivers.runBundleSizeDriver(baseInputs);

  // writeResult goes to the operator-chosen path; appendToHistory keeps
  // an immutable, timestamped copy under results/history/ so trends can
  // be re-analyzed later even if --output is overwritten.
  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`\nResults written to: ${outputPath}`);
  console.log(`Wall clock: ${(result.wall_clock_ms / 1000).toFixed(1)}s`);

  // Quick eyeball summary. We only print rows that HAVE cpu/memory shape
  // (process-monitor collector output) — GC and event-loop have their
  // own shapes and are surfaced via the result file rather than this
  // summary block.
  for (const r of Object.values(result.metrics)) {
    if (!isRecord(r)) continue;
    const cpu = r.cpu;
    const memory = r.memory;
    if (isRecord(cpu)) console.log(`${String(r.name)} CPU: avg ${String(cpu.avg)}% max ${String(cpu.max)}%`);
    if (isRecord(memory)) console.log(`${String(r.name)} RAM: avg ${String(memory.avg_mb)}MB max ${String(memory.max_mb)}MB`);
  }

  const audit = result.metrics.change_stream_audit;
  if (isRecord(audit) && audit.status !== 'passed') {
    const reasons = Array.isArray(audit.failure_reasons) ? audit.failure_reasons.map(String).join(', ') : 'missing failure reasons';
    throw new Error(`Change-stream audit ${String(audit.status)}: ${reasons}`);
  }
  return result;
}
