import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMethodTiming } from '../../runner/collectors.js';

describe('aggregateMethodTiming', () => {
  test('returns null when input is empty (per absence convention)', () => {
    assert.equal(aggregateMethodTiming({}), null);
    assert.equal(aggregateMethodTiming(null), null);
    assert.equal(aggregateMethodTiming(undefined), null);
  });

  test('returns null when all method arrays are empty', () => {
    // Edge case: methods registered but never called
    assert.equal(aggregateMethodTiming({ insertTask: [], removeTask: [] }), null);
  });

  test('produces canonical shape for { insertTask: [10, 20, 30] }', () => {
    const result = aggregateMethodTiming({ insertTask: [10, 20, 30] });
    assert.ok(result);
    assert.deepEqual(result, {
      metric: 'ddp_methods',
      methods: {
        insertTask: {
          count: 3,
          avg_ms: 20,
          p50: 20,
          p95: 30,
          p99: 30,
          max_ms: 30,
        },
      },
      total_calls: 3,
    });
  });

  test('single sample collapses all stats to that value', () => {
    const result = aggregateMethodTiming({ removeTask: [42] });
    assert.ok(result);
    assert.deepEqual(result.methods.removeTask, {
      count: 1,
      avg_ms: 42,
      p50: 42,
      p95: 42,
      p99: 42,
      max_ms: 42,
    });
  });

  test('multiple methods aggregate independently and sum to total_calls', () => {
    const result = aggregateMethodTiming({
      insertTask: [10, 20, 30, 40, 50],
      removeTask: [5, 15],
      removeAllTasks: [3],
    });
    assert.ok(result);
    const insertTask = result.methods.insertTask;
    const removeTask = result.methods.removeTask;
    const removeAllTasks = result.methods.removeAllTasks;
    assert.ok(insertTask);
    assert.ok(removeTask);
    assert.ok(removeAllTasks);
    assert.equal(result.total_calls, 8);
    assert.equal(insertTask.count, 5);
    assert.equal(removeTask.count, 2);
    assert.equal(removeAllTasks.count, 1);
    assert.equal(insertTask.p50, 30);
    assert.equal(removeTask.avg_ms, 10);
  });

  test('large array (1000 samples) computes percentiles correctly', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i + 1);
    const result = aggregateMethodTiming({ insertTask: samples });
    assert.ok(result);
    const insertTask = result.methods.insertTask;
    assert.ok(insertTask);
    assert.equal(insertTask.count, 1000);
    assert.equal(insertTask.avg_ms, 500.5);
    assert.equal(insertTask.p50, 500);
    assert.equal(insertTask.p95, 950);
    assert.equal(insertTask.p99, 990);
    assert.equal(insertTask.max_ms, 1000);
  });

  test('method names with dots (e.g. accounts.login) survive as object keys', () => {
    const result = aggregateMethodTiming({ 'accounts.login': [100, 200] });
    assert.ok(result);
    assert.ok(result.methods['accounts.login']);
    assert.equal(result.methods['accounts.login'].count, 2);
  });

  test('methods with empty sample arrays are omitted (per absence convention)', () => {
    const result = aggregateMethodTiming({
      insertTask: [10, 20],
      neverCalled: [],
    });
    assert.ok(result);
    assert.equal(result.total_calls, 2);
    assert.ok(result.methods.insertTask);
    assert.equal(result.methods.neverCalled, undefined);
  });

  test('output uses BARE percentile suffix (CC-4: p50, p95, p99 — no _ms)', () => {
    const result = aggregateMethodTiming({ insertTask: [10] });
    assert.ok(result);
    const insertTask = result.methods.insertTask;
    assert.ok(insertTask);
    const fields = Object.keys(insertTask);
    assert.ok(fields.includes('p50'), 'expected bare p50');
    assert.ok(fields.includes('p95'), 'expected bare p95');
    assert.ok(fields.includes('p99'), 'expected bare p99');
    assert.ok(!fields.includes('p50_ms'), 'should NOT have p50_ms (CC-4 violation)');
  });

  test('output uses _ms suffix on non-percentile latency scalars', () => {
    const result = aggregateMethodTiming({ insertTask: [10] });
    assert.ok(result);
    const insertTask = result.methods.insertTask;
    assert.ok(insertTask);
    const fields = Object.keys(insertTask);
    assert.ok(fields.includes('avg_ms'), 'expected avg_ms suffix');
    assert.ok(fields.includes('max_ms'), 'expected max_ms suffix');
  });

  test('top-level metric field is "ddp_methods" (collector self-identifies)', () => {
    const result = aggregateMethodTiming({ insertTask: [10] });
    assert.ok(result);
    assert.equal(result.metric, 'ddp_methods');
  });
});
