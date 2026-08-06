import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { AuditProxy } from './audit-proxy.js';
import { OwnedMeteorCluster } from './owned-meteor-cluster.js';
import { OwnedReplicaSet } from './owned-replica-set.js';

/** Resolves mongod from the exact Meteor tool selected for the audit. */
export function resolveMeteorMongod(source, execute = execFileSync) {
  const args = [
    ...(source.releaseArg ? [source.releaseArg] : []),
    'node',
    '-p',
    'process.execPath',
  ];
  const nodePath = execute(source.meteorCmd, args, { encoding: 'utf8' }).trim();
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
  }

  async start() {
    if (this.replicaSet || this.cluster || this.proxy) throw new Error('Owned audit environment is already started');
    try {
      const mongodPath = this.factories.resolveMongod(this.source);
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
      const cleanupErrors = await this.stop();
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Owned audit environment startup and cleanup failed');
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
      meteorInstances: this.cluster.backends.map(({ id }) => id),
      proxyLedger: this.proxy.snapshotLedger(),
    });
  }

  async stop() {
    const errors = [];
    for (const key of ['proxy', 'cluster', 'replicaSet']) {
      const resource = this[key];
      this[key] = null;
      if (!resource) continue;
      try {
        await resource.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
