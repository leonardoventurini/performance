import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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

function createClusterHarness(context) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-cluster-app-'));
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-audit-cluster-test-'));
  context.after(() => {
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.rmSync(rootPath, { recursive: true, force: true });
  });
  let nextPid = 30_000;
  const liveGroups = new Set();
  const processes = new Map();
  const readiness = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    processes.set(child.pid, { pid: child.pid, argv: [command, ...args].join(' ') });
    liveGroups.add(child.pid);
    return child;
  };
  const signalProcess = (target, signal) => {
    const pid = Math.abs(target);
    const instance = [...processes.values()].find((entry) => entry.pid === pid);
    if (!instance) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    const child = [...cluster.instances].map((entry) => entry.child).find((entry) => entry.pid === pid);
    liveGroups.delete(pid);
    child.signalCode = signal;
    child.emit('exit', null, signal);
  };
  const cluster = new OwnedMeteorCluster({
    auditId: 'audit-1', appPath, meteorCommand: '/owned/meteor',
    mongoUrl: 'mongodb://127.0.0.1:27017/meteor', rootPath,
    spawnProcess,
    readinessProbe: async (identity) => { readiness.push(identity); },
    inspectProcess: (pid) => processes.get(pid) || null,
    signalProcess,
    groupExists: (pid) => liveGroups.has(pid),
  });
  return { cluster, readiness, rootPath };
}

test('cluster writes exact process markers, authenticates readiness, and restarts an owned instance', async (context) => {
  const { cluster, readiness } = createClusterHarness(context);
  await cluster.start();
  assert.equal(readiness.length, 2);
  assert.deepEqual(readiness.map(({ instanceId }) => instanceId), ['meteor-0', 'meteor-1']);
  assert.equal(readiness.every(({ auditId, ownershipToken }) => auditId === 'audit-1' && ownershipToken === cluster.token), true);

  const first = cluster.assertOwnedInstance('meteor-0');
  const marker = JSON.parse(fs.readFileSync(first.markerPath, 'utf8'));
  assert.equal(marker.instanceId, first.id);
  assert.equal(marker.pid, first.child.pid);
  assert.equal(marker.workspace, first.workspace);
  assert.equal(marker.argv, `/owned/meteor run --port 127.0.0.1:${first.port}`);
  assert.deepEqual(marker.launchArgv, ['/owned/meteor', 'run', '--port', `127.0.0.1:${first.port}`]);

  const stopped = await cluster.stopInstance('meteor-0');
  assert.deepEqual(stopped, { terminated: true, processGroupTerminated: true, forced: false });
  const restarted = await cluster.restartInstance('meteor-0');
  assert.deepEqual(restarted, { id: 'meteor-0', generation: 2 });
  assert.equal(readiness.length, 3);

  const restoration = await cluster.stop();
  assert.equal(restoration.restored, true);
  assert.equal(restoration.processGroupsTerminated, true);
  assert.equal(restoration.workspaceRemoved, true);
  assert.equal(restoration.instanceCount, 2);
  assert.equal(Object.isFrozen(restoration), true);
  assert.doesNotMatch(JSON.stringify(restoration), /audit-1|owned\/meteor|pid|token/iu);
});

test('stop refuses a live process whose ownership marker was altered', async (context) => {
  const { cluster } = createClusterHarness(context);
  await cluster.start();
  const instance = cluster.instances[0];
  const marker = JSON.parse(fs.readFileSync(instance.markerPath, 'utf8'));
  fs.writeFileSync(instance.markerPath, JSON.stringify({ ...marker, ownershipToken: 'foreign' }));
  await assert.rejects(() => cluster.stopInstance(instance.id), /ownership attestation failed/u);
  fs.writeFileSync(instance.markerPath, JSON.stringify(marker));
  await cluster.stop();
});
