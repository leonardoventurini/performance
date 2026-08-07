// Spawn the process-monitor collectors for APP + DB pids, then on stop
// SIGTERM + drain + parse their JSON output. GC metrics are read from the
// gc-monitor output file that the in-process collector dumps on Meteor's
// SIGTERM.
//
// Each collector self-identifies via its `metric` field — `app_resources`,
// `db_resources`, `gc` — which is what the dashboard's result-JSON contract
// reads. No key renaming here; we trust the collectors' output and pass it
// through.

import path from 'node:path';
import { io } from './_io.js';
import { findPid } from './meteor-process.js';
import { summarize } from '../lib/percentiles.js';
import { aggregateObserverPool } from '../runner/observer-pool-aggregator.js';
import { aggregateDdpMessages } from '../runner/message-rate-aggregator.js';
import { aggregateFrameSize } from '../runner/frame-size-aggregator.js';
import { aggregateCompression } from '../runner/compression-aggregator.js';
import { aggregateDriverFallback } from '../runner/driver-fallback-aggregator.js';
import type { ChildProcess } from 'node:child_process';
import { errorMessage } from '../lib/benchmark-types.js';
import { isJsonObject, parseJson } from '../lib/data-values.js';
import { collectorResult } from '../reporters/json-reporter.js';
import type { CollectorResult } from '../reporters/json-reporter.js';

interface SpawnedCollector { proc: Pick<ChildProcess, 'kill'>; name: string; getResult(): string }
interface CollectorPaths {
  gcOutputPath?: string | undefined; methodTimingPath?: string | undefined;
  subTimingPath?: string | undefined; propagationTimingPath?: string | undefined;
  observerPoolPath?: string | undefined; ddpMessagePath?: string | undefined;
  frameSizePath?: string | undefined; compressionPath?: string | undefined;
  driverFallbackPath?: string | undefined;
}
interface StartCollectorsInput extends CollectorPaths { appName: string; mongoUri?: string }
interface StopCollectorsInput extends CollectorPaths { procs: readonly SpawnedCollector[] }

const HERE = import.meta.dirname;
const PROCESS_MONITOR = path.resolve(HERE, '..', 'collectors', 'process-monitor.js');
const GC_MONITOR = path.resolve(HERE, '..', 'collectors', 'gc-monitor.cjs');
const MONGO_OPS_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-ops-monitor.js');
const MONGO_SLOW_QUERY_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-slow-query-monitor.js');
const MONGO_INDEX_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-index-usage-monitor.js');
const MONGO_POOL_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-pool-monitor.js');
const MONGO_CHANGESTREAM_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-changestream-monitor.js');
const MONGO_WIREDTIGER_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-wiredtiger-monitor.js');
const RESULTS_DIR = path.resolve(HERE, '..', 'results');
const COLLECTOR_DRAIN_MS = 1000;

/** Allocates the emitted GC preload and its run-owned output path. */
export function prepareGcOutput(tag: string) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return {
    gcMonitorPath: GC_MONITOR,
    gcOutputPath: path.join(RESULTS_DIR, `gc-${tag}-${Date.now()}.json`),
  };
}

/** Allocates the run-owned method-timing output path consumed after shutdown. */
export function prepareMethodTimingOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `method-timing-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned subscription-timing output path. */
export function prepareSubTimingOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `sub-timing-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned propagation-timing output path. */
export function preparePropagationTimingOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `propagation-timing-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned observer-pool sample path. */
export function prepareObserverPoolOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `observer-pool-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned DDP message counter path. */
export function prepareDdpMessageOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `ddp-messages-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned DDP frame-size counter path. */
export function prepareFrameSizeOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `frame-size-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned compression tracker path. */
export function prepareCompressionOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `compression-${tag}-${Date.now()}.json`);
}

/** Allocates the run-owned observer-driver fallback path. */
export function prepareDriverFallbackOutput(tag: string): string {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `driver-fallback-${tag}-${Date.now()}.json`);
}

// Aggregator: turns the raw samples Map dumped by the in-app collector
// into the metrics.ddp_methods shape. Exported for unit-testing without
// the full collectors lifecycle.
//
// Field naming follows CC-4: percentile names are BARE (p50, p95, p99)
// to match the shipped event_loop_delay contract; non-percentile latency
// scalars carry _ms suffix.
//
// Returns null when no samples were captured at all (per absence
// convention CC-5: collector ran but emitted nothing → omit the key).
function numericSamples(value: unknown): Readonly<Record<string, readonly number[]>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Timing samples must be an object.');
  const samples: Record<string, readonly number[]> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate) || !candidate.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new TypeError(`Timing samples for ${name} must contain only finite numbers.`);
    }
    samples[name] = candidate;
  }
  return samples;
}

/** Aggregates untrusted method-timing samples into the public metric contract. */
export function aggregateMethodTiming(value: unknown) {
  const samplesByMethod = value == null ? {} : numericSamples(value);
  const methods: Record<string, { count: number; avg_ms: number; p50: number; p95: number; p99: number; max_ms: number }> = {};
  let totalCalls = 0;
  for (const [name, samples] of Object.entries(samplesByMethod || {})) {
    const stats = summarize(samples);
    if (!stats) continue;
    methods[name] = {
      count: stats.count,
      avg_ms: stats.avg,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max_ms: stats.max,
    };
    totalCalls += stats.count;
  }
  if (totalCalls === 0) return null;
  return { metric: 'ddp_methods', methods, total_calls: totalCalls };
}

// Same shape as aggregateMethodTiming but grouped by publication name.
// `publications` mirrors `methods`; `total_subs` mirrors `total_calls`.
// Conventions identical (BARE percentile, absence → null, etc.).
/** Aggregates untrusted publication-timing samples into the public metric contract. */
export function aggregateSubTiming(value: unknown) {
  const samplesByPub = value == null ? {} : numericSamples(value);
  const publications: Record<string, { count: number; avg_ms: number; p50: number; p95: number; p99: number; max_ms: number }> = {};
  let totalSubs = 0;
  for (const [name, samples] of Object.entries(samplesByPub || {})) {
    const stats = summarize(samples);
    if (!stats) continue;
    publications[name] = {
      count: stats.count,
      avg_ms: stats.avg,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max_ms: stats.max,
    };
    totalSubs += stats.count;
  }
  if (totalSubs === 0) return null;
  return { metric: 'ddp_subscriptions', publications, total_subs: totalSubs };
}

// Flat-aggregate variant (no grouping by name) — propagation samples are
// per-emit (every sub × every doc), aggregated into one set. Returns null
// when no samples (absence convention).
/** Aggregates untrusted propagation samples after validating every latency. */
export function aggregatePropagationTiming(value: unknown) {
  if (value != null && (!Array.isArray(value) || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))) {
    throw new TypeError('Propagation samples must contain only finite numbers.');
  }
  const stats = summarize(Array.isArray(value) ? value : []);
  if (!stats) return null;
  return {
    metric: 'live_update_propagation',
    observed_updates: stats.count,
    avg_ms: stats.avg,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
    max_ms: stats.max,
  };
}

function spawnProcessMonitor(pid: string, name: string): SpawnedCollector {
  const proc = io.spawn('node', [PROCESS_MONITOR, pid, name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name, getResult: () => stdout };
}

// Mongo opcounters collector — out-of-process script that reads
// serverStatus().opcounters baseline at startup and again on SIGTERM,
// outputs JSON on stdout. Same shape as spawnProcessMonitor so it
// flows through stopCollectors' generic JSON-from-stdout drain.
function spawnMongoOpsMonitor(mongoUri: string): SpawnedCollector {
  const proc = io.spawn('node', [MONGO_OPS_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_OPS', getResult: () => stdout };
}

// Mongo slow-query collector — out-of-process script that enables the Mongo
// profiler for the run, then on SIGTERM reads system.profile, aggregates
// slow ops, restores the profiler config, and emits metrics.mongo_slow_queries
// on stdout. Aggregation runs inside the script, so (like mongo-ops) it flows
// through stopCollectors' generic JSON-from-stdout drain — no read block here.
function spawnMongoSlowQueryMonitor(mongoUri: string): SpawnedCollector {
  const proc = io.spawn('node', [MONGO_SLOW_QUERY_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_SLOW_QUERY', getResult: () => stdout };
}

// Mongo index-usage collector — out-of-process script that snapshots
// per-index $indexStats (accesses.ops + since) per collection at startup
// and again on SIGTERM, emits the metrics.mongo_index_usage JSON on
// stdout. Same { proc, name, getResult } shape as the other spawns, so
// it rides stopCollectors' generic JSON-from-stdout drain with no special
// handling.
function spawnMongoIndexUsageMonitor(mongoUri: string): SpawnedCollector {
  const proc = io.spawn('node', [MONGO_INDEX_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_INDEX', getResult: () => stdout };
}

// Mongo connection-pool collector — out-of-process script that polls
// serverStatus().connections every second and emits the aggregated
// `metrics.mongo_pool` JSON on stdout on SIGTERM. Same shape as
// spawnMongoOpsMonitor so it flows through stopCollectors' generic
// JSON-from-stdout drain.
function spawnMongoPoolMonitor(mongoUri: string): SpawnedCollector {
  const proc = io.spawn('node', [MONGO_POOL_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_POOL', getResult: () => stdout };
}

// Mongo change-stream cursor collector — out-of-process script that
// polls currentOp every 250ms for in-flight change-stream getMore
// cursors and emits the aggregated `metrics.mongo_changestream` JSON on
// stdout on SIGTERM. Same shape as spawnMongoOpsMonitor so it flows
// through stopCollectors' generic JSON-from-stdout drain.
function spawnMongoChangestreamMonitor(mongoUri: string): SpawnedCollector {
  const proc = io.spawn('node', [MONGO_CHANGESTREAM_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_CHANGESTREAM', getResult: () => stdout };
}

// Mongo WiredTiger cache collector — out-of-process script that reads
// serverStatus().wiredTiger.cache at startup and again on SIGTERM,
// computes the cache hit ratio + page-count deltas + end bytes-in-cache,
// and emits the metrics.mongo_wiredtiger JSON on stdout. Same shape as
// spawnMongoOpsMonitor so it rides stopCollectors' generic
// JSON-from-stdout drain with no special handling.
function spawnMongoWiredTigerMonitor(mongoUri: string): SpawnedCollector {
  const proc = io.spawn('node', [MONGO_WIREDTIGER_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_WIREDTIGER', getResult: () => stdout };
}

/** Starts only the collectors supported by the resolved process and database inputs. */
export function startCollectors({ appName, mongoUri, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath, frameSizePath, compressionPath, driverFallbackPath }: StartCollectorsInput) {
  const procs: SpawnedCollector[] = [];

  const appPid = findPid(`${appName}/.meteor/local/build/main.js`);
  if (appPid) {
    procs.push(spawnProcessMonitor(appPid, 'APP'));
  } else {
    console.error(`No APP pid found for ${appName}; skipping app_resources collector.`);
  }

  const dbPid = findPid(`${appName}/.meteor/local/db`);
  if (dbPid) {
    procs.push(spawnProcessMonitor(dbPid, 'DB'));
  } else {
    console.error(`No DB pid found for ${appName}; skipping db_resources collector.`);
  }

  if (mongoUri) {
    procs.push(spawnMongoOpsMonitor(mongoUri));
    procs.push(spawnMongoSlowQueryMonitor(mongoUri));
    procs.push(spawnMongoIndexUsageMonitor(mongoUri));
    procs.push(spawnMongoPoolMonitor(mongoUri));
    procs.push(spawnMongoChangestreamMonitor(mongoUri));
    procs.push(spawnMongoWiredTigerMonitor(mongoUri));
  }

  return { procs, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath, frameSizePath, compressionPath, driverFallbackPath };
}

/** Stops collectors and admits only validated JSON metrics into the result envelope. */
export async function stopCollectors({ procs, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath, frameSizePath, compressionPath, driverFallbackPath }: StopCollectorsInput): Promise<CollectorResult[]> {
  const results: CollectorResult[] = [];

  for (const { proc, name, getResult } of procs) {
    proc.kill('SIGTERM');
    await io.sleep(COLLECTOR_DRAIN_MS);
    const raw = getResult().trim();
    if (!raw) continue;
    try {
      results.push(collectorResult(parseJson(raw)));
    } catch (err) {
      console.error(`Dropping malformed JSON from ${name} collector: ${errorMessage(err)}`);
    }
  }

  if (gcOutputPath && io.existsSync(gcOutputPath)) {
    try {
      const parsedGc = parseJson(io.readFileSync(gcOutputPath, 'utf8'));
      if (!isJsonObject(parsedGc)) throw new TypeError('GC output must be a JSON object.');
      const gcData = collectorResult(parsedGc);
      results.push(gcData);
      console.log(`GC: ${String(parsedGc.count)} collections, ${String(parsedGc.total_pause_ms)}ms total pause, ${String(parsedGc.max_pause_ms)}ms max`);
      if (isJsonObject(parsedGc.minor) && isJsonObject(parsedGc.major)) {
        console.log(`  Minor: ${String(parsedGc.minor.count)} (${String(parsedGc.minor.total_ms)}ms) | Major: ${String(parsedGc.major.count)} (${String(parsedGc.major.total_ms)}ms)`);
      }
      io.unlinkSync(gcOutputPath);
    } catch (err) {
      console.error(`Could not read GC metrics from ${gcOutputPath}: ${errorMessage(err)}`);
    }
  }

  // Method timing: in-app collector dumps the raw samples Map; we aggregate
  // into the ddp_methods shape here. If the file doesn't exist (the app
  // didn't run with METHOD_TIMING_OUTPUT set) we omit the metric entirely
  // per the absence convention.
  if (methodTimingPath && io.existsSync(methodTimingPath)) {
    try {
      const dump = parseJson(io.readFileSync(methodTimingPath, 'utf8'));
      const aggregated = aggregateMethodTiming(dump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        console.log(`DDP methods: ${aggregated.total_calls} calls across ${Object.keys(aggregated.methods).length} methods`);
      }
      io.unlinkSync(methodTimingPath);
    } catch (err) {
      console.error(`Could not read method timing from ${methodTimingPath}: ${errorMessage(err)}`);
    }
  }

  // Sub timing: same pattern, different env var + aggregator + key shape.
  if (subTimingPath && io.existsSync(subTimingPath)) {
    try {
      const dump = parseJson(io.readFileSync(subTimingPath, 'utf8'));
      const aggregated = aggregateSubTiming(dump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        console.log(`DDP subscriptions: ${aggregated.total_subs} subs across ${Object.keys(aggregated.publications).length} publications`);
      }
      io.unlinkSync(subTimingPath);
    } catch (err) {
      console.error(`Could not read sub timing from ${subTimingPath}: ${errorMessage(err)}`);
    }
  }

  // Propagation timing: flat array of write-to-emit latencies.
  if (propagationTimingPath && io.existsSync(propagationTimingPath)) {
    try {
      const dump = parseJson(io.readFileSync(propagationTimingPath, 'utf8'));
      const aggregated = aggregatePropagationTiming(dump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        console.log(`Live-update propagation: ${aggregated.observed_updates} observed updates, p50=${aggregated.p50}ms p95=${aggregated.p95}ms`);
      }
      io.unlinkSync(propagationTimingPath);
    } catch (err) {
      console.error(`Could not read propagation timing from ${propagationTimingPath}: ${errorMessage(err)}`);
    }
  }

  // Observer pool: in-app sampler dumps { interval_ms, samples } (raw
  // per-tick mux/handle counts); we aggregate to min/max/avg/end here.
  if (observerPoolPath && io.existsSync(observerPoolPath)) {
    try {
      const dump = parseJson(io.readFileSync(observerPoolPath, 'utf8'));
      const aggregated = aggregateObserverPool(dump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        console.log(`Observer pool: ${aggregated.samples} samples, multiplexers max=${aggregated.multiplexer_count.max} end=${aggregated.multiplexer_count.end}, handles max=${aggregated.handle_count.max} end=${aggregated.handle_count.end}`);
      }
      io.unlinkSync(observerPoolPath);
    } catch (err) {
      console.error(`Could not read observer pool samples from ${observerPoolPath}: ${errorMessage(err)}`);
    }
  }

  // DDP messages: in-app counter dumps RAW in/out counts per type +
  // the start/end window; we compute per-second rates here. Omitted
  // when no messages were observed (absence convention → aggregator
  // returns null).
  if (ddpMessagePath && io.existsSync(ddpMessagePath)) {
    try {
      const dump = parseJson(io.readFileSync(ddpMessagePath, 'utf8'));
      const aggregated = aggregateDdpMessages(dump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        console.log(`DDP messages: ${aggregated.total_in} in (${aggregated.in_per_sec}/s), ${aggregated.total_out} out (${aggregated.out_per_sec}/s)`);
      }
      io.unlinkSync(ddpMessagePath);
    } catch (err) {
      console.error(`Could not read DDP message counts from ${ddpMessagePath}: ${errorMessage(err)}`);
    }
  }

  // Frame size: in-app counter dumps raw per-message byte sizes + per-type
  // byte sums; we compute in/out size percentiles here. Omitted entirely
  // when no messages were observed (absence convention → aggregator returns
  // null). NOTE: we keep the parsed dump in scope so the compression
  // aggregator below can pair it with the post-compression socket totals.
  let frameSizeDump: unknown = null;
  if (frameSizePath && io.existsSync(frameSizePath)) {
    try {
      frameSizeDump = parseJson(io.readFileSync(frameSizePath, 'utf8'));
      const aggregated = aggregateFrameSize(frameSizeDump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        console.log(`DDP frame size: in avg=${aggregated.in.avg_bytes}B p95=${aggregated.in.p95_bytes}B, out avg=${aggregated.out.avg_bytes}B p95=${aggregated.out.p95_bytes}B`);
      }
      io.unlinkSync(frameSizePath);
    } catch (err) {
      console.error(`Could not read DDP frame sizes from ${frameSizePath}: ${errorMessage(err)}`);
    }
  }

  // Compression: needs BOTH the post-compression socket totals (own dump)
  // AND the pre-compression byte sums (frameSize dump above). If either is
  // missing the aggregator returns null and we omit the key.
  if (compressionPath && io.existsSync(compressionPath)) {
    try {
      const compressionDump = parseJson(io.readFileSync(compressionPath, 'utf8'));
      const aggregated = aggregateCompression({ frameSize: frameSizeDump, compression: compressionDump });
      if (aggregated) {
        results.push(collectorResult(aggregated));
        const outRatio = aggregated.out.ratio == null ? 'n/a' : `${aggregated.out.savings_pct}%`;
        const inRatio = aggregated.in.ratio == null ? 'n/a' : `${aggregated.in.savings_pct}%`;
        console.log(`DDP compression: out savings=${outRatio} (${aggregated.out.compressed_bytes}/${aggregated.out.uncompressed_bytes}), in savings=${inRatio} (${aggregated.in.compressed_bytes}/${aggregated.in.uncompressed_bytes})`);
      }
      io.unlinkSync(compressionPath);
    } catch (err) {
      console.error(`Could not read DDP compression from ${compressionPath}: ${errorMessage(err)}`);
    }
  }

  // Driver fallback: in-app tracker dumps pre-aggregated counts; we just
  // pass through (with absence-convention guard) and emit a console line.
  if (driverFallbackPath && io.existsSync(driverFallbackPath)) {
    try {
      const dump = parseJson(io.readFileSync(driverFallbackPath, 'utf8'));
      const aggregated = aggregateDriverFallback(dump);
      if (aggregated) {
        results.push(collectorResult(aggregated));
        const fallbackCount = aggregated.total_cursors - aggregated.no_fallback;
        console.log(`Driver fallbacks: ${aggregated.total_cursors} observe(s), ${fallbackCount} fell back from ${aggregated.configured_first}`);
      }
      io.unlinkSync(driverFallbackPath);
    } catch (err) {
      console.error(`Could not read driver-fallback dump from ${driverFallbackPath}: ${errorMessage(err)}`);
    }
  }

  return results;
}

// gc-monitor writes its output file on Meteor's SIGTERM, so the gc result may
// only appear after stopMeteorApp returns. stopCollectors reads it once during
// its own drain (1s); this re-checks after stopMeteorApp's grace period in
// case Meteor took longer than the collector drain to flush. Returns [] when
// no late-arriving gc data is found.
/** Drains a GC metric that arrived after the initial collector shutdown window. */
export function drainPostStopGc(gcOutputPath?: string): CollectorResult[] {
  if (!gcOutputPath || !io.existsSync(gcOutputPath)) return [];
  try {
    const parsedGc = parseJson(io.readFileSync(gcOutputPath, 'utf8'));
    if (!isJsonObject(parsedGc)) throw new TypeError('GC output must be a JSON object.');
    const gcData = collectorResult(parsedGc);
    console.log(`GC (late): ${String(parsedGc.count)} collections, ${String(parsedGc.total_pause_ms)}ms total pause`);
    io.unlinkSync(gcOutputPath);
    return [gcData];
  } catch (err) {
    console.error(`Could not read late GC metrics from ${gcOutputPath}: ${errorMessage(err)}`);
    return [];
  }
}

/** Drains and validates a late observer-driver fallback metric. */
export function drainPostStopDriverFallback(driverFallbackPath?: string): CollectorResult[] {
  if (!driverFallbackPath || !io.existsSync(driverFallbackPath)) return [];
  try {
    const dump = parseJson(io.readFileSync(driverFallbackPath, 'utf8'));
    io.unlinkSync(driverFallbackPath);
    const aggregated = aggregateDriverFallback(dump);
    return aggregated ? [aggregated] : [];
  } catch (err) {
    console.error(`Could not read late driver-fallback metrics from ${driverFallbackPath}: ${errorMessage(err)}`);
    return [];
  }
}
