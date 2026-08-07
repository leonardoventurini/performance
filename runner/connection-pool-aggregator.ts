// Pure aggregation for the mongo connection-pool sampler — extracted
// from the standalone collector so it's unit-testable without spinning
// up MongoClient or a child process.
//
// Input: the raw shape the collector accumulates —
//   { interval_ms,
//     samples: [{ ts, current, active }, ...],
//     total_created_start, total_created_end }
// Output: the `metrics.mongo_pool` shape per the task 14 spec
// (REVISIONS-corrected): current + active as time-series with
// min/max/avg/end, total_created as start/end/delta.
//
// Returns null when there are no samples (absence convention CC-5: the
// collector ran but captured nothing → caller omits the key entirely).
//
// `current` and `active` are point-in-time gauges, so min/max/avg/end
// over the run is the informative reduction. `total_created` is a
// monotonic counter — only the delta over the window matters, computed
// from the start baseline and the last-seen value regardless of any
// intermediate fluctuation. `avg` is rounded to one decimal; min/max/end
// are integers straight from the samples.

interface GaugeStats { min: number; max: number; avg: number; end: number }
interface PoolSample { readonly current?: unknown; readonly active?: unknown }
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

/** Normalizes untrusted pool samples into the public metric contract. */
export function aggregateConnectionPool(dump?: unknown) {
  if (!isRecord(dump)) return null;
  const { interval_ms, samples, total_created_start, total_created_end } = dump;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const normalizedSamples: PoolSample[] = samples.map((sample) => isRecord(sample)
    ? { current: sample.current, active: sample.active }
    : {});

  const start = Number(total_created_start ?? 0);
  const end = Number(total_created_end ?? start);

  return {
    metric: 'mongo_pool',
    samples: normalizedSamples.length,
    interval_ms: typeof interval_ms === 'number' ? interval_ms : undefined,
    current: statsFor(normalizedSamples.map((sample) => Number(sample.current ?? 0))),
    active: statsFor(normalizedSamples.map((sample) => Number(sample.active ?? 0))),
    total_created: { start, end, delta: end - start },
  };
}
