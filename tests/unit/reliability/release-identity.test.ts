import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  attestMongoIdentity,
  attestReleaseIdentity,
  readFixtureRelease,
} from '../../../reliability/release-audit/identity.js';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-identity-'));
  temporaryDirectories.push(root);
  const meteorDirectory = path.join(root, 'apps', 'tasks-3.x', '.meteor');
  fs.mkdirSync(meteorDirectory, { recursive: true });
  fs.writeFileSync(path.join(meteorDirectory, 'release'), 'METEOR@3.5.1-beta.0\n');
  fs.writeFileSync(path.join(meteorDirectory, 'versions'), 'mongo@2.5.0-beta351.0\n');
  return root;
}

function git(command, args) {
  assert.equal(command, 'git');
  if (args[0] === 'rev-parse') return 'a'.repeat(40);
  return '';
}

describe('release identity attestation', () => {
  test('binds the fixture, package versions, settings, and clean harness', () => {
    const root = fixture();
    const identity = attestReleaseIdentity({
      repositoryRoot: root,
      requested: '3.5.1-beta.0',
      actual: '3.5.1-beta.0',
      sourceRevision: 'release:3.5.1-beta.0',
      settings: { packages: { mongo: { reactivity: ['changeStreams'] } } },
      git,
    });

    assert.equal(identity.fixtureRelease, 'METEOR@3.5.1-beta.0');
    assert.equal(identity.harnessDirty, false);
    assert.match(identity.packageVersionsDigest, /^[0-9a-f]{64}$/u);
    assert.match(identity.executionEnvironment, /^.+\/.+\/host-[0-9a-f]{12}$/u);
  });

  test('rejects fixture and requested release disagreement', () => {
    const root = fixture();
    assert.throws(() => attestReleaseIdentity({
      repositoryRoot: root,
      requested: '3.5.0',
      actual: '3.5.0',
      sourceRevision: 'release:3.5.0',
      git,
    }), /does not match requested release/u);
  });

  test('rejects missing and unknown identity fields', () => {
    const root = fixture();
    assert.throws(() => attestReleaseIdentity({
      repositoryRoot: root,
      requested: '3.5.1-beta.0',
      actual: 'unknown',
      sourceRevision: 'release:3.5.1-beta.0',
      git,
    }), /actual must be exact/u);
    fs.writeFileSync(path.join(root, 'apps', 'tasks-3.x', '.meteor', 'release'), '');
    assert.throws(() => readFixtureRelease(root), /Identity file is empty/u);
  });
});

describe('MongoDB identity attestation', () => {
  test('records versions and hashes replica-set endpoints', async () => {
    const database = {
      admin: () => ({
        command: async (command) => {
          if (command.buildInfo) return { version: '8.0.1' };
          if (command.getParameter) {
            return { featureCompatibilityVersion: { version: '8.0' } };
          }
          return {
            setName: 'meteor',
            primary: '127.0.0.1:3001',
            hosts: ['127.0.0.1:3001', '127.0.0.1:3002'],
          };
        },
      }),
    };
    const identity = await attestMongoIdentity(database);

    assert.equal(identity.topology, 'replica_set');
    assert.equal(identity.members.length, 2);
    assert.equal(identity.members[0].role, 'primary');
    assert.doesNotMatch(JSON.stringify(identity), /127\.0\.0\.1/u);
  });
});
