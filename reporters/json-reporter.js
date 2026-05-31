// Pure: meteor info is an input, not derived here. The caller (cli/run.js,
// via meteor-source.js) is the sole owner of git introspection — keeps this
// file mockable-free and side-effect-free aside from disk writes.

import fs from 'node:fs';
import path from 'node:path';

function buildResult({ scenario, app, tag, meteor, collectorResults, wallClockMs }) {
  if (!meteor || typeof meteor.version !== 'string' || typeof meteor.sha !== 'string') {
    throw new Error(
      'buildResult requires meteor: { version, sha }. ' +
      'Call resolveMeteorSource from meteor-source.js to obtain it.'
    );
  }
  return {
    timestamp: new Date().toISOString(),
    tag: tag || meteor.version,
    meteor,
    scenario,
    app,
    wall_clock_ms: wallClockMs,
    metrics: Object.fromEntries(
      collectorResults.map((r) => [r.metric, r])
    ),
  };
}

function writeResult(result, outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
}

function appendToHistory(result, historyDir) {
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
  const filename = `${result.scenario}-${result.tag}-${Date.now()}.json`;
  writeResult(result, path.join(historyDir, filename));
}

export { buildResult, writeResult, appendToHistory };
