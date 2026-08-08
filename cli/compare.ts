// Reads two result JSON files, runs the regression detector, prints markdown
// or JSON, and exits with the report's pass/fail status.

import { io } from '../runner/_io.js';
import { compare, toMarkdown } from '../reporters/regression-detector.js';
import type { ComparableResult, MetricData } from '../reporters/regression-detector.js';
import type { CliValues } from '../lib/benchmark-types.js';
import { errorMessage } from '../lib/benchmark-types.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function metricData(value: unknown): MetricData {
  if (!isRecord(value)) return {};
  const cpu = isRecord(value.cpu) && typeof value.cpu.avg === 'number'
    ? { avg: value.cpu.avg }
    : undefined;
  const memory = isRecord(value.memory) && typeof value.memory.avg_mb === 'number'
    ? { avg_mb: value.memory.avg_mb }
    : undefined;
  const major = isRecord(value.major) && typeof value.major.total_ms === 'number'
    ? { total_ms: value.major.total_ms }
    : undefined;
  const result: MetricData = {
    ...(typeof value.metric === 'string' ? { metric: value.metric } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
    ...(major === undefined ? {} : { major }),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
  };
  const numericFields = ['p99', 'total_pause_ms', 'max_pause_ms', 'count'] as const;
  for (const field of numericFields) {
    const numericValue = optionalNumber(value[field]);
    if (numericValue !== undefined) result[field] = numericValue;
  }
  return result;
}

function comparableResult(value: unknown, label: string): ComparableResult {
  if (!isRecord(value) || typeof value.tag !== 'string' || typeof value.scenario !== 'string') {
    throw new TypeError(`${label} is not a benchmark result with string tag and scenario fields`);
  }
  const metrics = isRecord(value.metrics)
    ? Object.fromEntries(Object.entries(value.metrics).map(([key, metric]) => [key, metricData(metric)]))
    : undefined;
  const result: ComparableResult = {
    tag: value.tag,
    scenario: value.scenario,
    ...(metrics === undefined ? {} : { metrics }),
  };
  const wallClock = optionalNumber(value.wall_clock_ms);
  if (wallClock !== undefined) result.wall_clock_ms = wallClock;
  return result;
}

function readResultFile(filePath: string, label: string): ComparableResult {
  let raw: string;
  try {
    raw = io.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Could not read ${label} file at ${filePath}: ${errorMessage(err)}. Check the path or run 'bench.js run' first to produce it.`);
    process.exit(1);
  }
  try {
    return comparableResult(JSON.parse(raw), label);
  } catch (err) {
    console.error(`Could not parse ${label} file at ${filePath} as JSON: ${errorMessage(err)}. Is the file a valid bench.js result?`);
    process.exit(1);
  }
}

/** Compares two validated result files and exits with their regression status. */
export function runCompare({ values }: Readonly<{ values: CliValues }>): never {
  const baselinePath = typeof values.baseline === 'string' ? values.baseline : undefined;
  const targetPath = typeof values.target === 'string' ? values.target : undefined;
  const format = typeof values.format === 'string' ? values.format : 'markdown';

  if (!baselinePath || !targetPath) {
    console.error('Usage: node bench.js compare --baseline <file> --target <file>');
    process.exit(1);
  }

  const baseline = readResultFile(baselinePath, 'baseline');
  const target = readResultFile(targetPath, 'target');
  const report = compare(baseline, target);

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(toMarkdown(report));
  }

  process.exit(report.summary.passed ? 0 : 1);
}
