import assert from 'node:assert/strict';
import test from 'node:test';

import { OwnedAuditEnvironment } from '../../../reliability/environment/owned-audit-environment.js';

function createHarness({ failAt = null } = {}) {
  const events = [];
  const resource = (name, fields = {}) => ({
    ...fields,
    async stop() { events.push(`stop:${name}`); },
  });
  const factories = {
    resolveMongod() { events.push('resolve:mongod'); return '/owned/mongod'; },
    async createReplicaSet() {
      events.push('start:replica');
      if (failAt === 'replica') throw new Error('replica failed');
      return resource('replica', { uri: 'mongodb://127.0.0.1:27017/meteor', replicaSetName: 'audit' });
    },
    async createCluster() {
      events.push('start:cluster');
      if (failAt === 'cluster') throw new Error('cluster failed');
      return resource('cluster', { backends: [{ id: 'a' }, { id: 'b' }] });
    },
    async createProxy() {
      events.push('start:proxy');
      if (failAt === 'proxy') throw new Error('proxy failed');
      return resource('proxy', { port: 1234, snapshotLedger: () => [] });
    },
  };
  return { events, factories };
}

test('environment provisions the topology in dependency order', async () => {
  const { events, factories } = createHarness();
  const environment = await new OwnedAuditEnvironment({
    auditId: 'audit-1', source: { meteorCmd: 'meteor' }, appPath: '/tmp/app', factories,
  }).start();
  assert.equal(environment.ddpUrl, 'ws://127.0.0.1:1234/websocket');
  assert.deepEqual(events, ['resolve:mongod', 'start:replica', 'start:cluster', 'start:proxy']);
  const restoration = await environment.stop();
  assert.equal(restoration.restored, true);
  assert.equal(restoration.failureCount, 0);
  assert.equal(restoration.resources.length, 3);
  assert.match(restoration.digest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(restoration), true);
  assert.equal(JSON.stringify(restoration).includes('/tmp'), false);
  assert.equal(JSON.stringify(restoration).includes('audit-1'), false);
  assert.deepEqual(events.slice(-3), ['stop:proxy', 'stop:cluster', 'stop:replica']);
});

test('partial startup unwinds only owned resources in reverse order', async () => {
  const { events, factories } = createHarness({ failAt: 'proxy' });
  const environment = new OwnedAuditEnvironment({
    auditId: 'audit-1', source: { meteorCmd: 'meteor' }, appPath: '/tmp/app', factories,
  });
  await assert.rejects(() => environment.start(), /proxy failed/);
  assert.deepEqual(events, [
    'resolve:mongod', 'start:replica', 'start:cluster', 'start:proxy',
    'stop:cluster', 'stop:replica',
  ]);
});

test('environment evidence excludes endpoints, tokens, paths, and process ids', async () => {
  const { factories } = createHarness();
  const environment = await new OwnedAuditEnvironment({
    auditId: 'audit-1', source: { meteorCmd: 'meteor' }, appPath: '/tmp/app', factories,
  }).start();
  assert.deepEqual(environment.evidence(), {
    auditId: 'audit-1',
    topology: 'replica_set',
    replicaSetName: 'audit',
    forcedMongoShutdowns: 0,
    meteorInstances: ['a', 'b'],
    proxyLedger: [],
  });
  await environment.stop();
});

test('cleanup artifact seals forced shutdown counts without process identity', async () => {
  const { factories } = createHarness();
  factories.createCluster = async () => ({
    backends: [{ id: 'a' }, { id: 'b' }],
    forcedShutdowns: 2,
    async stop() { return { restored: true, forcedShutdownCount: 2 }; },
  });
  const environment = await new OwnedAuditEnvironment({
    auditId: 'audit-secret', source: { meteorCmd: 'meteor' }, appPath: '/tmp/secret-app', factories,
  }).start();
  const restoration = await environment.stop();
  assert.equal(restoration.forcedShutdownCount, 2);
  assert.equal(await environment.stop(), restoration);
  const serialized = JSON.stringify(restoration);
  assert.doesNotMatch(serialized, /audit-secret|secret-app|pid|token/iu);
});
