// Pure pass-through aggregator for the driver-fallback tracker — the
// in-app monitor already computed total / no_fallback / fallbacks (it's
// just counters, no percentile math), so this aggregator's job is mostly
// shape validation + the absence convention.
//
// Returns null when no observes were recorded (CC-5: collector ran but
// nothing happened → caller omits the key entirely).

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null; }
function fallbackCounts(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([transition, count]) => [transition, Number(count) || 0]));
}
/** Aggregates an untrusted driver-fallback counter payload. */
export function aggregateDriverFallback(dump?: unknown) {
  if (!isRecord(dump)) return null;
  const total = Number(dump.total_cursors) || 0;
  if (total === 0) return null;
  const noFallback = Number(dump.no_fallback) || 0;
  return {
    metric: 'driver_fallbacks' as const,
    total_cursors: total,
    no_fallback: noFallback,
    configured_first: typeof dump.configured_first === 'string' ? dump.configured_first : null,
    fallbacks: fallbackCounts(dump.fallbacks),
  };
}
