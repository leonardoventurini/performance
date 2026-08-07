// `bundle-delta` — OFFLINE trend tool, NOT a metric collector. Reads the
// already-saved result history (config.results.history), keeps the
// `bundle-size` runs, sorts by timestamp, and prints a Δ table (markdown
// default, or JSON via --format json) so an operator can spot bundle bloat
// across runs without grep/jq dances over the history dir.
//
// Forward-compatible by construction: it only reads `metrics.bundle_size`
// and the top-level scenario/tag/timestamp. A history file from an older
// (or newer) harness version is still valid here — every other field is
// ignored, so new metrics or runtime fields never break this command.
//
// Split into pure helpers (computeTrend/formatMarkdown/formatJson) plus a
// thin loader (loadBundleRuns) that takes the io facade as a parameter, so
// the unit tests can mock readdirSync/readFileSync without real disk.

import path from 'node:path';
import { io } from '../runner/_io.js';
import type { BenchmarkConfig, CliValues } from '../lib/benchmark-types.js';

const DEFAULT_LIMIT = 5;
const DEFAULT_WARN_KB = 50;

// Read every *.json in historyDir through the injected reader, parse, and
// keep only well-formed bundle-size runs. A file that fails to parse or
// lacks the bundle_size shape is skipped rather than fatal — one bad file
// in a long history shouldn't sink the whole trend.
interface BundleSizeRun { readonly scenario: 'bundle-size'; readonly timestamp: string; readonly tag: string; readonly metrics: Readonly<{ bundle_size: Readonly<{ client_js_kb: number; server_kb: number; total_kb: number }> }>; }
interface TrendRow { readonly tag: string; readonly client_js_kb: number; readonly server_kb: number; readonly total_kb: number; readonly delta_kb: number | null; }
interface HistoryReader { existsSync(path: string): boolean; readdirSync(path: string): string[]; readFileSync(path: string, encoding: 'utf8'): string; }

/** Loads only structurally valid bundle-size results from history. */
export function loadBundleRuns(historyDir: string, reader: HistoryReader = io): BundleSizeRun[] {
  if (!reader.existsSync(historyDir)) return [];
  const runs: BundleSizeRun[] = [];
  for (const name of reader.readdirSync(historyDir)) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(reader.readFileSync(path.join(historyDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (isBundleSizeRun(parsed)) runs.push(parsed);
  }
  return runs;
}

// A usable row needs scenario === 'bundle-size' AND a numeric total_kb.
// The total_kb guard is the forward-compat hinge: if a future shape change
// renames the field, the run is skipped instead of producing NaN deltas.
function isBundleSizeRun(value: unknown): value is BundleSizeRun {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Record<string, unknown>;
  if (run.scenario !== 'bundle-size' || typeof run.timestamp !== 'string' || typeof run.tag !== 'string') return false;
  const metrics = run.metrics;
  if (typeof metrics !== 'object' || metrics === null) return false;
  const bundle = (metrics as Record<string, unknown>).bundle_size;
  if (typeof bundle !== 'object' || bundle === null) return false;
  const fields = bundle as Record<string, unknown>;
  return typeof fields.client_js_kb === 'number' && typeof fields.server_kb === 'number' && typeof fields.total_kb === 'number';
}

// Pure: array of run objects in, array of trend rows out. Sorts ascending
// by timestamp, slices to the most-recent `limit`, then walks the window
// computing delta_kb vs the previous row (null for the first row). The ⚠️
// marker is a formatting concern, applied in formatMarkdown — these rows
// stay a clean data contract (delta_kb is number|null).
/** Computes chronological deltas over the requested recent window. */
export function computeTrend(runs: readonly BundleSizeRun[], { limit = DEFAULT_LIMIT }: Readonly<{ limit?: number }> = {}): TrendRow[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const windowed = limit > 0 ? sorted.slice(-limit) : sorted;
  return windowed.map((run, i) => {
    const b = run.metrics.bundle_size;
    const previous = i > 0 ? windowed[i - 1] : undefined;
    return {
      tag: run.tag,
      client_js_kb: b.client_js_kb,
      server_kb: b.server_kb,
      total_kb: b.total_kb,
      delta_kb: previous ? b.total_kb - previous.metrics.bundle_size.total_kb : null,
    };
  });
}

function fmtDelta(deltaKb: number | null | undefined, warnKb: number): string {
  if (deltaKb === null || deltaKb === undefined) return '-';
  const sign = deltaKb >= 0 ? '+' : '';
  const marker = deltaKb >= warnKb ? ' ⚠️' : '';
  return `${sign}${deltaKb} KB${marker}`;
}

// Renders the trend as a GitHub-flavored markdown table. The ⚠️ marker is
// derived here (delta_kb >= warnKb) so it never leaks into the JSON shape.
/** Formats bundle deltas as operator-readable Markdown. */
export function formatMarkdown(trend: readonly TrendRow[], { limit = DEFAULT_LIMIT, warnKb = DEFAULT_WARN_KB }: Readonly<{ limit?: number; warnKb?: number }> = {}): string {
  const lines: string[] = [];
  lines.push(`## Bundle size trend (last ${limit} runs of "bundle-size")`);
  lines.push('');
  lines.push('| Run | Tag | Client JS | Server | Total | Δ vs prev |');
  lines.push('|-----|-----|-----------|--------|-------|-----------|');
  trend.forEach((row, i) => {
    lines.push(
      `| ${i + 1} | ${row.tag} | ${row.client_js_kb} KB | ${row.server_kb} KB | ${row.total_kb} KB | ${fmtDelta(row.delta_kb, warnKb)} |`
    );
  });
  return lines.join('\n');
}

/** Formats bundle deltas as stable JSON. */
export function formatJson(trend: readonly TrendRow[]): string {
  return JSON.stringify({ trend }, null, 2);
}

// CLI entry. Coerces the string flags from parseArgs to numbers, loads the
// runs, and prints either the friendly empty-state line or the chosen format.
// Always exits 0 — an empty history is a normal state, not an error.
/** Prints the configured bundle-size history trend. */
export function runBundleDelta({ values, config }: Readonly<{ values: CliValues; config: BenchmarkConfig }>): void {
  const limit = Number(values.limit ?? DEFAULT_LIMIT);
  const warnKb = Number(values['warn-kb'] ?? DEFAULT_WARN_KB);
  const format = values.format || 'markdown';
  const historyDir = config.results.history;

  const runs = loadBundleRuns(historyDir, io);
  if (runs.length === 0) {
    console.log(`No bundle-size runs found in ${historyDir}`);
    return;
  }

  const trend = computeTrend(runs, { limit });
  console.log(format === 'json' ? formatJson(trend) : formatMarkdown(trend, { limit, warnKb }));
}
