import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  materializeMeteorApp,
  OwnedMeteorCluster,
} from '../../../reliability/environment/owned-meteor-cluster.js';

test('materialization excludes mutable Meteor state and shares dependencies', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-cluster-materialize-'));
  context.after(() => fs.rmSync(root, { recursive: true }));
  const sourcePath = path.join(root, 'source');
  const destinationPath = path.join(root, 'destination');
  fs.mkdirSync(path.join(sourcePath, '.meteor', 'local'), { recursive: true });
  fs.mkdirSync(path.join(sourcePath, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(sourcePath, 'source.js'), 'export {};');
  fs.writeFileSync(path.join(sourcePath, '.meteor', 'local', 'state'), 'mutable');

  materializeMeteorApp({ sourcePath, destinationPath });

  assert.equal(fs.readFileSync(path.join(destinationPath, 'source.js'), 'utf8'), 'export {};');
  assert.equal(fs.existsSync(path.join(destinationPath, '.meteor', 'local')), false);
  assert.equal(fs.lstatSync(path.join(destinationPath, 'node_modules')).isSymbolicLink(), true);
});

test('cluster rejects non-loopback databases and unsafe roots', () => {
  assert.throws(() => new OwnedMeteorCluster({
    auditId: 'audit-1',
    appPath: '/tmp/app',
    meteorCommand: 'meteor',
    mongoUrl: 'mongodb://database.example/meteor',
    rootPath: '/tmp/meteor-audit-cluster-safe',
  }), /loopback MongoDB URL/);
  assert.throws(() => new OwnedMeteorCluster({
    auditId: 'audit-1',
    appPath: '/tmp/app',
    meteorCommand: 'meteor',
    mongoUrl: 'mongodb://127.0.0.1:27017/meteor',
    rootPath: '/var/tmp/not-owned',
  }), /outside the owned temporary namespace/);
});

test('fault targeting refuses unknown or exited instances', () => {
  const cluster = new OwnedMeteorCluster({
    auditId: 'audit-1',
    appPath: '/tmp/app',
    meteorCommand: 'meteor',
    mongoUrl: 'mongodb://127.0.0.1:27017/meteor',
    rootPath: path.join(os.tmpdir(), 'meteor-audit-cluster-test'),
  });
  assert.throws(() => cluster.assertOwnedInstance('meteor-3'), /not a live owned target/);
  cluster.instances = [{ id: 'meteor-0', child: { exitCode: 1, signalCode: null } }];
  assert.throws(() => cluster.assertOwnedInstance('meteor-0'), /not a live owned target/);
});
