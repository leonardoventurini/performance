import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OwnedAuditEnvironment,
  type EnvironmentFactories,
} from '../../../reliability/environment/owned-audit-environment.js';

type FailurePoint = 'replica' | 'cluster' | 'proxy' | null;
interface Harness { readonly events: string[]; readonly factories: EnvironmentFactories }

function testBackends() {
  return ['a', 'b'].map((id) => ({
    id,
    httpUrl: `http://127.0.0.1:300${id === 'a' ? '1' : '2'}`,
    webSocketUrl: `ws://127.0.0.1:300${id === 'a' ? '1' : '2'}`,
  }));
}

function createHarness({ failAt = null }: Readonly<{ failAt?: FailurePoint }> = {}): Harness {
  const events: string[] = [];
  const factories: EnvironmentFactories = {
    resolveMongod() { events.push('resolve:mongod'); return '/owned/mongod'; },
    async createReplicaSet() {
      events.push('start:replica');
      if (failAt === 'replica') throw new Error('replica failed');
      return {
        uri: 'mongodb://127.0.0.1:27017/meteor',
        replicaSetName: 'audit',
        forcedShutdowns: 0,
        async restoreAuditState() { events.push('restore:replica'); },
        async attestRecovery() { return { runDocumentsRemoved: true, profilerRestored: true }; },
        async stop() { events.push('stop:replica'); return { topologyRestored: true }; },
      };
    },
    async createCluster() {
      events.push('start:cluster');
      if (failAt === 'cluster') throw new Error('cluster failed');
      return {
        backends: testBackends(), forcedShutdowns: 0,
        async stop() { events.push('stop:cluster'); return { restored: true, processGroupsTerminated: true, workspaceRemoved: true }; },
      };
    },
    async createProxy() {
      events.push('start:proxy');
      if (failAt === 'proxy') throw new Error('proxy failed');
      return {
        port: 1234, snapshotLedger: () => [],
        async stop() { events.push('stop:proxy'); return { networkRestored: true }; },
      };
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
  assert.deepEqual(restoration.recovery, {
    runDocumentsRemoved: true,
    topologyRestored: true,
    profilerRestored: true,
    networkRestored: true,
  });
  assert.equal(restoration.resources.length, 3);
  assert.match(restoration.digest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(restoration), true);
  assert.equal(JSON.stringify(restoration).includes('/tmp'), false);
  assert.equal(JSON.stringify(restoration).includes('audit-1'), false);
  assert.deepEqual(events.slice(-4), ['restore:replica', 'stop:proxy', 'stop:cluster', 'stop:replica']);
});

test('partial startup unwinds only owned resources in reverse order', async () => {
  const { events, factories } = createHarness({ failAt: 'proxy' });
  const environment = new OwnedAuditEnvironment({
    auditId: 'audit-1', source: { meteorCmd: 'meteor' }, appPath: '/tmp/app', factories,
  });
  await assert.rejects(() => environment.start(), /proxy failed/);
  assert.deepEqual(events, [
    'resolve:mongod', 'start:replica', 'start:cluster', 'start:proxy',
    'restore:replica', 'stop:cluster', 'stop:replica',
  ]);
});

test('environment restores database state before attestation and fails closed when restoration rejects', async () => {
  const { events, factories } = createHarness();
  const createReplicaSet = factories.createReplicaSet;
  if (!createReplicaSet) throw new Error('test replica factory is missing');
  factories.createReplicaSet = async (options) => {
    const replicaSet = await createReplicaSet(options);
    replicaSet.restoreAuditState = async () => {
      events.push('restore:failed');
      throw new Error('database restoration failed');
    };
    replicaSet.attestRecovery = async () => {
      events.push('attest:replica');
      return { runDocumentsRemoved: false, profilerRestored: false };
    };
    return replicaSet;
  };
  const environment = await new OwnedAuditEnvironment({
    auditId: 'audit-1', source: { meteorCmd: 'meteor' }, appPath: '/tmp/app', factories,
  }).start();

  const restoration = await environment.stop();

  assert.deepEqual(events.slice(4, 6), ['restore:failed', 'attest:replica']);
  assert.equal(restoration.failureCount, 1);
  assert.equal(restoration.restored, false);
  assert.equal(restoration.recovery.runDocumentsRemoved, false);
  assert.equal(restoration.recovery.profilerRestored, false);
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
    backends: testBackends(),
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

test('cleanup fails closed for each missing recovery attestation', async () => {
  for (const missingDimension of [
    'runDocumentsRemoved', 'topologyRestored', 'profilerRestored', 'networkRestored',
  ]) {
    const { factories } = createHarness();
    if (missingDimension === 'runDocumentsRemoved' || missingDimension === 'profilerRestored') {
      const createReplicaSet = factories.createReplicaSet;
      if (!createReplicaSet) throw new Error('test replica factory is missing');
      factories.createReplicaSet = async () => {
        const replicaSet = await createReplicaSet({ auditId: 'test', mongodPath: '/owned/mongod' });
        replicaSet.attestRecovery = async () => ({
          runDocumentsRemoved: missingDimension !== 'runDocumentsRemoved',
          profilerRestored: missingDimension !== 'profilerRestored',
        });
        return replicaSet;
      };
    } else if (missingDimension === 'topologyRestored') {
      factories.createCluster = async () => ({
        backends: testBackends(),
        forcedShutdowns: 0,
        async stop() { return {}; },
      });
    } else {
      factories.createProxy = async () => ({
        port: 1234,
        snapshotLedger: () => [],
        async stop() { return {}; },
      });
    }
    const environment = await new OwnedAuditEnvironment({
      auditId: `audit-${missingDimension}`,
      source: { meteorCmd: 'meteor' },
      appPath: '/tmp/app',
      factories,
    }).start();
    const restoration = await environment.stop();
    const recoveryValue = missingDimension === 'runDocumentsRemoved'
      ? restoration.recovery.runDocumentsRemoved
      : missingDimension === 'topologyRestored'
        ? restoration.recovery.topologyRestored
        : missingDimension === 'profilerRestored'
          ? restoration.recovery.profilerRestored
          : restoration.recovery.networkRestored;
    assert.equal(recoveryValue, false, missingDimension);
    assert.equal(restoration.restored, false, missingDimension);
  }
});
