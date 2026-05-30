// Commit 6 scope: cover the pure paths of buildResult — top-level shape, tag
// fallback (without checkout), and metric keying. The git-shelling branch
// (meteorCheckoutPath set) is deliberately NOT covered here: mocking
// `node:child_process.execSync` requires `mock.method` against a frozen
// namespace export, which fails with "Cannot redefine property: execSync".
//
// Per the user's "less is more" preference, we don't fight stdlib for code
// that's about to be deleted: commit 7 makes buildResult take meteor:
// {version, sha} as a pure input (the execSync calls go away entirely), and
// commit 7 will add tests asserting that purity directly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildResult } from '../../reporters/json-reporter.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

describe('buildResult — top-level shape', () => {
  test('returns dashboard-contract fields with no checkout and no collectors', () => {
    const before = Date.now();
    const result = buildResult({
      scenario: 'reactive-light',
      app: 'tasks-3.x',
      tag: 'mytag',
      meteorCheckoutPath: null,
      collectorResults: [],
      wallClockMs: 1234,
    });
    const after = Date.now();

    assert.equal(result.tag, 'mytag');
    assert.equal(result.scenario, 'reactive-light');
    assert.equal(result.app, 'tasks-3.x');
    assert.equal(result.wall_clock_ms, 1234);
    assert.deepEqual(result.meteor, { version: 'unknown', sha: 'unknown' });
    assert.deepEqual(result.metrics, {});

    const ts = Date.parse(result.timestamp);
    assert.ok(!Number.isNaN(ts), 'timestamp is a parseable ISO 8601 string');
    assert.ok(ts >= before && ts <= after, 'timestamp is roughly now');
    assert.match(result.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('every required top-level field is present', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteorCheckoutPath: null, collectorResults: [], wallClockMs: 0,
    });
    for (const key of ['timestamp', 'tag', 'meteor', 'scenario', 'app', 'wall_clock_ms', 'metrics']) {
      assert.ok(key in result, `missing top-level key: ${key}`);
    }
    assert.ok('version' in result.meteor && 'sha' in result.meteor);
  });
});

describe('buildResult — tag fallback', () => {
  test('falls back to meteor.version ("unknown") when tag is undefined and no checkout', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: undefined,
      meteorCheckoutPath: null, collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.tag, 'unknown');
  });

  test('explicit tag wins over the fallback', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: 'my-explicit-tag',
      meteorCheckoutPath: null, collectorResults: [], wallClockMs: 0,
    });
    assert.equal(result.tag, 'my-explicit-tag');
  });
});

describe('buildResult — metrics keying', () => {
  test('collectorResults are keyed by r.metric in result.metrics', () => {
    const collectorResults = [
      { metric: 'app_resources', name: 'APP', cpu: { avg: 10 } },
      { metric: 'gc', count: 5 },
    ];
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteorCheckoutPath: null, collectorResults, wallClockMs: 0,
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
      meteorCheckoutPath: null,
      collectorResults: Object.values(baseline.metrics),
      wallClockMs: baseline.wall_clock_ms,
    });
    assert.deepEqual(
      Object.keys(result.metrics).sort(),
      ['app_resources', 'db_resources', 'event_loop_delay', 'gc']
    );
    assert.deepEqual(result.metrics.app_resources, baseline.metrics.app_resources);
    assert.deepEqual(result.metrics.gc, baseline.metrics.gc);
    assert.deepEqual(result.metrics.event_loop_delay, baseline.metrics.event_loop_delay);
  });

  test('later collectorResults with duplicate metric overwrite earlier ones', () => {
    const result = buildResult({
      scenario: 's', app: 'a', tag: 't',
      meteorCheckoutPath: null,
      collectorResults: [
        { metric: 'gc', count: 1 },
        { metric: 'gc', count: 99 },
      ],
      wallClockMs: 0,
    });
    assert.equal(result.metrics.gc.count, 99);
  });
});
