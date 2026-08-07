import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSlowQueries } from '../../runner/slow-query-aggregator.js';

// Minimal system.profile-shaped entry factory.
interface EntryOptions {
  readonly op?: string;
  readonly ns?: string;
  readonly millis?: number | string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly planSummary?: string;
}

interface ProfileEntry {
  readonly op: string;
  readonly ns: string;
  readonly millis: number | string;
  command?: { readonly filter: Readonly<Record<string, unknown>> };
  planSummary?: string;
}

function entry({ op = 'query', ns = 'meteor.tasks', millis = 100, filter, planSummary }: EntryOptions = {}): ProfileEntry {
  const e: ProfileEntry = { op, ns, millis };
  if (filter !== undefined) e.command = { filter };
  if (planSummary !== undefined) e.planSummary = planSummary;
  return e;
}

describe('aggregateSlowQueries', () => {
  test('empty array → null (absence convention CC-5)', () => {
    assert.equal(aggregateSlowQueries([]), null);
    assert.equal(aggregateSlowQueries([], { thresholdMs: 100, durationMs: 1000 }), null);
  });

  test('null / non-array input → null (defensive)', () => {
    assert.equal(aggregateSlowQueries(null), null);
    assert.equal(aggregateSlowQueries(undefined), null);
    assert.equal(aggregateSlowQueries('nope'), null);
  });

  test('mixed op types → correct by_op breakdown + total_slow', () => {
    const entries = [
      entry({ op: 'query', millis: 150 }),
      entry({ op: 'query', millis: 200 }),
      entry({ op: 'update', millis: 110 }),
      entry({ op: 'getmore', millis: 130 }),
      entry({ op: 'getmore', millis: 120 }),
    ];
    const r = aggregateSlowQueries(entries);
    assert.ok(r);
    assert.equal(r.total_slow, 5);
    assert.deepEqual(r.by_op, { query: 2, update: 1, getmore: 2 });
  });

  test('by_op only contains op types actually present (no fixed key set)', () => {
    const r = aggregateSlowQueries([entry({ op: 'insert', millis: 105 })]);
    assert.ok(r);
    assert.deepEqual(r.by_op, { insert: 1 });
    assert.equal(Reflect.get(r.by_op, 'query'), undefined);
  });

  test('slowest identified by millis; slowest_ms + slowest_sample match', () => {
    const entries = [
      entry({ op: 'query', ns: 'meteor.a', millis: 150 }),
      entry({ op: 'update', ns: 'meteor.b', millis: 1820, planSummary: 'COLLSCAN' }),
      entry({ op: 'getmore', ns: 'meteor.c', millis: 130 }),
    ];
    const r = aggregateSlowQueries(entries);
    assert.ok(r);
    assert.ok(r.slowest_sample);
    assert.equal(r.slowest_ms, 1820);
    assert.equal(r.slowest_sample.ns, 'meteor.b');
    assert.equal(r.slowest_sample.op, 'update');
    assert.equal(r.slowest_sample.millis, 1820);
    assert.equal(r.slowest_sample.planSummary, 'COLLSCAN');
  });

  test('filter_keys extraction sanitizes — KEY NAMES only, never values', () => {
    const entries = [
      entry({
        op: 'query',
        millis: 900,
        filter: { sessionId: 'secret-token-abc', userEmail: 'a@b.com', age: 42 },
      }),
    ];
    const r = aggregateSlowQueries(entries);
    assert.ok(r);
    assert.ok(r.slowest_sample);
    assert.deepEqual(r.slowest_sample.filter_keys.sort(), ['age', 'sessionId', 'userEmail']);
    // Ensure no values leaked anywhere in the serialized sample.
    const serialized = JSON.stringify(r.slowest_sample);
    assert.ok(!serialized.includes('secret-token-abc'));
    assert.ok(!serialized.includes('a@b.com'));
  });

  test('missing command / command.filter → filter_keys is empty array', () => {
    const noCmd = aggregateSlowQueries([entry({ op: 'query', millis: 200 })]);
    assert.ok(noCmd);
    assert.ok(noCmd.slowest_sample);
    assert.deepEqual(noCmd.slowest_sample.filter_keys, []);
    const emptyFilter = aggregateSlowQueries([entry({ op: 'query', millis: 200, filter: {} })]);
    assert.ok(emptyFilter);
    assert.ok(emptyFilter.slowest_sample);
    assert.deepEqual(emptyFilter.slowest_sample.filter_keys, []);
  });

  test('tie on slowest millis → first entry wins (deterministic)', () => {
    const entries = [
      entry({ op: 'query', ns: 'meteor.first', millis: 500 }),
      entry({ op: 'update', ns: 'meteor.second', millis: 500 }),
    ];
    const r = aggregateSlowQueries(entries);
    assert.ok(r);
    assert.ok(r.slowest_sample);
    assert.equal(r.slowest_sample.ns, 'meteor.first');
    assert.equal(r.slowest_sample.op, 'query');
  });

  test('threshold_ms and duration_s pass through from opts', () => {
    const r = aggregateSlowQueries([entry({ millis: 120 })], { thresholdMs: 250, durationMs: 30200 });
    assert.ok(r);
    assert.equal(r.threshold_ms, 250);
    assert.equal(r.duration_s, 30.2);
  });

  test('opts default: threshold_ms=100, duration_s=0 when omitted', () => {
    const r = aggregateSlowQueries([entry({ millis: 120 })]);
    assert.ok(r);
    assert.equal(r.threshold_ms, 100);
    assert.equal(r.duration_s, 0);
  });

  test('negative durationMs coerced to 0 (defensive)', () => {
    const r = aggregateSlowQueries([entry({ millis: 120 })], { durationMs: -5000 });
    assert.ok(r);
    assert.equal(r.duration_s, 0);
  });

  test('entry missing op → counted under "unknown"', () => {
    const e = { ns: 'meteor.x', millis: 300 }; // no op field
    const r = aggregateSlowQueries([e]);
    assert.ok(r);
    assert.ok(r.slowest_sample);
    assert.equal(r.by_op.unknown, 1);
    assert.equal(r.slowest_sample.op, null);
  });

  test('non-numeric millis coerced via Number (defensive)', () => {
    const entries = [entry({ op: 'query', millis: '900' }), entry({ op: 'query', millis: '150' })];
    const r = aggregateSlowQueries(entries);
    assert.ok(r);
    assert.equal(r.slowest_ms, 900);
  });

  test('shape contract: exact top-level key set + metric name', () => {
    const r = aggregateSlowQueries([entry({ millis: 120, filter: { a: 1 }, planSummary: 'IXSCAN' })], {
      thresholdMs: 100,
      durationMs: 5000,
    });
    assert.ok(r);
    assert.ok(r.slowest_sample);
    assert.equal(r.metric, 'mongo_slow_queries');
    assert.deepEqual(
      Object.keys(r).sort(),
      ['by_op', 'duration_s', 'metric', 'slowest_ms', 'slowest_sample', 'threshold_ms', 'total_slow'],
    );
    assert.deepEqual(
      Object.keys(r.slowest_sample).sort(),
      ['filter_keys', 'millis', 'ns', 'op', 'planSummary'],
    );
  });

  test('large array (1000 entries) aggregates correctly', () => {
    const entries: ProfileEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      entries.push(entry({ op: i % 2 === 0 ? 'query' : 'update', millis: i + 100 }));
    }
    const r = aggregateSlowQueries(entries, { durationMs: 60000 });
    assert.ok(r);
    assert.equal(r.total_slow, 1000);
    assert.equal(r.by_op.query, 500);
    assert.equal(r.by_op.update, 500);
    assert.equal(r.slowest_ms, 1099); // last entry i=999 → 999+100
  });
});
