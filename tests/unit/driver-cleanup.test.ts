import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, mock, test } from 'node:test';

import { createBenchmarkConfig } from '../../bench.config.js';
import { runArtilleryDriver } from '../../drivers/artillery.js';
import { runColdStartDriver } from '../../drivers/cold-start.js';
import type { ArtilleryScenario, CliScenario, DriverInputs } from '../../lib/benchmark-types.js';
import { io } from '../../runner/_io.js';

afterEach(() => mock.restoreAll());

const source = {
  mode: 'system' as const,
  meteorCmd: 'meteor',
  releaseArg: null,
  checkoutPath: null,
  version: 'system',
  sha: 'unknown',
};

function processThatExits(signals: NodeJS.Signals[]): ChildProcess {
  const proc = new ChildProcess();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (typeof signal === 'string') signals.push(signal);
    queueMicrotask(() => proc.emit('exit', 0, signal));
    return true;
  };
  return proc;
}

function inputs(scenario: ArtilleryScenario | CliScenario): DriverInputs {
  return {
    scenario,
    scenarioName: 'scenario',
    app: { path: 'apps/tasks-3.x', description: 'fixture' },
    appName: 'tasks-3.x',
    source,
    env: {},
    tag: 'cleanup-test',
    config: createBenchmarkConfig('.', { BENCH_PORT: '3100' }),
    runs: 1,
  };
}

test('cold-start stops Meteor when readiness fails', async () => {
  const signals: NodeJS.Signals[] = [];
  mock.method(io, 'execFileSync', () => '');
  mock.method(io, 'spawn', () => processThatExits(signals));
  mock.method(io, 'fetch', async () => { throw new Error('unreachable'); });
  mock.method(io, 'sleep', async () => undefined);
  let nowCalls = 0;
  mock.method(Date, 'now', () => (nowCalls++ < 2 ? 0 : 300_001));

  await assert.rejects(
    runColdStartDriver(inputs({ driver: 'cli', description: 'cold start' })),
    /did not start/,
  );
  assert.deepEqual(signals, ['SIGTERM']);
});

test('artillery stops Meteor when collector setup fails', async () => {
  const signals: NodeJS.Signals[] = [];
  mock.method(io, 'existsSync', () => true);
  mock.method(io, 'fetch', async () => new Response('', { status: 200 }));
  mock.method(io, 'sleep', async () => undefined);
  mock.method(io, 'execFileSync', (command: string) => command === 'pgrep' ? '' : '');
  let spawnCalls = 0;
  mock.method(io, 'spawn', () => {
    if (spawnCalls++ === 0) return processThatExits(signals);
    throw new Error('collector setup failed');
  });

  await assert.rejects(
    runArtilleryDriver({
      ...inputs({ driver: 'artillery', description: 'load', config: 'load.yml' }),
      scenario: { driver: 'artillery', description: 'load', config: 'load.yml' },
    }),
    /collector setup failed/,
  );
  assert.deepEqual(signals, ['SIGTERM']);
});
