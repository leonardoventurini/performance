import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createBenchmarkConfig } from '../../bench.config.js';
import { directorySizeBytes, runBundleSizeDriver } from '../../drivers/bundle-size.js';
import { io } from '../../runner/_io.js';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-driver-'));
after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

describe('directorySizeBytes', () => {
  test('measures files recursively without following dangling bundle symlinks', () => {
    const nested = path.join(temporaryRoot, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'payload.js'), 'payload');
    const link = path.join(temporaryRoot, 'runtime-helper');
    fs.symlinkSync(path.join(temporaryRoot, 'missing-runtime-helper'), link);

    assert.equal(
      directorySizeBytes(temporaryRoot),
      Buffer.byteLength('payload') + fs.lstatSync(link).size,
    );
  });

  test('removes its owned build directory when Meteor build fails', async (context) => {
    let removedPath: string | undefined;
    context.mock.method(io, 'existsSync', () => true);
    context.mock.method(io, 'execFileSync', () => { throw new Error('build failed'); });
    context.mock.method(io, 'rmSync', (target: Parameters<typeof fs.rmSync>[0]) => { removedPath = String(target); });
    const config = createBenchmarkConfig(path.resolve(import.meta.dirname, '..', '..'), {});
    const app = config.apps['tasks-3.x'];
    assert.ok(app);

    await assert.rejects(runBundleSizeDriver({
      scenario: { driver: 'cli', description: 'bundle size' },
      scenarioName: 'bundle-size',
      app,
      appName: 'tasks-3.x',
      source: {
        mode: 'release', meteorCmd: 'meteor', releaseArg: '--release=test',
        checkoutPath: null, version: 'test', sha: 'release:test',
      },
      env: {},
      tag: 'test',
      config,
    }), /build failed/);
    assert.match(removedPath ?? '', /^\/tmp\/meteor-bundle-\d+$/u);
  });
});
