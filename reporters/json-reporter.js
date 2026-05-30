/**
 * JSON Reporter
 *
 * Collects results from all collectors and produces a single JSON file
 * with metadata (date, Meteor version, git SHA, scenario, app).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Build a result object from collector outputs.
 * @param {Object} options
 * @param {string} options.scenario - Scenario name
 * @param {string} options.app - App name
 * @param {string} options.tag - Version tag (e.g., "v3.5", "devel")
 * @param {Object} options.meteorCheckoutPath - Path to Meteor checkout
 * @param {Object[]} options.collectorResults - Array of parsed JSON from collectors
 * @param {number} options.wallClockMs - Total wall-clock time
 * @returns {Object} Complete result object
 */
function buildResult({ scenario, app, tag, meteorCheckoutPath, collectorResults, wallClockMs }) {
  let meteorVersion = 'unknown';
  let meteorSha = 'unknown';

  if (meteorCheckoutPath) {
    try {
      meteorSha = execSync('git rev-parse --short HEAD', { cwd: meteorCheckoutPath, encoding: 'utf8' }).trim();
      meteorVersion = execSync('git describe --tags --always', { cwd: meteorCheckoutPath, encoding: 'utf8' }).trim();
    } catch {
      // Not a git repo or git not available
    }
  }

  return {
    timestamp: new Date().toISOString(),
    tag: tag || meteorVersion,
    meteor: {
      version: meteorVersion,
      sha: meteorSha,
    },
    scenario,
    app,
    wall_clock_ms: wallClockMs,
    metrics: Object.fromEntries(
      collectorResults.map((r) => [r.metric, r])
    ),
  };
}

/**
 * Write result to a JSON file.
 * @param {Object} result - Result from buildResult
 * @param {string} outputPath - Path to write
 */
function writeResult(result, outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
}

/**
 * Append result to history file.
 * @param {Object} result - Result from buildResult
 * @param {string} historyDir - History directory
 */
function appendToHistory(result, historyDir) {
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
  const filename = `${result.scenario}-${result.tag}-${Date.now()}.json`;
  writeResult(result, path.join(historyDir, filename));
}

export { buildResult, writeResult, appendToHistory };
