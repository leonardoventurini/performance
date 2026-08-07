// Produces the result JSON the Galaxy dashboard ingests. Three exports:
//
//   buildResult(...) → object
//     Shapes drivers' collector outputs into the dashboard-contract shape.
//     PURE: meteor info comes in as a parameter, never derived here. The
//     caller (cli/run.ts, via meteor-source.ts) is the sole owner of git
//     introspection — keeps this file side-effect-free aside from disk
//     writes done by writeResult / appendToHistory.
//
//   writeResult(result, outputPath)
//     Writes pretty-printed JSON to the operator-chosen path, creating
//     parent dirs if needed.
//
//   appendToHistory(result, historyDir)
//     Drops a timestamped copy under the history dir so a re-run that
//     overwrites --output doesn't destroy the trend.
//
// The output shape (do not change without the dashboard team — every field
// path here is read by apps/dashboard/):
//   {
//     timestamp: <ISO 8601>,
//     tag: <human label>,                         ← falls back to meteor.version
//     meteor: { version, sha },                   ← required, throws if missing
//     runtime: { observer_driver?, transport?, observer_driver_actual? },
//     scenario: <name>,
//     app: <name>,
//     wall_clock_ms: <number>,
//     metrics: { [r.metric]: r, ... }             ← collectors self-key
//   }

import fs from 'node:fs';
import path from 'node:path';
import { isJsonObject, isJsonValue } from '../lib/data-values.js';
import type { JsonValue } from '../lib/data-values.js';

/** JSON-safe output from one self-identifying collector. */
export interface CollectorResult {
  readonly metric: string;
  readonly [key: string]: JsonValue | undefined;
}
/** Runtime identity fields captured from the benchmarked Meteor process. */
export interface RuntimeMetadata {
  readonly observer_driver?: string;
  readonly observer_driver_actual?: string;
  readonly transport?: string;
  readonly channel?: string;
  readonly version?: string;
  readonly [key: string]: JsonValue | undefined;
}
/** Canonical persisted benchmark result consumed by comparisons and the dashboard. */
export interface BenchmarkResult {
  readonly timestamp: string; readonly tag: string; readonly meteor: { readonly version: string; readonly sha: string };
  readonly runtime: RuntimeMetadata; readonly scenario: string; readonly app: string;
  readonly wall_clock_ms: number; readonly metrics: Readonly<Record<string, CollectorResult>>;
}
/** Inputs required to construct one canonical benchmark result. */
export interface BuildResultInput {
  scenario: string; app: string; tag?: string; meteor: { version: string; sha: string };
  runtime?: RuntimeMetadata; collectorResults: readonly CollectorResult[]; wallClockMs: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates an untrusted self-identifying collector payload. */
export function collectorResult<T extends Readonly<{ readonly metric: string }>>(value: T): T & CollectorResult;
export function collectorResult(value: unknown): CollectorResult;
export function collectorResult(value: unknown): CollectorResult {
  if (!isJsonObject(value) || typeof value.metric !== 'string' || value.metric.length === 0) {
    throw new TypeError('Collector result must be a JSON object with a non-empty metric identifier.');
  }
  return { ...value, metric: value.metric };
}

/** Validates an untrusted persisted result before it enters dashboard or comparison flows. */
export function benchmarkResult(value: unknown): BenchmarkResult {
  if (!isRecord(value)
    || typeof value.timestamp !== 'string'
    || typeof value.tag !== 'string'
    || typeof value.scenario !== 'string'
    || typeof value.app !== 'string'
    || typeof value.wall_clock_ms !== 'number'
    || !Number.isFinite(value.wall_clock_ms)
    || !isRecord(value.meteor)
    || typeof value.meteor.version !== 'string'
    || typeof value.meteor.sha !== 'string'
    || !isRecord(value.runtime)
    || !isJsonValue(value.runtime)
    || !isRecord(value.metrics)) {
    throw new TypeError('Benchmark result is missing its canonical identity, runtime, or metric envelope.');
  }
  const metrics: Record<string, CollectorResult> = {};
  for (const [name, candidate] of Object.entries(value.metrics)) {
    const metric = collectorResult(candidate);
    if (metric.metric !== name) throw new TypeError(`Benchmark metric key ${name} does not match ${metric.metric}.`);
    metrics[name] = metric;
  }
  return { timestamp: value.timestamp, tag: value.tag, meteor: { version: value.meteor.version, sha: value.meteor.sha }, runtime: value.runtime, scenario: value.scenario, app: value.app, wall_clock_ms: value.wall_clock_ms, metrics };
}

/** Builds the canonical result envelope from trusted runtime components. */
function buildResult({ scenario, app, tag, meteor, runtime = {}, collectorResults, wallClockMs }: BuildResultInput): BenchmarkResult {
  // The throw is deliberate — there used to be a silent
  // `meteor ?? { version: 'unknown', sha: 'unknown' }` fallback here, but
  // that masked the worst failure mode (omitted meteor info silently lands
  // 'unknown' rows in the dashboard). Throwing forces any new caller to
  // resolve meteor info up front via meteor-source.js.
  if (!meteor || typeof meteor.version !== 'string' || typeof meteor.sha !== 'string') {
    throw new Error(
      'buildResult requires meteor: { version, sha }. ' +
      'Call resolveMeteorSource from meteor-source.js to obtain it.'
    );
  }
  return {
    timestamp: new Date().toISOString(),
    tag: tag || meteor.version,
    meteor,
    runtime,
    scenario,
    app,
    wall_clock_ms: wallClockMs,
    // Each collector tags its output with a `metric` field; we use that as
    // the key here so the dashboard reads `metrics.app_resources.cpu.avg`
    // etc. without any per-collector branching.
    metrics: Object.fromEntries(collectorResults.map((result) => [result.metric, collectorResult(result)])),
  };
}

/** Persists a canonical result using stable, human-readable JSON. */
function writeResult(result: BenchmarkResult, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Trailing newline keeps `git diff` happy when results land in commits.
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
}

/** Appends a uniquely named canonical result to local history. */
function appendToHistory(result: BenchmarkResult, historyDir: string): void {
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
  // Date.now() in the filename guarantees uniqueness across rapid re-runs
  // with the same tag (CI nightly that triggers twice in a minute, etc.).
  const filename = `${result.scenario}-${result.tag}-${Date.now()}.json`;
  writeResult(result, path.join(historyDir, filename));
}

export { buildResult, writeResult, appendToHistory };
