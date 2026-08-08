// Shared percentile/aggregate helper. CC-1: every metric that reports a
// distribution (DDP method latency, sub-ready latency, propagation,
// frame-byte size, TTFR, etc.) uses these helpers so rounding +
// interpolation are identical across the dashboard.
//
// Method: nearest-rank. percentile(p) returns
// `samples_sorted[ceil(p/100 * n) - 1]`, clamped to valid indices.
// Simpler than linear interpolation and matches what k6 / artillery
// report — important for comparability with those tools.

export function percentile(samples: readonly number[], p: number): number | null {
  if (!samples || samples.length === 0) return null;
  if (samples.length === 1) return samples[0] ?? null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? null;
}

// Returns the canonical summary shape for a sample array. Callers can
// rename fields (e.g. add `_ms` suffix to avg/max for clarity at the
// metric layer) but the bare names match the percentile-naming
// convention (CC-4) the dashboard consumes for percentiles.
//
// Empty input → `null` (omit at the caller per absence convention CC-5).
export interface DistributionSummary { count: number; avg: number; p50: number; p95: number; p99: number; max: number }

export function summarize(samples: readonly number[]): DistributionSummary | null {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: sum / sorted.length,
    p50: percentile(sorted, 50) ?? first,
    p95: percentile(sorted, 95) ?? first,
    p99: percentile(sorted, 99) ?? first,
    max: last,
  };
}
