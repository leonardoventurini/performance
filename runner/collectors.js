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

const HERE = import.meta.dirname;
const PROCESS_MONITOR = path.resolve(HERE, '..', 'collectors', 'process-monitor.js');
const GC_MONITOR = path.resolve(HERE, '..', 'collectors', 'gc-monitor.cjs');
const MONGO_OPS_MONITOR = path.resolve(HERE, '..', 'collectors', 'mongo-ops-monitor.js');
const RESULTS_DIR = path.resolve(HERE, '..', 'results');
const COLLECTOR_DRAIN_MS = 1000;

export function prepareGcOutput(tag) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return {
    gcMonitorPath: GC_MONITOR,
    gcOutputPath: path.join(RESULTS_DIR, `gc-${tag}-${Date.now()}.json`),
  };
}

// Path the in-app method-timing collector dumps to on Meteor's SIGTERM.
// Passed through startMeteorApp's METHOD_TIMING_OUTPUT env var and read
// here in stopCollectors.
export function prepareMethodTimingOutput(tag) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `method-timing-${tag}-${Date.now()}.json`);
}

// Same pattern as prepareMethodTimingOutput, for the sub-timing collector
// (SUB_TIMING_OUTPUT env var → metrics.ddp_subscriptions).
export function prepareSubTimingOutput(tag) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `sub-timing-${tag}-${Date.now()}.json`);
}

// Same pattern, for propagation-timing (PROPAGATION_TIMING_OUTPUT env var
// → metrics.live_update_propagation).
export function preparePropagationTimingOutput(tag) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `propagation-timing-${tag}-${Date.now()}.json`);
}

// Same pattern, for the observer-pool sampler (OBSERVER_POOL_OUTPUT env var
// → metrics.observer_pool). The in-app sampler dumps RAW samples; we
// aggregate to min/max/avg/end in stopCollectors.
export function prepareObserverPoolOutput(tag) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `observer-pool-${tag}-${Date.now()}.json`);
}

// Same pattern, for the ddp-message counter (DDP_MESSAGE_OUTPUT env var
// → metrics.ddp_messages). The in-app counter dumps RAW in/out counts
// per message type; we compute per-second rates in stopCollectors.
export function prepareDdpMessageOutput(tag) {
  if (!io.existsSync(RESULTS_DIR)) io.mkdirSync(RESULTS_DIR, { recursive: true });
  return path.join(RESULTS_DIR, `ddp-messages-${tag}-${Date.now()}.json`);
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
export function aggregateMethodTiming(samplesByMethod) {
  const methods = {};
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
export function aggregateSubTiming(samplesByPub) {
  const publications = {};
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
export function aggregatePropagationTiming(samplesArr) {
  const stats = summarize(samplesArr || []);
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

function spawnProcessMonitor(pid, name) {
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
function spawnMongoOpsMonitor(mongoUri) {
  const proc = io.spawn('node', [MONGO_OPS_MONITOR, mongoUri], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  return { proc, name: 'MONGO_OPS', getResult: () => stdout };
}

export function startCollectors({ appName, mongoUri, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath }) {
  const procs = [];

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
  }

  return { procs, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath };
}

export async function stopCollectors({ procs, gcOutputPath, methodTimingPath, subTimingPath, propagationTimingPath, observerPoolPath, ddpMessagePath }) {
  const results = [];

  for (const { proc, name, getResult } of procs) {
    proc.kill('SIGTERM');
    await io.sleep(COLLECTOR_DRAIN_MS);
    const raw = getResult().trim();
    if (!raw) continue;
    try {
      results.push(JSON.parse(raw));
    } catch (err) {
      console.error(`Dropping malformed JSON from ${name} collector: ${err.message}`);
    }
  }

  if (gcOutputPath && io.existsSync(gcOutputPath)) {
    try {
      const gcData = JSON.parse(io.readFileSync(gcOutputPath, 'utf8'));
      results.push(gcData);
      console.log(`GC: ${gcData.count} collections, ${gcData.total_pause_ms}ms total pause, ${gcData.max_pause_ms}ms max`);
      if (gcData.minor && gcData.major) {
        console.log(`  Minor: ${gcData.minor.count} (${gcData.minor.total_ms}ms) | Major: ${gcData.major.count} (${gcData.major.total_ms}ms)`);
      }
      io.unlinkSync(gcOutputPath);
    } catch (err) {
      console.error(`Could not read GC metrics from ${gcOutputPath}: ${err.message}`);
    }
  }

  // Method timing: in-app collector dumps the raw samples Map; we aggregate
  // into the ddp_methods shape here. If the file doesn't exist (the app
  // didn't run with METHOD_TIMING_OUTPUT set) we omit the metric entirely
  // per the absence convention.
  if (methodTimingPath && io.existsSync(methodTimingPath)) {
    try {
      const dump = JSON.parse(io.readFileSync(methodTimingPath, 'utf8'));
      const aggregated = aggregateMethodTiming(dump);
      if (aggregated) {
        results.push(aggregated);
        console.log(`DDP methods: ${aggregated.total_calls} calls across ${Object.keys(aggregated.methods).length} methods`);
      }
      io.unlinkSync(methodTimingPath);
    } catch (err) {
      console.error(`Could not read method timing from ${methodTimingPath}: ${err.message}`);
    }
  }

  // Sub timing: same pattern, different env var + aggregator + key shape.
  if (subTimingPath && io.existsSync(subTimingPath)) {
    try {
      const dump = JSON.parse(io.readFileSync(subTimingPath, 'utf8'));
      const aggregated = aggregateSubTiming(dump);
      if (aggregated) {
        results.push(aggregated);
        console.log(`DDP subscriptions: ${aggregated.total_subs} subs across ${Object.keys(aggregated.publications).length} publications`);
      }
      io.unlinkSync(subTimingPath);
    } catch (err) {
      console.error(`Could not read sub timing from ${subTimingPath}: ${err.message}`);
    }
  }

  // Propagation timing: flat array of write-to-emit latencies.
  if (propagationTimingPath && io.existsSync(propagationTimingPath)) {
    try {
      const dump = JSON.parse(io.readFileSync(propagationTimingPath, 'utf8'));
      const aggregated = aggregatePropagationTiming(dump);
      if (aggregated) {
        results.push(aggregated);
        console.log(`Live-update propagation: ${aggregated.observed_updates} observed updates, p50=${aggregated.p50}ms p95=${aggregated.p95}ms`);
      }
      io.unlinkSync(propagationTimingPath);
    } catch (err) {
      console.error(`Could not read propagation timing from ${propagationTimingPath}: ${err.message}`);
    }
  }

  // Observer pool: in-app sampler dumps { interval_ms, samples } (raw
  // per-tick mux/handle counts); we aggregate to min/max/avg/end here.
  if (observerPoolPath && io.existsSync(observerPoolPath)) {
    try {
      const dump = JSON.parse(io.readFileSync(observerPoolPath, 'utf8'));
      const aggregated = aggregateObserverPool(dump);
      if (aggregated) {
        results.push(aggregated);
        console.log(`Observer pool: ${aggregated.samples} samples, multiplexers max=${aggregated.multiplexer_count.max} end=${aggregated.multiplexer_count.end}, handles max=${aggregated.handle_count.max} end=${aggregated.handle_count.end}`);
      }
      io.unlinkSync(observerPoolPath);
    } catch (err) {
      console.error(`Could not read observer pool samples from ${observerPoolPath}: ${err.message}`);
    }
  }

  // DDP messages: in-app counter dumps RAW in/out counts per type +
  // the start/end window; we compute per-second rates here. Omitted
  // when no messages were observed (absence convention → aggregator
  // returns null).
  if (ddpMessagePath && io.existsSync(ddpMessagePath)) {
    try {
      const dump = JSON.parse(io.readFileSync(ddpMessagePath, 'utf8'));
      const aggregated = aggregateDdpMessages(dump);
      if (aggregated) {
        results.push(aggregated);
        console.log(`DDP messages: ${aggregated.total_in} in (${aggregated.in_per_sec}/s), ${aggregated.total_out} out (${aggregated.out_per_sec}/s)`);
      }
      io.unlinkSync(ddpMessagePath);
    } catch (err) {
      console.error(`Could not read DDP message counts from ${ddpMessagePath}: ${err.message}`);
    }
  }

  return results;
}

// gc-monitor writes its output file on Meteor's SIGTERM, so the gc result may
// only appear after stopMeteorApp returns. stopCollectors reads it once during
// its own drain (1s); this re-checks after stopMeteorApp's grace period in
// case Meteor took longer than the collector drain to flush. Returns [] when
// no late-arriving gc data is found.
export function drainPostStopGc(gcOutputPath) {
  if (!gcOutputPath || !io.existsSync(gcOutputPath)) return [];
  try {
    const gcData = JSON.parse(io.readFileSync(gcOutputPath, 'utf8'));
    console.log(`GC (late): ${gcData.count} collections, ${gcData.total_pause_ms}ms total pause`);
    io.unlinkSync(gcOutputPath);
    return [gcData];
  } catch (err) {
    console.error(`Could not read late GC metrics from ${gcOutputPath}: ${err.message}`);
    return [];
  }
}
