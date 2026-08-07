import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createBenchmarkConfig } from '../../bench.config.js';

test('configuration resolves application and result paths from the launcher repository root', () => {
  const repositoryRoot = path.resolve('performance-fixture');
  const config = createBenchmarkConfig(repositoryRoot, {
    BENCH_PORT: '4321',
    BENCH_DASHBOARD_URL: ' ws://dashboard.invalid/websocket ',
  });

  assert.equal(config.appPort, 4321);
  assert.equal(config.apps['tasks-3.x']?.path, path.join(repositoryRoot, 'apps/tasks-3.x'));
  assert.equal(config.results.dir, path.join(repositoryRoot, 'results'));
  assert.equal(config.dashboardUrl, 'ws://dashboard.invalid/websocket');
});
