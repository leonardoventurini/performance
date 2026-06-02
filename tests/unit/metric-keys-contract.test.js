// CC-3 (test-architect cross-cutting): single test that freezes the
// allowed top-level result-JSON keys AND the allowed `metrics.*` keys.
// Each new metric task extends ALLOWED_METRIC_KEYS by exactly one entry.
// Catches accidental key renames (which would break the dashboard) AND
// accidental new top-level fields (which would silently bypass the
// dashboard schema).
//
// Test runs over every fixture under tests/unit/fixtures/ so existing
// fixtures are continuously validated as the contract evolves.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Top-level fields the dashboard reads from EVERY result JSON.
// Adding a new top-level field requires a dashboard schema update;
// this set is the single source of "what the dashboard knows about".
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'timestamp',
  'tag',
  'meteor',
  'runtime',
  'scenario',
  'app',
  'wall_clock_ms',
  'metrics',
]);

// `metrics.*` keys. Each metric task that adds a key extends this set
// by ONE line + a one-line comment citing the task number.
const ALLOWED_METRIC_KEYS = new Set([
  // Original keys (pre-refactor harness):
  'app_resources',     // process-monitor APP
  'db_resources',      // process-monitor DB
  'gc',                // gc-monitor
  'event_loop_delay',  // event-loop-monitor

  // Driver-specific (one per driver, mutually exclusive with the above):
  'bundle_size',       // bundle-size driver
  'cold_start',        // cold-start driver
  'fanout',            // script driver (fanout-bench)

  // Phase A metrics:
  'ddp_methods',              // task 01 — DDP method latency
  'ddp_subscriptions',        // task 02 — Subscription ready latency
  'live_update_propagation',  // task 03 — Live-update propagation latency
  'mongo_ops',                // task 04 — Mongo opcounters (insert/query/update/delete/getmore/command rates)
  'observer_pool',            // task 05 — Active observer multiplexer + handle count (min/max/avg/end)

  // Phase B metrics:
  'ddp_messages',             // task 07 — DDP message rate (in/out counts + per-sec, by_type)
  'mongo_slow_queries',       // task 12 — Mongo slow-query profile aggregation
]);

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

describe('metric-keys contract (CC-3)', () => {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    test(`${file}: only uses known top-level + metric keys`, () => {
      const result = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
      for (const key of Object.keys(result)) {
        assert.ok(
          ALLOWED_TOP_LEVEL_KEYS.has(key),
          `${file}: unknown top-level key "${key}" — add to ALLOWED_TOP_LEVEL_KEYS in this test (and to the dashboard).`,
        );
      }
      for (const key of Object.keys(result.metrics || {})) {
        assert.ok(
          ALLOWED_METRIC_KEYS.has(key),
          `${file}: unknown metric key "metrics.${key}" — add to ALLOWED_METRIC_KEYS in this test (with a comment citing the metric task that introduces it).`,
        );
      }
    });
  }

  test('the contract test itself runs over at least one fixture', () => {
    assert.ok(files.length > 0, 'no fixtures found — contract test is vacuous');
  });
});
