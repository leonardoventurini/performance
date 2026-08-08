// buildResult is pure as of commit 7: it takes meteor: {version, sha} as input
// and no longer shells out to git. The dashboard JSON contract (top-level
// timestamp/tag/meteor.{version,sha}/scenario/app/wall_clock_ms/metrics + nested
// metric keys) is preserved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildResult, collectorResult } from '../../reporters/json-reporter.js';
import type { BenchmarkResult, CollectorResult } from '../../reporters/json-reporter.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertBenchmarkResult(value: unknown): asserts value is BenchmarkResult {
  assert.ok(isRecord(value));
  assert.equal(typeof value.timestamp, 'string');
  assert.equal(typeof value.tag, 'string');
  assert.ok(isRecord(value.meteor));
  assert.equal(typeof value.meteor.version, 'string');
  assert.equal(typeof value.meteor.sha, 'string');
  assert.ok(isRecord(value.runtime));
  assert.equal(typeof value.scenario, 'string');
  assert.equal(typeof value.app, 'string');
  assert.equal(typeof value.wall_clock_ms, 'number');
  assert.ok(isRecord(value.metrics));
  for (const metric of Object.values(value.metrics)) {
    assert.ok(isRecord(metric));
    assert.equal(typeof metric.metric, 'string');
  }
}

const load = (name: string): BenchmarkResult => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  assertBenchmarkResult(parsed);
  return parsed;
};

const METEOR = { version: 'release/3.5', sha: 'abc1234' };

describe('buildResult — runtime field (commit 16 addition)', () => {
  test('defaults runtime to empty object when caller omits it (e.g. bundle-size driver)', () => {
    const result = buildResult({
      scenario: 'bundle-size', app: 'tasks-3.x', tag: 't',
      meteor: METEOR, collectorResults: [], wallClockMs: 0,
    });
    assert.deepEqual(result.runtime, {});
  });

  test('passes runtime through verbatim when caller provides it (artillery/script/cold-start drivers)', () => {
    const runtime = { observer_driver: 'oplog', transport: 'uws' };
    const result = buildResult({
      scenario: 'reactive-light', app: 'tasks-3.x', tag: 't',
      meteor: METEOR, runtime, collectorResults: [], wallClockMs: 0,
    });
    assert.deepEqual(result.runtime, runtime);
  });

  test('runtime sits at top level (peer of meteor, not nested under it)', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteor: METEOR, runtime: { observer_driver: 'changeStreams', transport: 'sockjs' },
      collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.runtime.observer_driver, 'changeStreams');
    assert.equal(result.meteor.sha, METEOR.sha);
    assert.equal('runtime' in result.meteor, false, 'runtime is NOT nested under meteor');
  });
});

describe('buildResult — top-level shape', () => {
  test('returns dashboard-contract fields with no collectors', () => {
    const before = Date.now();
    const result = buildResult({
      scenario: 'reactive-light',
      app: 'tasks-3.x',
      tag: 'mytag',
      meteor: METEOR,
      collectorResults: [],
      wallClockMs: 1234,
    });
    const after = Date.now();

    assert.equal(result.tag, 'mytag');
    assert.equal(result.scenario, 'reactive-light');
    assert.equal(result.app, 'tasks-3.x');
    assert.equal(result.wall_clock_ms, 1234);
    assert.deepEqual(result.meteor, METEOR);
    assert.deepEqual(result.metrics, {});

    const ts = Date.parse(result.timestamp);
    assert.ok(!Number.isNaN(ts), 'timestamp is a parseable ISO 8601 string');
    assert.ok(ts >= before && ts <= after, 'timestamp is roughly now');
    assert.match(result.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('every required top-level field is present', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteor: METEOR, collectorResults: [], wallClockMs: 0,
    });
    for (const key of ['timestamp', 'tag', 'meteor', 'runtime', 'scenario', 'app', 'wall_clock_ms', 'metrics']) {
      assert.ok(key in result, `missing top-level key: ${key}`);
    }
    assert.ok('version' in result.meteor && 'sha' in result.meteor);
  });

  test('meteor input is passed through byte-for-byte (no shelling, no mutation)', () => {
    const input = { version: 'devel', sha: 'release:3.1.2' };
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteor: input, collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.meteor.version, 'devel');
    assert.equal(result.meteor.sha, 'release:3.1.2');
    assert.deepEqual(input, { version: 'devel', sha: 'release:3.1.2' });
  });

  test('throws if meteor info is omitted (no silent "unknown" fallback)', () => {
    assert.throws(
      () => Reflect.apply(buildResult, undefined, [{
        scenario: 's', app: 'a', tag: 't',
        collectorResults: [], wallClockMs: 0,
      }]),
      /meteor/,
    );
  });
});

describe('buildResult — tag fallback', () => {
  test('falls back to meteor.version when tag is undefined', () => {
    const result = buildResult({
      scenario: 's', app: 'a',
      meteor: { version: 'release/3.5', sha: 'abc1234' },
      collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.tag, 'release/3.5');
  });

  test('explicit tag wins over the fallback', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: 'my-explicit-tag',
      meteor: METEOR, collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.tag, 'my-explicit-tag');
  });

  test('empty-string tag falls back to meteor.version (|| semantics)', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: '',
      meteor: { version: 'devel', sha: 'def' },
      collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.tag, 'devel');
  });
});

describe('buildResult — metrics keying', () => {
  test('collector contracts reject unknown identities and malformed known payloads', () => {
    assert.throws(() => collectorResult({ metric: 'invented', count: 1 }), /known metric identifier/);
    assert.throws(() => collectorResult({ metric: 'gc', count: 1 }), /missing required fields: total_pause_ms/);
    assert.throws(
      () => collectorResult({ metric: 'gc', count: 'one', total_pause_ms: 1 }),
      /invalid fields: count/,
    );
  });

  test('collectorResults are keyed by r.metric in result.metrics', () => {
    const collectorResults = [
      { metric: 'app_resources', name: 'APP', cpu: { avg: 10 }, memory: { avg_mb: 20 } },
      { metric: 'gc', count: 5, total_pause_ms: 10 },
    ] satisfies readonly CollectorResult[];
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteor: METEOR, collectorResults, wallClockMs: 0,
    });
    assert.deepEqual(Object.keys(result.metrics).sort(), ['app_resources', 'gc']);
    assert.deepEqual(result.metrics.app_resources, collectorResults[0]);
    assert.deepEqual(result.metrics.gc, collectorResults[1]);
  });

  test('dashboard contract keys round-trip through buildResult', () => {
    const baseline = load('baseline.json');
    const result = buildResult({
      scenario: baseline.scenario,
      app: baseline.app,
      tag: baseline.tag,
      meteor: baseline.meteor,
      collectorResults: Object.values(baseline.metrics) satisfies readonly CollectorResult[],
      wallClockMs: baseline.wall_clock_ms,
    });
    assert.deepEqual(
      Object.keys(result.metrics).sort(),
      ['app_resources', 'db_resources', 'event_loop_delay', 'gc']
    );
    assert.deepEqual(result.metrics.app_resources, baseline.metrics.app_resources);
    assert.deepEqual(result.metrics.gc, baseline.metrics.gc);
    assert.deepEqual(result.metrics.event_loop_delay, baseline.metrics.event_loop_delay);
    assert.deepEqual(result.meteor, baseline.meteor);
  });

  test('duplicate collector metrics are rejected instead of silently overwritten', () => {
    assert.throws(() => buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteor: METEOR,
      collectorResults: [
        { metric: 'gc', count: 1, total_pause_ms: 1 },
        { metric: 'gc', count: 99, total_pause_ms: 2 },
      ],
      wallClockMs: 0,
    }), /Duplicate collector metric: gc/);
  });
});
