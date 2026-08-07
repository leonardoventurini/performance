import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AuditProxy } from './audit-proxy.js';
import { OwnedMeteorCluster } from './owned-meteor-cluster.js';
import { OwnedReplicaSet } from './owned-replica-set.js';

interface MeteorSource {
  readonly meteorCmd: string;
  readonly releaseArg?: string | null;
}

interface StopResult {
  readonly restored?: boolean;
  readonly topologyRestored?: boolean;
  readonly networkRestored?: boolean;
  readonly processGroupsTerminated?: boolean;
  readonly workspaceRemoved?: boolean;
  readonly forcedShutdownCount?: number;
}

/** Replica-set capabilities consumed by the aggregate environment owner. */
export interface ReplicaSetResource {
  readonly uri: string;
  readonly replicaSetName: string;
  readonly forcedShutdowns: number;
  /** Restores mutable database state owned by this exact audit before attestation. */
  restoreAuditState(): Promise<void>;
  /** Reports whether the owned audit state is clean while the topology remains live. */
  attestRecovery(): Promise<Readonly<{ runDocumentsRemoved: boolean; profilerRestored: boolean }>>;
  /** Stops the owned topology after database recovery has been attested. */
  stop(): Promise<StopResult>;
}

/** Meteor cluster capabilities consumed by the aggregate environment owner. */
export interface ClusterResource {
  readonly backends: readonly { readonly id: string; readonly httpUrl: string; readonly webSocketUrl: string }[];
  readonly forcedShutdowns: number;
  stop(): Promise<StopResult>;
}

/** Proxy capabilities consumed by the aggregate environment owner. */
export interface ProxyResource {
  readonly port: number | null;
  readonly forcedShutdowns?: number;
  snapshotLedger(): readonly Readonly<Record<string, unknown>>[];
  stop(): Promise<StopResult>;
}

/** Injectable owned-resource factories used for deterministic lifecycle tests. */
export interface EnvironmentFactories {
  resolveMongod?: (source: MeteorSource, appPath: string) => string;
  createReplicaSet?: (options: Readonly<{ auditId: string; mongodPath: string }>) => Promise<ReplicaSetResource>;
  createCluster?: (options: Readonly<{
    auditId: string; appPath: string; meteorCommand: string; meteorArgsPrefix: readonly string[];
    mongoUrl: string; environment: Readonly<NodeJS.ProcessEnv>;
  }>) => Promise<ClusterResource>;
  createProxy?: (options: Readonly<{
    auditId: string; backends: readonly { readonly id: string; readonly httpUrl: string; readonly webSocketUrl: string }[];
  }>) => Promise<ProxyResource>;
}

interface OwnedAuditEnvironmentOptions {
  readonly auditId: string;
  readonly source: MeteorSource;
  readonly appPath: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly factories?: EnvironmentFactories;
}

interface ResourceRestoration {
  readonly resource: 'proxy' | 'cluster' | 'replicaSet';
  readonly restored: boolean;
  readonly topologyRestored: boolean;
  readonly networkRestored: boolean;
  readonly forcedShutdownCount: number;
}

/** Sealed cleanup evidence produced after every environment lifecycle. */
export interface AuditEnvironmentRestoration {
  readonly schemaVersion: 2;
  readonly restored: boolean;
  readonly failureCount: number;
  readonly forcedShutdownCount: number;
  readonly recovery: Readonly<{
    runDocumentsRemoved: boolean; topologyRestored: boolean; profilerRestored: boolean; networkRestored: boolean;
  }>;
  readonly resources: readonly Readonly<ResourceRestoration>[];
  readonly digest: string;
}

function ownedOplogUrl(mongoUrl: string): string {
  const result = mongoUrl.replace(/\/meteor(?=\?|$)/u, '/local');
  if (result === mongoUrl) throw new Error('Owned audit MongoDB URL does not name the meteor database');
  return result;
}

/** Resolves mongod from the fixture's active Meteor dev bundle. */
export function resolveMeteorMongod(
  source: MeteorSource,
  appPath: string,
  execute: typeof execFileSync = execFileSync,
): string {
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
  readonly auditId: string;
  readonly source: MeteorSource;
  readonly appPath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly factories: Required<EnvironmentFactories>;
  replicaSet: ReplicaSetResource | null;
  cluster: ClusterResource | null;
  proxy: ProxyResource | null;
  lastRestoration: Readonly<AuditEnvironmentRestoration> | null;

  constructor({ auditId, source, appPath, environment = {}, factories = {} }: OwnedAuditEnvironmentOptions) {
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

  async start(): Promise<this> {
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
        environment: {
          ...this.environment,
          MONGO_OPLOG_URL: ownedOplogUrl(this.replicaSet.uri),
        },
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

  get ddpUrl(): string {
    if (!this.proxy?.port) throw new Error('Owned audit proxy is not running');
    return `ws://127.0.0.1:${this.proxy.port}/websocket`;
  }

  evidence(): Readonly<{
    auditId: string; topology: 'replica_set'; replicaSetName: string; forcedMongoShutdowns: number;
    meteorInstances: readonly string[]; proxyLedger: readonly Readonly<Record<string, unknown>>[];
  }> {
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

  async stop(): Promise<Readonly<AuditEnvironmentRestoration>> {
    if (this.lastRestoration) return this.lastRestoration;
    const ownedResources = Object.freeze({
      proxy: this.proxy !== null,
      cluster: this.cluster !== null,
      replicaSet: this.replicaSet !== null,
    });
    const resourceRestorations: ResourceRestoration[] = [];
    let failureCount = 0;
    let databaseAttestation = null;
    if (this.replicaSet) {
      try {
        await this.replicaSet.restoreAuditState();
      } catch {
        failureCount += 1;
      }
      try {
        databaseAttestation = await this.replicaSet.attestRecovery();
      } catch {
        failureCount += 1;
      }
    }
    const resources: readonly ['proxy', 'cluster', 'replicaSet'] = ['proxy', 'cluster', 'replicaSet'];
    for (const key of resources) {
      const resource = key === 'proxy' ? this.proxy : key === 'cluster' ? this.cluster : this.replicaSet;
      if (key === 'proxy') this.proxy = null;
      else if (key === 'cluster') this.cluster = null;
      else this.replicaSet = null;
      if (!resource) continue;
      try {
        const result = await resource.stop();
        resourceRestorations.push({
          resource: key,
          restored: result?.restored !== false,
          topologyRestored: result?.topologyRestored === true
            || (key === 'cluster' && result?.processGroupsTerminated === true && result?.workspaceRemoved === true),
          networkRestored: result?.networkRestored === true,
          forcedShutdownCount: safeInteger(result.forcedShutdownCount)
            ?? safeInteger(resource.forcedShutdowns) ?? 0,
        });
      } catch (error: unknown) {
        failureCount += 1;
        resourceRestorations.push({
          resource: key,
          restored: false,
          topologyRestored: false,
          networkRestored: false,
          forcedShutdownCount: restorationForcedShutdownCount(error)
            ?? safeInteger(resource.forcedShutdowns) ?? 0,
        });
      }
    }
    const topologyResources = resourceRestorations.filter(({ resource }) => resource !== 'proxy');
    const expectedTopologyResources = Number(ownedResources.cluster) + Number(ownedResources.replicaSet);
    const recovery = {
      runDocumentsRemoved: !ownedResources.replicaSet
        || databaseAttestation?.runDocumentsRemoved === true,
      topologyRestored: topologyResources.length === expectedTopologyResources
        && topologyResources.every(({ topologyRestored }) => topologyRestored),
      profilerRestored: !ownedResources.replicaSet
        || databaseAttestation?.profilerRestored === true,
      networkRestored: !ownedResources.proxy || resourceRestorations.some(
        ({ resource, networkRestored }) => resource === 'proxy' && networkRestored,
      ),
    };
    const payload: Omit<AuditEnvironmentRestoration, 'digest'> = {
      schemaVersion: 2,
      restored: failureCount === 0 && Object.values(recovery).every(Boolean),
      failureCount,
      forcedShutdownCount: resourceRestorations.reduce((total, entry) => total + entry.forcedShutdownCount, 0),
      recovery,
      resources: resourceRestorations,
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const restoration: Readonly<AuditEnvironmentRestoration> = Object.freeze({
      ...payload,
      resources: Object.freeze(resourceRestorations.map((entry) => Object.freeze(entry))),
      digest,
    });
    this.lastRestoration = restoration;
    return restoration;
  }
}

function restorationForcedShutdownCount(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const restoration = Reflect.get(error, 'restoration');
  if (typeof restoration !== 'object' || restoration === null) return null;
  const count = Reflect.get(restoration, 'forcedShutdownCount');
  return typeof count === 'number' && Number.isSafeInteger(count) ? count : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
