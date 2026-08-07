import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

import { MongoClient, type Document } from 'mongodb';

const MEMBER_COUNT = 3;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const TOPOLOGY_PREFIX = 'meteor-audit-rs-';
const OWNERSHIP_FILE = 'ownership.json';
const STDERR_LIMIT = 16_384;

interface MongoCollectionLike {
  countDocuments(filter: Document): Promise<number>;
  deleteMany(filter: Document): Promise<unknown>;
}

interface MongoDatabaseLike {
  command(command: Document): Promise<Document>;
  collection(name: string): MongoCollectionLike;
}

interface MongoClientLike {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  db(name: string): MongoDatabaseLike;
}

/** Minimal MongoDB client constructor used by owned topology orchestration. */
export interface MongoClientConstructor {
  new(uri: string, options: Readonly<{ serverSelectionTimeoutMS: number }>): MongoClientLike;
}

/** Closed process-spawn boundary used for MongoDB member ownership. */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{ stdio: ['ignore', 'ignore', 'pipe'] }>,
) => ManagedMongoProcess;

/** Minimal child-process contract required by replica-set lifecycle controls. */
export interface ManagedMongoProcess {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: (EventEmitter & { setEncoding?(encoding: BufferEncoding): unknown }) | null;
  kill(signal?: NodeJS.Signals | number): boolean | void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

/** Runtime identity and launch evidence for one owned replica-set member. */
export interface ReplicaSetMember {
  readonly index: number;
  readonly port: number;
  readonly dbPath: string;
  readonly child: ManagedMongoProcess;
  readonly pid: number;
  readonly args: readonly string[];
  stderr: string;
}

interface OwnershipMember {
  readonly index: number;
  readonly port: number;
  readonly pid: number;
  readonly argvDigest: string;
}

/** On-disk ownership attestation guarding all destructive topology actions. */
export interface OwnedTopologyMarker {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly ownerPid: number;
  readonly token: string;
  readonly replicaSetName: string;
  readonly members: readonly OwnershipMember[];
}

interface OwnershipExpectation {
  readonly auditId: string;
  readonly ownerPid: number;
  readonly token: string;
}

interface OwnedReplicaSetOptions {
  readonly auditId: string;
  readonly mongodPath: string;
  readonly rootPath: string;
  readonly mongoClient?: MongoClientConstructor;
  readonly spawnProcess?: SpawnProcess;
}

/** Inputs accepted by the safe temporary-root replica-set factory. */
export type OwnedReplicaSetCreateOptions = Omit<OwnedReplicaSetOptions, 'rootPath'>;

const defaultSpawnProcess: SpawnProcess = (command, args, options) => spawn(command, [...args], options);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('Managed MongoDB port reservation did not bind TCP'));
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await wait(100);
  }
  throw new Error(`Managed MongoDB member on port ${port} did not become ready`);
}

async function waitForMember(member: ReplicaSetMember, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  if (member.child.exitCode !== null || member.child.signalCode !== null) {
    throw new Error(
      `Managed MongoDB member ${member.index} exited during startup `
      + `(code=${member.child.exitCode}, signal=${member.child.signalCode}): ${member.stderr}`,
    );
  }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => resolve({ code, signal });
    member.child.once('exit', exited);
  });
  const outcome = await Promise.race([waitForPort(member.port, timeoutMs).then(() => null), exit]);
  if (outcome) throw new Error(
    `Managed MongoDB member ${member.index} exited during startup `
    + `(code=${outcome.code}, signal=${outcome.signal}): ${member.stderr}`,
  );
}

async function waitForExit(child: ManagedMongoProcess, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  await Promise.race([
    exited,
    wait(timeoutMs).then(() => { throw new Error(`Managed process ${child.pid} did not exit`); }),
  ]);
}

function assertSafeTopologyRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(temporaryRoot)
    || !path.basename(resolved).startsWith(TOPOLOGY_PREFIX)) {
    throw new Error('Managed replica-set root is outside the owned temporary namespace');
  }
  return resolved;
}

/** Builds the closed mongod argument contract used by every owned member. */
export function buildMongodArgs({ dbPath, port, replicaSetName }: Readonly<{
  dbPath: string; port: number; replicaSetName: string;
}>): readonly string[] {
  if (!path.isAbsolute(dbPath)) throw new TypeError('Managed MongoDB dbPath must be absolute');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError('Managed MongoDB port must be an unprivileged TCP port');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(replicaSetName)) {
    throw new TypeError('Managed MongoDB replica-set name is invalid');
  }
  return [
    '--dbpath', dbPath,
    '--port', String(port),
    '--bind_ip', '127.0.0.1',
    '--replSet', replicaSetName,
    '--oplogSize', '128',
    '--nounixsocket',
    '--quiet',
  ];
}

/** Verifies that a fault target belongs to the current harness process. */
export function validateOwnedTopologyMarker(
  marker: unknown,
  { auditId, ownerPid, token }: OwnershipExpectation,
): OwnedTopologyMarker {
  if (!isRecord(marker)) {
    throw new TypeError('Managed topology ownership marker must be an object');
  }
  const allowed = ['schemaVersion', 'auditId', 'ownerPid', 'token', 'replicaSetName', 'members'];
  for (const key of Object.keys(marker)) {
    if (!allowed.includes(key)) throw new TypeError(`Managed topology marker.${key} is unknown`);
  }
  if (marker.schemaVersion !== 1
    || marker.auditId !== auditId
    || marker.ownerPid !== ownerPid
    || marker.token !== token) {
    throw new Error('Managed topology ownership attestation does not match this audit');
  }
  if (!Array.isArray(marker.members) || marker.members.length !== MEMBER_COUNT) {
    throw new Error('Managed topology ownership marker has invalid members');
  }
  const ports = new Set();
  const pids = new Set();
  for (const [index, member] of marker.members.entries()) {
    if (!isRecord(member) || member.index !== index
      || typeof member.port !== 'number' || !Number.isSafeInteger(member.port) || member.port < 1024 || member.port > 65535
      || typeof member.pid !== 'number' || !Number.isSafeInteger(member.pid) || member.pid < 1
      || typeof member.argvDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(member.argvDigest)) {
      throw new Error('Managed topology ownership marker has invalid members');
    }
    ports.add(member.port);
    pids.add(member.pid);
  }
  if (ports.size !== MEMBER_COUNT || pids.size !== MEMBER_COUNT) {
    throw new Error('Managed topology ownership marker has duplicate member identity');
  }
  return {
    schemaVersion: 1,
    auditId,
    ownerPid,
    token,
    replicaSetName: typeof marker.replicaSetName === 'string' ? marker.replicaSetName : '',
    members: marker.members.map((member) => ({
      index: member.index,
      port: member.port,
      pid: member.pid,
      argvDigest: member.argvDigest,
    })),
  };
}

/**
 * Owns a disposable three-member local MongoDB replica set.
 *
 * Fault methods re-read the ownership marker before mutation and never accept
 * arbitrary endpoints. Only processes spawned by this instance are targeted.
 */
export class OwnedReplicaSet {
  readonly auditId: string;
  readonly mongodPath: string;
  readonly rootPath: string;
  readonly mongoClient: MongoClientConstructor;
  readonly spawnProcess: SpawnProcess;
  readonly ownerPid: number;
  readonly token: string;
  readonly replicaSetName: string;
  members: ReplicaSetMember[];
  started: boolean;
  markerWritten: boolean;
  forcedShutdowns: number;
  suspended: boolean;

  constructor({ auditId, mongodPath, rootPath, mongoClient = MongoClient, spawnProcess = defaultSpawnProcess }: OwnedReplicaSetOptions) {
    if (typeof auditId !== 'string' || auditId.length === 0) throw new TypeError('auditId is required');
    if (!path.isAbsolute(mongodPath)) throw new TypeError('mongodPath must be absolute');
    this.auditId = auditId;
    this.mongodPath = mongodPath;
    this.rootPath = assertSafeTopologyRoot(rootPath);
    this.mongoClient = mongoClient;
    this.spawnProcess = spawnProcess;
    this.ownerPid = process.pid;
    this.token = crypto.randomBytes(32).toString('hex');
    this.replicaSetName = `audit_${crypto.createHash('sha256').update(auditId).digest('hex').slice(0, 12)}`;
    this.members = [];
    this.started = false;
    this.markerWritten = false;
    this.forcedShutdowns = 0;
    this.suspended = false;
  }

  static async create(options: OwnedReplicaSetCreateOptions): Promise<OwnedReplicaSet> {
    const { auditId, mongodPath, mongoClient, spawnProcess } = options;
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), TOPOLOGY_PREFIX));
    const instance = new OwnedReplicaSet({
      auditId,
      mongodPath,
      rootPath,
      ...(mongoClient ? { mongoClient } : {}),
      ...(spawnProcess ? { spawnProcess } : {}),
    });
    try {
      await instance.start();
      return instance;
    } catch (error) {
      await instance.stop().catch(() => {});
      throw error;
    }
  }

  get ownershipPath(): string {
    return path.join(this.rootPath, OWNERSHIP_FILE);
  }

  get uri(): string {
    const hosts = this.members.map(({ port }) => `127.0.0.1:${port}`).join(',');
    return `mongodb://${hosts}/meteor?replicaSet=${this.replicaSetName}`;
  }

  readAndValidateOwnership(): OwnedTopologyMarker {
    const marker: unknown = JSON.parse(fs.readFileSync(this.ownershipPath, 'utf8'));
    return validateOwnedTopologyMarker(marker, {
      auditId: this.auditId,
      ownerPid: this.ownerPid,
      token: this.token,
    });
  }

  writeOwnershipMarker(): void {
    const marker = {
      schemaVersion: 1,
      auditId: this.auditId,
      ownerPid: this.ownerPid,
      token: this.token,
      replicaSetName: this.replicaSetName,
      members: this.members.map(({ index, port, pid, args }) => ({
        index,
        port,
        pid,
        argvDigest: crypto.createHash('sha256').update(JSON.stringify([
          this.mongodPath,
          ...args,
        ])).digest('hex'),
      })),
    };
    const temporaryPath = `${this.ownershipPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, this.ownershipPath);
    this.markerWritten = true;
  }

  assertLiveOwnership(): OwnedTopologyMarker {
    const marker = this.readAndValidateOwnership();
    for (const [index, member] of this.members.entries()) {
      const attested = marker.members[index];
      const digest = crypto.createHash('sha256').update(JSON.stringify([
        this.mongodPath,
        ...member.args,
      ])).digest('hex');
      if (!attested || member.pid !== attested.pid || member.port !== attested.port
        || digest !== attested.argvDigest || member.child.exitCode !== null
        || member.child.signalCode !== null) {
        throw new Error('Managed topology live process identity does not match ownership marker');
      }
    }
    return marker;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Managed replica set is already started');
    fs.mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    const ports = await Promise.all(Array.from({ length: MEMBER_COUNT }, reservePort));
    this.members = [];
    for (const [index, port] of ports.entries()) {
      const dbPath = path.join(this.rootPath, `member-${index}`);
      fs.mkdirSync(dbPath, { mode: 0o700 });
      const args = buildMongodArgs({ dbPath, port, replicaSetName: this.replicaSetName });
      const child = this.spawnProcess(
        this.mongodPath,
        args,
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      const pid = child.pid;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
        throw new Error(`Managed MongoDB member ${index} did not expose a process id`);
      }
      const member: ReplicaSetMember = { index, port, dbPath, child, pid, args, stderr: '' };
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on?.('data', (chunk) => {
        member.stderr = `${member.stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
      });
      this.members.push(member);
    }
    this.writeOwnershipMarker();
    await Promise.all(this.members.map((member) => waitForMember(member)));
    const bootstrap = this.members[0];
    if (!bootstrap) throw new Error('Managed MongoDB replica set has no bootstrap member');
    const bootstrapUri = `mongodb://127.0.0.1:${bootstrap.port}/admin?directConnection=true`;
    const client = new this.mongoClient(bootstrapUri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    try {
      await client.db('admin').command({
        replSetInitiate: {
          _id: this.replicaSetName,
          members: this.members.map(({ index, port }) => ({
            _id: index,
            host: `127.0.0.1:${port}`,
          })),
        },
      });
    } finally {
      await client.close();
    }
    const replicaClient = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: STARTUP_TIMEOUT_MS });
    await replicaClient.connect();
    await replicaClient.db('admin').command({ ping: 1 });
    await replicaClient.close();
    this.started = true;
    await this.awaitHealthy();
  }

  async awaitHealthy(timeoutMs = STARTUP_TIMEOUT_MS): Promise<Document> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const client = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: 1_000 });
      try {
        await client.connect();
        const status = await client.db('admin').command({ replSetGetStatus: 1 });
        const members = Array.isArray(status.members) ? status.members.filter(isRecord) : [];
        if (members.filter(({ stateStr }) => stateStr === 'PRIMARY').length === 1
          && members.filter(({ stateStr }) => stateStr === 'PRIMARY' || stateStr === 'SECONDARY').length === MEMBER_COUNT) {
          return status;
        }
      } catch {
        // Elections and initial sync make temporary selection failures expected.
      } finally {
        await client.close().catch(() => {});
      }
      await wait(100);
    }
    throw new Error('Managed MongoDB replica set did not become healthy');
  }

  async stepDownPrimary(seconds = 5): Promise<void> {
    this.assertLiveOwnership();
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 30) {
      throw new TypeError('Managed primary step-down must be between 1 and 30 seconds');
    }
    const client = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    try {
      await client.db('admin').command({ replSetStepDown: seconds, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not primary|network|closed|interrupted/u.test(message)) throw error;
    } finally {
      await client.close();
    }
    await this.awaitHealthy();
  }

  /** Suspends every owned member to create a bounded total database interruption. */
  suspendAll(): void {
    if (this.suspended) throw new Error('Managed replica set is already suspended');
    this.assertLiveOwnership();
    for (const { child } of this.members) child.kill('SIGSTOP');
    this.suspended = true;
  }

  /** Restores every member suspended by this exact owner and verifies recovery. */
  async resumeAll(): Promise<void> {
    if (!this.suspended) throw new Error('Managed replica set is not suspended');
    this.readAndValidateOwnership();
    for (const { child } of this.members) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Managed replica-set member exited while suspended');
      }
      child.kill('SIGCONT');
    }
    this.suspended = false;
    await this.awaitHealthy();
  }

  /**
   * Performs the environment owner's last-resort cleanup after case-level cleanup.
   * The exact run filter prevents an aborted primitive from broadening deletion scope.
   */
  async restoreAuditState(): Promise<void> {
    this.assertLiveOwnership();
    if (this.suspended) await this.resumeAll();
    const client = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
      const database = client.db('meteor');
      await Promise.all([
        database.collection('reliabilityDocuments').deleteMany({ runId: this.auditId }),
        database.command({ profile: 0 }),
      ]);
    } finally {
      await client.close();
    }
  }

  /** Attests database cleanup and profiler state while the owned topology is live. */
  async attestRecovery(): Promise<Readonly<{ runDocumentsRemoved: boolean; profilerRestored: boolean }>> {
    this.assertLiveOwnership();
    const client = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
      const database = client.db('meteor');
      const [runDocumentCount, profiler] = await Promise.all([
        database.collection('reliabilityDocuments').countDocuments({ runId: this.auditId }),
        database.command({ profile: -1 }),
      ]);
      return Object.freeze({
        runDocumentsRemoved: runDocumentCount === 0,
        profilerRestored: profiler.was === 0,
      });
    } finally {
      await client.close();
    }
  }

  async stop(): Promise<Readonly<{ topologyRestored: boolean; forcedShutdownCount: number }>> {
    const errors: Error[] = [];
    if (!fs.existsSync(this.rootPath) && this.members.length === 0) {
      this.started = false;
      this.markerWritten = false;
      return Object.freeze({ topologyRestored: true, forcedShutdownCount: this.forcedShutdowns });
    }
    if (this.markerWritten) {
      try {
        this.readAndValidateOwnership();
      } catch (error) {
        throw new AggregateError([error], 'Refusing to stop MongoDB processes without ownership');
      }
    }
    if (this.suspended) {
      for (const { child } of this.members) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGCONT');
      }
      this.suspended = false;
    }
    for (const { child } of this.members) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    for (const { child } of this.members) {
      try {
        await waitForExit(child);
      } catch (error) {
        this.forcedShutdowns += 1;
        child.kill('SIGKILL');
        try {
          await waitForExit(child, 1_000);
        } catch (killError) {
          errors.push(new AggregateError([error, killError], `Managed process ${child.pid} could not be stopped`));
        }
      }
    }
    this.members = [];
    this.started = false;
    if (fs.existsSync(this.rootPath)) {
      assertSafeTopologyRoot(this.rootPath);
      fs.rmSync(this.rootPath, { recursive: true, force: true });
    }
    this.markerWritten = false;
    if (errors.length > 0) throw new AggregateError(errors, 'Managed MongoDB shutdown was incomplete');
    return Object.freeze({
      topologyRestored: !fs.existsSync(this.rootPath) && this.members.length === 0 && !this.suspended,
      forcedShutdownCount: this.forcedShutdowns,
    });
  }
}

/** Resolves the MongoDB server bundled with the active Meteor dev bundle. */
export function resolveBundledMongod(appPath: string): string {
  const candidate = path.resolve(appPath, '.meteor', 'local', 'dev_bundle', 'mongodb', 'bin', 'mongod');
  if (!fs.existsSync(candidate)) {
    throw new Error('Meteor bundled mongod is unavailable; reset or run the fixture once before audit setup');
  }
  return fs.realpathSync(candidate);
}
