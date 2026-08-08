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

/** Closed metric identities consumed by result persistence and the dashboard. */
export type MetricName =
  | 'app_resources' | 'db_resources' | 'gc' | 'event_loop_delay'
  | 'bundle_size' | 'cold_start' | 'fanout' | 'change_stream_audit'
  | 'ddp_methods' | 'ddp_subscriptions' | 'live_update_propagation'
  | 'mongo_ops' | 'observer_pool' | 'ddp_messages' | 'ddp_frame_size'
  | 'mongo_slow_queries' | 'mongo_index_usage' | 'mongo_pool'
  | 'mongo_changestream' | 'mongo_wiredtiger' | 'ddp_compression'
  | 'driver_fallbacks' | 'build_profile' | 'plugin_compile';

/** JSON-safe output from one known, self-identifying collector. */
export interface CollectorResult {
  readonly metric: MetricName;
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

const METRIC_SIGNATURES: Readonly<Record<MetricName, readonly string[]>> = Object.freeze({
  app_resources: ['cpu', 'memory'], db_resources: ['cpu', 'memory'], gc: ['count', 'total_pause_ms'],
  event_loop_delay: ['p99'], bundle_size: ['total_kb'], cold_start: ['startup_median_ms'],
  fanout: ['fanout_avg_ms'], change_stream_audit: ['status', 'failure_reasons'], ddp_methods: ['total_calls'],
  ddp_subscriptions: ['total_subs'], live_update_propagation: ['observed_updates'], mongo_ops: ['duration_s'],
  observer_pool: ['samples'], ddp_messages: ['total_in', 'total_out'], ddp_frame_size: ['in', 'out'],
  mongo_slow_queries: ['total_slow'], mongo_index_usage: ['collections'], mongo_pool: ['samples'],
  mongo_changestream: ['samples'], mongo_wiredtiger: ['cache_hit_ratio'], ddp_compression: ['in', 'out'],
  driver_fallbacks: ['total_cursors'], build_profile: ['top_nodes'], plugin_compile: ['plugins'],
});

function isFiniteNumber(value: JsonValue | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isArray(value: JsonValue | undefined): boolean {
  return Array.isArray(value);
}

function isObject(value: JsonValue | undefined): boolean {
  return isJsonObject(value);
}

const METRIC_FIELD_VALIDATORS: Readonly<Partial<Record<MetricName, Readonly<Record<string, (value: JsonValue | undefined) => boolean>>>>> = Object.freeze({
  app_resources: { cpu: isObject, memory: isObject },
  db_resources: { cpu: isObject, memory: isObject },
  gc: { count: isFiniteNumber, total_pause_ms: isFiniteNumber },
  event_loop_delay: { p99: isFiniteNumber },
  bundle_size: { total_kb: isFiniteNumber },
  cold_start: { startup_median_ms: isFiniteNumber },
  fanout: { fanout_avg_ms: isFiniteNumber },
  change_stream_audit: {
    status: (value) => value === 'passed' || value === 'failed' || value === 'incomplete',
    failure_reasons: (value) => Array.isArray(value) && value.every((reason: JsonValue) => typeof reason === 'string'),
  },
  ddp_methods: { total_calls: isFiniteNumber },
  ddp_subscriptions: { total_subs: isFiniteNumber },
  live_update_propagation: { observed_updates: isFiniteNumber },
  mongo_ops: { duration_s: isFiniteNumber },
  observer_pool: { samples: isFiniteNumber },
  ddp_messages: { total_in: isFiniteNumber, total_out: isFiniteNumber },
  ddp_frame_size: { in: isObject, out: isObject },
  mongo_slow_queries: { total_slow: isFiniteNumber },
  mongo_index_usage: { collections: isObject },
  mongo_pool: { samples: isFiniteNumber },
  mongo_changestream: { samples: isFiniteNumber },
  mongo_wiredtiger: { cache_hit_ratio: isFiniteNumber },
  ddp_compression: { in: isObject, out: isObject },
  driver_fallbacks: { total_cursors: isFiniteNumber },
  build_profile: { top_nodes: isArray },
  plugin_compile: { plugins: isObject },
});

function isMetricName(value: string): value is MetricName {
  return Object.hasOwn(METRIC_SIGNATURES, value);
}

/** Validates an untrusted self-identifying collector payload. */
export function collectorResult<T extends Readonly<{ readonly metric: MetricName }>>(value: T): T & CollectorResult;
export function collectorResult(value: unknown): CollectorResult;
export function collectorResult(value: unknown): CollectorResult {
  if (!isJsonObject(value) || typeof value.metric !== 'string' || !isMetricName(value.metric)) {
    throw new TypeError('Collector result must be a JSON object with a known metric identifier.');
  }
  const missing = METRIC_SIGNATURES[value.metric].filter((field) => value[field] === undefined);
  if (missing.length > 0) throw new TypeError(`Metric ${value.metric} is missing required fields: ${missing.join(', ')}.`);
  const invalid = Object.entries(METRIC_FIELD_VALIDATORS[value.metric] ?? {})
    .filter(([field, validate]) => !validate(value[field]))
    .map(([field]) => field);
  if (invalid.length > 0) throw new TypeError(`Metric ${value.metric} has invalid fields: ${invalid.join(', ')}.`);
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
  const metrics: Record<string, CollectorResult> = {};
  for (const result of collectorResults) {
    const validated = collectorResult(result);
    if (metrics[validated.metric] !== undefined) throw new TypeError(`Duplicate collector metric: ${validated.metric}.`);
    metrics[validated.metric] = validated;
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
    metrics,
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
