import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compare, toMarkdown } from '../../reporters/regression-detector.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (obj) => JSON.parse(JSON.stringify(obj));

describe('compare() — happy paths', () => {
  test('passing run: all deltas under warn thresholds', () => {
    const report = compare(load('baseline.json'), load('target.json'));
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.failures, 0);
    assert.equal(report.summary.warnings, 0);
    assert.equal(report.summary.baseline_tag, 'v3.5-baseline');
    assert.equal(report.summary.target_tag, 'devel-pass');
    assert.equal(report.summary.scenario, 'reactive-light');
    for (const d of report.details) assert.equal(d.status, 'ok');
    // deltas are rounded to 2 decimals
    for (const d of report.details) {
      assert.equal(d.delta, +d.delta.toFixed(2));
    }
  });

  test('regression run: multiple FAIL crossings', () => {
    const report = compare(load('baseline.json'), load('target-regression.json'));
    assert.equal(report.summary.passed, false);
    assert.ok(report.summary.failures >= 3, `expected >=3 failures, got ${report.summary.failures}`);
    // wall_clock_ms 40000 -> 52000 is +30% (threshold fail=25)
    const wall = report.details.find((d) => d.metric === 'wall_clock_ms');
    assert.equal(wall.status, 'FAIL');
    assert.equal(wall.delta, 30);
    // APP CPU avg 20 -> 28 is +40% (threshold fail=30)
    const cpu = report.details.find((d) => d.metric === 'APP CPU avg');
    assert.equal(cpu.status, 'FAIL');
    assert.equal(cpu.delta, 40);
    // GC total pause 200 -> 320 is +60% (threshold fail=50)
    const gc = report.details.find((d) => d.metric === 'GC total pause');
    assert.equal(gc.status, 'FAIL');
    assert.equal(gc.delta, 60);
  });

  test('improvement run: every delta negative, all ok', () => {
    const report = compare(load('baseline.json'), load('target-improvement.json'));
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.failures, 0);
    assert.equal(report.summary.warnings, 0);
    for (const d of report.details) {
      assert.ok(d.delta < 0, `${d.metric} delta ${d.delta} should be negative`);
      assert.equal(d.status, 'ok');
    }
  });

  test('warn threshold crossed (wall_clock +15% with warn=10 fail=25)', () => {
    const baseline = load('baseline.json');
    const target = clone(load('target.json'));
    target.wall_clock_ms = baseline.wall_clock_ms * 1.15;
    // Strip non-wall_clock metric pairs to keep the assertion focused.
    target.metrics = {};
    const report = compare(baseline, target);
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.warnings, 1);
    assert.equal(report.summary.failures, 0);
    assert.equal(report.details[0].status, 'WARN');
  });

  test('mixed pass+warn+fail in one report', () => {
    const baseline = load('baseline.json');
    const target = clone(baseline);
    target.tag = 'mixed';
    target.wall_clock_ms = baseline.wall_clock_ms * 1.05;                                    // +5% ok
    target.metrics.app_resources.cpu.avg = baseline.metrics.app_resources.cpu.avg * 1.20;    // +20% WARN
    target.metrics.gc.total_pause_ms = baseline.metrics.gc.total_pause_ms * 1.60;            // +60% FAIL
    const report = compare(baseline, target);
    assert.ok(report.details.some((d) => d.metric === 'wall_clock_ms' && d.status === 'ok'));
    assert.ok(report.details.some((d) => d.metric === 'APP CPU avg' && d.status === 'WARN'));
    assert.ok(report.details.some((d) => d.metric === 'GC total pause' && d.status === 'FAIL'));
    assert.equal(report.summary.passed, false);
    assert.ok(report.summary.warnings >= 1);
    assert.ok(report.summary.failures >= 1);
  });
});

describe('compare() — edge cases', () => {
  test('missing metric in target: silently skipped (no row, no crash)', () => {
    const target = clone(load('target.json'));
    delete target.metrics.gc;
    const report = compare(load('baseline.json'), target);
    assert.equal(report.summary.passed, true);
    assert.ok(!report.details.some((d) => d.metric === 'GC total pause'));
    assert.ok(!report.details.some((d) => d.metric === 'GC max pause'));
  });

  test('missing metric in baseline: pair skipped (continue on !baseMetric)', () => {
    const baseline = clone(load('baseline.json'));
    delete baseline.metrics.event_loop_delay;
    const report = compare(baseline, load('target.json'));
    assert.ok(!report.details.some((d) => d.metric === 'Event loop p99'));
  });

  test('event_loop_delay p99 pair is produced when both sides present', () => {
    const report = compare(load('baseline.json'), load('target.json'));
    const p99 = report.details.find((d) => d.metric === 'Event loop p99');
    assert.ok(p99, 'expected an Event loop p99 detail row');
    assert.equal(p99.baseline, 10.0);
    assert.equal(p99.target, 10.5);
  });

  test('DB resources pair is produced (separate from APP)', () => {
    const report = compare(load('baseline.json'), load('target.json'));
    assert.ok(report.details.some((d) => d.metric === 'APP CPU avg'));
    assert.ok(report.details.some((d) => d.metric === 'DB CPU avg'));
    assert.ok(report.details.some((d) => d.metric === 'APP RAM avg'));
    assert.ok(report.details.some((d) => d.metric === 'DB RAM avg'));
  });

  test('empty target.metrics: only the wall_clock pair survives', () => {
    const target = clone(load('target.json'));
    target.metrics = {};
    const report = compare(load('baseline.json'), target);
    assert.equal(report.details.length, 1);
    assert.equal(report.details[0].metric, 'wall_clock_ms');
  });

  test('missing target.metrics entirely: only wall_clock pair, no crash', () => {
    const target = clone(load('target.json'));
    delete target.metrics;
    const report = compare(load('baseline.json'), target);
    assert.equal(report.details.length, 1);
    assert.equal(report.details[0].metric, 'wall_clock_ms');
  });

  // TODO commit 11: this asserts CURRENT (buggy) behavior. After commit 11,
  // baseVal === 0 should produce a row with { status: 'skip', reason: 'zero_baseline' }
  // instead of being silently dropped.
  test('zero baseline value is silently dropped (CURRENT buggy behavior, fixed in commit 11)', () => {
    const baseline = clone(load('baseline.json'));
    baseline.metrics.gc.total_pause_ms = 0;
    const report = compare(baseline, load('target.json'));
    assert.ok(
      !report.details.some((d) => d.metric === 'GC total pause'),
      'CURRENT behavior: zero baseline → silent skip (no row produced)'
    );
  });

  // TODO commit 11: this asserts CURRENT (buggy) behavior. After commit 11,
  // null/undefined target should become { status: 'skip', reason: 'missing_target' }
  // (using the target-non-finite.json fixture as the input for this case).
  test('null target value is silently dropped (CURRENT buggy behavior, fixed in commit 11)', () => {
    const report = compare(load('baseline.json'), load('target-non-finite.json'));
    // app_resources.cpu.avg is null in the fixture
    assert.ok(
      !report.details.some((d) => d.metric === 'APP CPU avg'),
      'CURRENT behavior: null target → silent skip (no row produced)'
    );
    // RAM and GC are still finite, so those rows should exist
    assert.ok(report.details.some((d) => d.metric === 'APP RAM avg'));
    assert.ok(report.details.some((d) => d.metric === 'GC total pause'));
  });

  // TODO commit 11: NaN target should become { status: 'skip', reason: 'non_finite' }.
  // Currently produces a row with delta: NaN, status: 'ok' (because NaN > threshold is false).
  test('NaN target value produces a row with NaN delta (CURRENT buggy behavior, fixed in commit 11)', () => {
    const baseline = load('baseline.json');
    const target = clone(load('target.json'));
    target.metrics.app_resources.cpu.avg = NaN;
    const report = compare(baseline, target);
    const cpu = report.details.find((d) => d.metric === 'APP CPU avg');
    assert.ok(cpu, 'CURRENT behavior: NaN still produces a row');
    assert.ok(Number.isNaN(cpu.delta), 'delta is NaN');
    assert.equal(cpu.status, 'ok');
  });

  // TODO commit 11: Infinity target should become { status: 'skip', reason: 'non_finite' }.
  // Currently produces a row with delta: Infinity, status: 'FAIL' (Infinity > any threshold).
  test('Infinity target value produces FAIL row (CURRENT buggy behavior, fixed in commit 11)', () => {
    const baseline = load('baseline.json');
    const target = clone(load('target.json'));
    target.metrics.app_resources.cpu.avg = Infinity;
    const report = compare(baseline, target);
    const cpu = report.details.find((d) => d.metric === 'APP CPU avg');
    assert.ok(cpu, 'CURRENT behavior: Infinity still produces a row');
    assert.equal(cpu.delta, Infinity);
    assert.equal(cpu.status, 'FAIL');
  });
});

describe('toMarkdown()', () => {
  test('passing report renders ✅ header and table', () => {
    const md = toMarkdown(compare(load('baseline.json'), load('target.json')));
    assert.match(md, /^## ✅ Benchmark: reactive-light/);
    assert.match(md, /\*\*v3\.5-baseline\*\* → \*\*devel-pass\*\*/);
    assert.match(md, /\| Metric \| Baseline \| Target \| Delta \| Status \|/);
    assert.match(md, /\|--------\|----------\|--------\|-------\|--------\|/);
  });

  test('regression report renders ❌ header and regression line', () => {
    const md = toMarkdown(compare(load('baseline.json'), load('target-regression.json')));
    assert.match(md, /^## ❌ Benchmark: reactive-light/);
    assert.match(md, /\*\*\d+ regression\(s\) detected\.\*\* Performance threshold exceeded\./);
  });

  test('warning-only report renders ⚠️ header', () => {
    const baseline = load('baseline.json');
    const target = clone(baseline);
    target.tag = 'warn-only';
    target.wall_clock_ms = baseline.wall_clock_ms * 1.15;
    target.metrics = {};
    const md = toMarkdown(compare(baseline, target));
    assert.match(md, /^## ⚠️ Benchmark:/);
    assert.doesNotMatch(md, /regression\(s\) detected/);
  });

  test('positive delta renders with + prefix', () => {
    const md = toMarkdown(compare(load('baseline.json'), load('target.json')));
    assert.match(md, /\+\d+(\.\d+)?%/);
  });

  test('negative delta renders without + prefix (just the - sign)', () => {
    const md = toMarkdown(compare(load('baseline.json'), load('target-improvement.json')));
    assert.match(md, /-\d+(\.\d+)?%/);
    // sanity: no "+-" artifact
    assert.doesNotMatch(md, /\+-/);
  });

  test('status icons: FAIL → ❌, WARN → ⚠️, ok → ✅', () => {
    const baseline = load('baseline.json');
    const target = clone(baseline);
    target.tag = 'icon-mix';
    target.wall_clock_ms = baseline.wall_clock_ms * 1.05;                                    // ok
    target.metrics.app_resources.cpu.avg = baseline.metrics.app_resources.cpu.avg * 1.20;    // WARN
    target.metrics.gc.total_pause_ms = baseline.metrics.gc.total_pause_ms * 1.60;            // FAIL
    const md = toMarkdown(compare(baseline, target));
    // The header carries the overall-status icon (❌ because there's a FAIL),
    // so check the per-row table cells specifically.
    assert.ok(md.includes('| wall_clock_ms |'));
    assert.ok(md.includes('| APP CPU avg |'));
    assert.ok(md.includes('| GC total pause |'));
    assert.match(md, /\| GC total pause \| .* \| ❌ \|/);
    assert.match(md, /\| APP CPU avg \| .* \| ⚠️ \|/);
    assert.match(md, /\| wall_clock_ms \| .* \| ✅ \|/);
  });

  // TODO commit 11/12: empty details should render "no metrics compared" instead of
  // an empty table. Pinning current behavior for now.
  test('empty details renders header + empty table (CURRENT behavior, polished in commit 11/12)', () => {
    const md = toMarkdown({
      summary: { baseline_tag: 'a', target_tag: 'b', scenario: 'empty', passed: true, warnings: 0, failures: 0 },
      details: [],
    });
    assert.match(md, /^## ✅ Benchmark: empty/);
    assert.match(md, /\| Metric \| Baseline \| Target \| Delta \| Status \|/);
    assert.doesNotMatch(md, /regression\(s\) detected/);
  });
});
