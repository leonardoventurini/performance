import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { coordinateReleaseAudit } from '../../../reliability/release-audit/coordinator.js';

const directories = [];
const DIGEST = 'a'.repeat(64);
const RELEASE = {
  requested: '3.5.1-beta.0',
  actual: '3.5.1-beta.0',
  sourceRevision: 'release:3.5.1-beta.0',
  fixtureRelease: 'METEOR@3.5.1-beta.0',
  packageVersionsDigest: DIGEST,
  settingsDigest: DIGEST,
  harnessRevision: 'b'.repeat(40),
  harnessDirty: false,
  executionEnvironment: 'test',
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('release audit coordinator', () => {
  test('persists an incomplete manifest when required adapters are absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-coordinator-'));
    directories.push(root);
    const executeCase = async () => null;
    executeCase.supports = () => false;
    const result = await coordinateReleaseAudit({
      repositoryRoot: process.cwd(),
      resultsRoot: root,
      release: '3.5.1-beta.0',
      releaseIdentity: RELEASE,
      topologyScope: ['replica_set'],
      transportScope: ['sockjs'],
      seed: 1,
      executeCase,
      now: (() => {
        let value = 1_000;
        return () => value += 1;
      })(),
    });

    assert.equal(result.manifest.status, 'incomplete');
    assert.equal(result.releaseExecution.state, 'incomplete');
    assert.equal(fs.existsSync(path.join(result.artifactRoot, 'manifest.json')), true);
    const events = fs.readFileSync(
      path.join(result.artifactRoot, 'progress.ndjson'),
      'utf8',
    ).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).kind, 'audit_completed');
    assert.deepEqual(
      events.map(({ sequence }) => sequence),
      [1, 2, 3, 4],
    );
  });
});
