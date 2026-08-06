import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OwnedReplicaSet,
  buildMongodArgs,
  validateOwnedTopologyMarker,
} from '../../../reliability/environment/owned-replica-set.js';

test('managed mongod arguments bind only loopback and an owned db path', () => {
  const dbPath = path.join(os.tmpdir(), 'meteor-audit-rs-test', 'member-0');
  assert.deepEqual(buildMongodArgs({ dbPath, port: 37_017, replicaSetName: 'audit_123' }), [
    '--dbpath', dbPath,
    '--port', '37017',
    '--bind_ip', '127.0.0.1',
    '--replSet', 'audit_123',
    '--oplogSize', '128',
    '--nounixsocket',
    '--quiet',
  ]);
  assert.throws(() => buildMongodArgs({ dbPath: 'relative', port: 37_017, replicaSetName: 'audit' }), /absolute/u);
  assert.throws(() => buildMongodArgs({ dbPath, port: 80, replicaSetName: 'audit' }), /unprivileged/u);
});

test('ownership marker must match audit, process, token, and exact member set', () => {
  const marker = {
    schemaVersion: 1,
    auditId: 'audit-1',
    ownerPid: 123,
    token: 'secret-token',
    replicaSetName: 'audit_1',
    members: [37_017, 37_018, 37_019].map((port, index) => ({
      index, port, pid: 100 + index, argvDigest: 'a'.repeat(64),
    })),
  };
  assert.deepEqual(validateOwnedTopologyMarker(marker, {
    auditId: 'audit-1',
    ownerPid: 123,
    token: 'secret-token',
  }), marker);
  assert.throws(() => validateOwnedTopologyMarker(marker, {
    auditId: 'audit-2', ownerPid: 123, token: 'secret-token',
  }), /does not match/u);
  assert.throws(() => validateOwnedTopologyMarker({
    ...marker,
    members: marker.members.map((member, index) => (
      index === 1 ? { ...member, port: 37_017 } : member
    )),
  }, {
    auditId: 'audit-1', ownerPid: 123, token: 'secret-token',
  }), /duplicate member identity/u);
  assert.throws(() => validateOwnedTopologyMarker({
    ...marker,
    members: marker.members.map((member, index) => (
      index === 1 ? { ...member, pid: marker.members[0].pid } : member
    )),
  }, {
    auditId: 'audit-1', ownerPid: 123, token: 'secret-token',
  }), /duplicate member identity/u);
});

test('managed replica set refuses roots outside its temporary namespace', () => {
  assert.throws(() => new OwnedReplicaSet({
    auditId: 'audit-1',
    mongodPath: '/bin/false',
    rootPath: path.parse(process.cwd()).root,
  }), /outside the owned temporary namespace/u);
});

test('database interruption targets only live marker-attested members', async () => {
  const signals = [];
  const replicaSet = new OwnedReplicaSet({
    auditId: 'audit-1',
    mongodPath: '/bin/false',
    rootPath: path.join(os.tmpdir(), 'meteor-audit-rs-test-interruption'),
  });
  replicaSet.members = [0, 1, 2].map((index) => ({
    index,
    port: 37_017 + index,
    args: [],
    child: {
      pid: 100 + index,
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push([index, signal]); },
    },
  }));
  replicaSet.assertLiveOwnership = () => ({});
  replicaSet.readAndValidateOwnership = () => ({});
  replicaSet.awaitHealthy = async () => {};

  replicaSet.suspendAll();
  assert.equal(replicaSet.suspended, true);
  await replicaSet.resumeAll();
  assert.equal(replicaSet.suspended, false);
  assert.deepEqual(signals, [
    [0, 'SIGSTOP'], [1, 'SIGSTOP'], [2, 'SIGSTOP'],
    [0, 'SIGCONT'], [1, 'SIGCONT'], [2, 'SIGCONT'],
  ]);
  await assert.rejects(() => replicaSet.resumeAll(), /not suspended/);
});
