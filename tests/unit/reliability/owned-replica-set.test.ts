import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Document } from 'mongodb';

import {
  OwnedReplicaSet,
  type ManagedMongoProcess,
  type OwnedTopologyMarker,
  buildMongodArgs,
  validateOwnedTopologyMarker,
} from '../../../reliability/environment/owned-replica-set.js';

class FakeMongoProcess extends EventEmitter implements ManagedMongoProcess {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  readonly onSignal: ((signal: NodeJS.Signals) => void) | null;
  constructor(pid: number, onSignal: ((signal: NodeJS.Signals) => void) | null = null) {
    super(); this.pid = pid; this.onSignal = onSignal;
  }
  kill(signal?: NodeJS.Signals | number): void {
    if (typeof signal === 'string') {
      this.signals.push(signal);
      this.onSignal?.(signal);
    }
  }
}

function testMarker(): OwnedTopologyMarker {
  return {
    schemaVersion: 1, auditId: 'audit-1', ownerPid: process.pid, token: 'test', replicaSetName: 'audit',
    members: [37_017, 37_018, 37_019].map((port, index) => ({
      index, port, pid: 100 + index, argvDigest: 'a'.repeat(64),
    })),
  };
}

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
      index === 1 ? { ...member, pid: marker.members[0]?.pid } : member
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
  const signals: [number, NodeJS.Signals][] = [];
  const replicaSet = new OwnedReplicaSet({
    auditId: 'audit-1',
    mongodPath: '/bin/false',
    rootPath: path.join(os.tmpdir(), 'meteor-audit-rs-test-interruption'),
  });
  const children = [0, 1, 2].map((index) => new FakeMongoProcess(
    100 + index,
    (signal) => signals.push([index, signal]),
  ));
  replicaSet.members = children.map((child, index) => ({
    index, port: 37_017 + index, dbPath: `/tmp/member-${index}`, args: [], child, pid: child.pid, stderr: '',
  }));
  replicaSet.assertLiveOwnership = testMarker;
  replicaSet.readAndValidateOwnership = testMarker;
  replicaSet.awaitHealthy = async (): Promise<Document> => ({});

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

test('recovery attestation independently checks documents and profiler state', async () => {
  const observations: string[] = [];
  class FakeMongoClient {
    constructor(_uri: string, _options: Readonly<{ serverSelectionTimeoutMS: number }>) {}
    async connect() { observations.push('connect'); }

    db(name: string) {
      assert.equal(name, 'meteor');
      return {
        collection(collectionName: string) {
          assert.equal(collectionName, 'reliabilityDocuments');
          return {
            async countDocuments(filter: Document) {
              assert.deepEqual(filter, {});
              return 0;
            },
          };
        },
        async command(command: Document) {
          assert.deepEqual(command, { profile: -1 });
          return { was: 0 };
        },
      };
    }

    async close() { observations.push('close'); }
  }
  const replicaSet = new OwnedReplicaSet({
    auditId: 'audit-1',
    mongodPath: '/bin/false',
    rootPath: path.join(os.tmpdir(), 'meteor-audit-rs-test-attestation'),
    mongoClient: FakeMongoClient,
  });
  replicaSet.members = [37_017, 37_018, 37_019].map((port, index) => {
    const child = new FakeMongoProcess(100 + index);
    return { index, port, dbPath: `/tmp/member-${index}`, child, pid: child.pid, args: [], stderr: '' };
  });
  replicaSet.assertLiveOwnership = testMarker;

  assert.deepEqual(await replicaSet.attestRecovery(), {
    runDocumentsRemoved: true,
    profilerRestored: true,
  });
  assert.deepEqual(observations, ['connect', 'close']);
});
