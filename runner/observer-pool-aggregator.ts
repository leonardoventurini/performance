// Pure aggregation for the observer-pool sampler — extracted from the
// in-app collector so it's unit-testable without spinning up Meteor.
//
// Input: the raw dump the in-app sampler writes — { interval_ms, samples }
// where samples is [{ ts, muxCount, handleCount }, ...].
// Output: the `metrics.observer_pool` shape per the task 05 spec —
// min/max/avg/end computed independently for the multiplexer count and the
// handle count.
//
// Returns null when there are no samples (absence convention CC-5: the
// collector ran but captured nothing → caller omits the key entirely).
//
// `end` is the last sample's value (the snapshot at end-of-run, e.g. handle
// count drops back toward 0 after all VUs disconnect). `avg` is rounded to
// one decimal; min/max/end are integers straight from the samples.

interface GaugeStats { min: number; max: number; avg: number; end: number }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null; }
function statsFor(values: readonly number[]): GaugeStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    min,
    max,
    avg: +(sum / values.length).toFixed(1),
    end: values[values.length - 1] ?? 0,
  };
}

/** Aggregates untrusted observer-pool samples. */
export function aggregateObserverPool(dump?: unknown) {
  if (!isRecord(dump)) return null;
  const { interval_ms, samples } = dump;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const normalized = samples.map((sample) => isRecord(sample) ? sample : {});
  return {
    metric: 'observer_pool',
    samples: normalized.length,
    interval_ms: typeof interval_ms === 'number' ? interval_ms : undefined,
    multiplexer_count: statsFor(normalized.map((sample) => Number(sample.muxCount ?? 0))),
    handle_count: statsFor(normalized.map((sample) => Number(sample.handleCount ?? 0))),
  };
}
