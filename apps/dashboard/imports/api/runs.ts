import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { normalizeRunResult } from './run-contract';

export interface RunDocument extends Record<string, unknown> {
  _id?: string;
  timestamp: Date;
  tag: string;
  scenario: string;
  app?: string;
  source?: string;
  prNumber?: number;
  wall_clock_ms?: number;
  meteor?: { version?: string; sha?: string };
  runtime?: {
    channel?: string;
    version?: string;
    observer_driver_actual?: string;
    transport?: string;
    [key: string]: unknown;
  };
  metrics?: {
    app_resources?: {
      cpu?: { avg?: number; max?: number };
      memory?: { avg_mb?: number; max_mb?: number };
    };
    gc?: {
      total_pause_ms?: number;
      max_pause_ms?: number;
      count?: number;
      avg_pause_ms?: number;
      minor?: { count?: number; total_ms?: number };
      major?: { count?: number; total_ms?: number };
    };
    change_stream_audit?: {
      status?: string; profile?: string; requested_driver?: string; actual_driver?: string;
      transport?: string; converged_subscribers?: number; subscribers?: number;
      final_state_mismatches?: number; digest_mismatches?: number;
      out_of_order_events?: number; foreign_events?: number; observed_events?: number;
      propagation_p95?: number; generated_bson_bytes?: number;
      failure_reasons?: string[];
      capabilities?: Array<{ id: string; support: string; audit_status: string }>;
    };
    db_resources?: {
      cpu?: { avg?: number; max?: number };
      memory?: { avg_mb?: number; max_mb?: number };
    };
    ddp_methods?: {
      total_calls?: number;
      methods?: Record<string, { avg_ms?: number; count?: number; p95?: number; p99?: number; max_ms?: number }>;
    };
    ddp_subscriptions?: {
      total_subs?: number;
      publications?: Record<string, { avg_ms?: number; count?: number; p95?: number; p99?: number; max_ms?: number }>;
    };
    live_update_propagation?: {
      p95?: number; avg_ms?: number; max_ms?: number; observed_updates?: number;
      p50?: number; p99?: number;
    };
    ddp_messages?: {
      total_out?: number; out_per_sec?: number; total_in?: number; in_per_sec?: number; duration_s?: number;
      by_type?: { in?: Record<string, number>; out?: Record<string, number> };
    };
    mongo_ops?: { totals?: Record<string, number>; ops_per_sec?: Record<string, number>; duration_s?: number };
    mongo_pool?: {
      samples?: number; interval_ms?: number; current?: NumericSummary;
      active?: NumericSummary; total_created?: { start?: number; end?: number; delta?: number };
    };
    build_profile?: {
      total_ms?: number; top_n_count?: number; top_n_total_ms?: number; long_tail_ms?: number;
      top_nodes?: Array<{ name?: string; self_ms?: number; children_ms?: number; count?: number }>;
    };
    plugin_compile?: {
      total_plugin_ms?: number;
      plugins?: Record<string, { self_ms?: number; count?: number }>;
    };
    ddp_frame_size?: {
      in?: MetricDistribution;
      out?: MetricDistribution;
    };
    ddp_compression?: {
      in?: CompressionDistribution;
      out?: CompressionDistribution;
    };
    mongo_slow_queries?: {
      total_slow?: number; threshold_ms?: number; by_op?: Record<string, number>;
      slowest_sample?: { ns?: string; op?: string; millis?: number; filter_keys?: string[]; planSummary?: string };
    };
    mongo_index_usage?: {
      collections?: Record<string, Array<{
        name?: string; key?: Record<string, unknown>; ops_in_window?: number; since?: string;
      }>>;
    };
    mongo_changestream?: {
      samples?: number; interval_ms?: number; cursor_count?: NumericSummary;
      by_namespace?: Record<string, NumericSummary>;
    };
    mongo_wiredtiger?: {
      cache_hit_ratio?: number; pages_requested_in_window?: number;
      pages_read_into_cache?: number; pages_written_from_cache?: number;
      bytes_in_cache_end?: number;
    };
    observer_pool?: {
      samples?: number; interval_ms?: number;
      multiplexer_count?: NumericSummary; handle_count?: NumericSummary;
    };
    driver_fallbacks?: {
      configured_first?: string; total_cursors?: number; no_fallback?: number;
      fallbacks?: Record<string, number>;
    };
    [key: string]: unknown;
  };
}

export interface NumericSummary {
  min?: number; max?: number; avg?: number; end?: number;
}

export interface MetricDistribution extends NumericSummary {
  count?: number; avg_bytes?: number; p50_bytes?: number; p95_bytes?: number;
  p99_bytes?: number; max_bytes?: number;
}

export interface CompressionDistribution {
  uncompressed_bytes?: number; compressed_bytes?: number; ratio?: number; savings_pct?: number;
}

const Runs = new Mongo.Collection<RunDocument>('runs');

// Recursively replace '.' in object keys with '_'. Mongo allows dots
// server-side but minimongo (client) rejects them, breaking the publication
// for every connected client. Some bench collectors index by Mongo namespace
// (`<db>.<collection>`) — e.g. `metrics.mongo_changestream.by_namespace`.
function sanitizeKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  // Pass non-plain objects (Date, etc.) through untouched — recursing would
  // rebuild them as {} (a Date has no own enumerable keys), which is how the
  // `timestamp` field was getting stored as an empty object and rendering as
  // "Invalid Date" on the dashboard.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizeKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k.replace(/\./g, '_')] = sanitizeKeys(v);
  }
  return out;
}

/**
 * Validates and inserts one canonical benchmark result.
 *
 * Keeping every ingestion path behind this service prevents a
 * dashboard-launched audit from bypassing the same result contract used by
 * CLI uploads.
 *
 * @param {unknown} resultJson Untrusted result envelope.
 * @returns {Promise<string>} Inserted run identifier.
 */
async function insertRunResult(resultJson: unknown): Promise<string> {
  const normalized = normalizeRunResult(resultJson);
  return await Runs.insertAsync(sanitizeKeys(normalized) as RunDocument);
}

// Deny all direct client-side writes — only server methods allowed
Runs.deny({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});

if (Meteor.isServer) {
  Runs.createIndexAsync({ timestamp: -1 });
  Runs.createIndexAsync({ tag: 1, scenario: 1 });

  Meteor.publish('runs.recent', function (limit = 50) {
    check(limit, Number);
    return Runs.find({}, { sort: { timestamp: -1 }, limit: Math.min(limit, 200) });
  });

  Meteor.publish('runs.byTag', function (tag) {
    check(tag, String);
    return Runs.find({ tag }, { sort: { timestamp: -1 } });
  });

  Meteor.publish('runs.forCompare', function (tagA: string, tagB: string, scenario?: string) {
    check(tagA, String);
    check(tagB, String);
    check(scenario, Match.Maybe(String));
    const query: { tag: { $in: string[] }; scenario?: string } = { tag: { $in: [tagA, tagB] } };
    if (scenario) query.scenario = scenario;
    return Runs.find(query, { sort: { timestamp: -1 } });
  });

  Meteor.publish('runs.single', function (runId) {
    check(runId, String);
    return Runs.find({ _id: runId });
  });

  Meteor.methods({
    async 'runs.insert'(apiKey, resultJson) {
      check(apiKey, String);
      check(resultJson, Object);

      const expectedKey = Meteor.settings?.benchApiKey;
      if (!expectedKey || apiKey !== expectedKey) {
        throw new Meteor.Error('unauthorized', 'Invalid API key');
      }

      return await insertRunResult(resultJson);
    },

    // Wipe all stored runs. Authenticated by the same benchApiKey as
    // runs.insert so the CLI (`bench.js clear`) can purge the dashboard
    // before a fresh benchmark sweep. Returns the number removed.
    async 'runs.clear'(apiKey) {
      check(apiKey, String);

      const expectedKey = Meteor.settings?.benchApiKey;
      if (!expectedKey || apiKey !== expectedKey) {
        throw new Meteor.Error('unauthorized', 'Invalid API key');
      }

      return await Runs.removeAsync({});
    },

    async 'runs.distinctTags'() {
      const runs = await Runs.find({}, { fields: { tag: 1 }, sort: { timestamp: -1 } }).fetchAsync();
      return [...new Set(runs.map((r) => r.tag))];
    },

    async 'runs.distinctScenarios'() {
      const runs = await Runs.find({}, { fields: { scenario: 1 } }).fetchAsync();
      return [...new Set(runs.map((r) => r.scenario))];
    },
  });
}

export { Runs, insertRunResult };
