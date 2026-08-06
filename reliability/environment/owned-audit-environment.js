import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AuditProxy } from './audit-proxy.js';
import { OwnedMeteorCluster } from './owned-meteor-cluster.js';
import { OwnedReplicaSet } from './owned-replica-set.js';

/** Resolves mongod from the fixture's active Meteor dev bundle. */
export function resolveMeteorMongod(source, appPath, execute = execFileSync) {
  const nodePath = execute(source.meteorCmd, ['node', '-p', 'process.execPath'], {
    cwd: appPath,
    encoding: 'utf8',
  }).trim();
  const mongodPath = path.resolve(path.dirname(nodePath), '..', 'mongodb', 'bin', 'mongod');
  if (!fs.existsSync(mongodPath)) {
    throw new Error('The selected Meteor tool does not provide a bundled mongod');
  }
  return fs.realpathSync(mongodPath);
}

/**
 * Provisions the complete loopback-only audit topology as one cleanup unit.
 * Partial startup always unwinds in reverse ownership order.
 */
export class OwnedAuditEnvironment {
  constructor({ auditId, source, appPath, environment = {}, factories = {} }) {
    if (!auditId) throw new TypeError('auditId is required');
    if (!source?.meteorCmd) throw new TypeError('resolved Meteor source is required');
    if (!path.isAbsolute(appPath)) throw new TypeError('appPath must be absolute');
    this.auditId = auditId;
    this.source = source;
    this.appPath = appPath;
    this.environment = Object.freeze({ ...environment });
    this.factories = {
      resolveMongod: factories.resolveMongod || resolveMeteorMongod,
      createReplicaSet: factories.createReplicaSet || ((options) => OwnedReplicaSet.create(options)),
      createCluster: factories.createCluster || ((options) => OwnedMeteorCluster.create(options)),
      createProxy: factories.createProxy || (async (options) => new AuditProxy(options).start()),
    };
    this.replicaSet = null;
    this.cluster = null;
    this.proxy = null;
    this.lastRestoration = null;
  }

  async start() {
    if (this.replicaSet || this.cluster || this.proxy) throw new Error('Owned audit environment is already started');
    try {
      const mongodPath = this.factories.resolveMongod(this.source, this.appPath);
      this.replicaSet = await this.factories.createReplicaSet({ auditId: this.auditId, mongodPath });
      this.cluster = await this.factories.createCluster({
        auditId: this.auditId,
        appPath: this.appPath,
        meteorCommand: this.source.meteorCmd,
        meteorArgsPrefix: this.source.releaseArg ? [this.source.releaseArg] : [],
        mongoUrl: this.replicaSet.uri,
        environment: this.environment,
      });
      this.proxy = await this.factories.createProxy({
        auditId: this.auditId,
        backends: this.cluster.backends,
      });
      return this;
    } catch (error) {
      const restoration = await this.stop();
      if (!restoration.restored) {
        throw new AggregateError([error, new Error('Owned audit environment cleanup was incomplete')], 'Owned audit environment startup and cleanup failed');
      }
      throw error;
    }
  }

  get ddpUrl() {
    if (!this.proxy?.port) throw new Error('Owned audit proxy is not running');
    return `ws://127.0.0.1:${this.proxy.port}/websocket`;
  }

  evidence() {
    if (!this.replicaSet || !this.cluster || !this.proxy) {
      throw new Error('Owned audit environment is not fully running');
    }
    return Object.freeze({
      auditId: this.auditId,
      topology: 'replica_set',
      replicaSetName: this.replicaSet.replicaSetName,
      forcedMongoShutdowns: this.replicaSet.forcedShutdowns || 0,
      meteorInstances: this.cluster.backends.map(({ id }) => id),
      proxyLedger: this.proxy.snapshotLedger(),
    });
  }

  async stop() {
    if (this.lastRestoration) return this.lastRestoration;
    const resourceRestorations = [];
    let failureCount = 0;
    for (const key of ['proxy', 'cluster', 'replicaSet']) {
      const resource = this[key];
      this[key] = null;
      if (!resource) continue;
      try {
        const result = await resource.stop();
        resourceRestorations.push({
          resource: key,
          restored: result?.restored !== false,
          forcedShutdownCount: Number.isSafeInteger(result?.forcedShutdownCount)
            ? result.forcedShutdownCount
            : Number.isSafeInteger(resource.forcedShutdowns) ? resource.forcedShutdowns : 0,
        });
      } catch (error) {
        failureCount += 1;
        resourceRestorations.push({
          resource: key,
          restored: false,
          forcedShutdownCount: Number.isSafeInteger(error?.restoration?.forcedShutdownCount)
            ? error.restoration.forcedShutdownCount
            : Number.isSafeInteger(resource.forcedShutdowns) ? resource.forcedShutdowns : 0,
        });
      }
    }
    const payload = {
      schemaVersion: 1,
      restored: failureCount === 0 && resourceRestorations.every(({ restored }) => restored),
      failureCount,
      forcedShutdownCount: resourceRestorations.reduce((total, entry) => total + entry.forcedShutdownCount, 0),
      resources: resourceRestorations,
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    this.lastRestoration = Object.freeze({
      ...payload,
      resources: Object.freeze(resourceRestorations.map((entry) => Object.freeze(entry))),
      digest,
    });
    return this.lastRestoration;
  }
}
