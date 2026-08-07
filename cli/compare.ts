// Reads two result JSON files, runs the regression detector, prints markdown
// or JSON, and exits with the report's pass/fail status.

import { io } from '../runner/_io.js';
import { compare, toMarkdown } from '../reporters/regression-detector.js';
import type { CliValues } from '../lib/benchmark-types.js';
import { errorMessage } from '../lib/benchmark-types.js';

function readResultFile(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = io.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Could not read ${label} file at ${filePath}: ${errorMessage(err)}. Check the path or run 'bench.js run' first to produce it.`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
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
