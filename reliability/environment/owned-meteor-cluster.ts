import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { RawDdpClient } from '../runtime/ddp/raw-client.js';

const INSTANCE_COUNT = 2;
const CLUSTER_PREFIX = 'meteor-audit-cluster-';
const MARKER_NAME = '.audit-process-owner.json';
const STARTUP_TIMEOUT_MS = 180_000;
const READINESS_ATTEMPT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const STDERR_LIMIT = 32_768;
const MAXIMUM_PROBE_LEDGER_ENTRIES = 32;

/** Attested operating-system identity for one owned Meteor process. */
export interface ProcessIdentity { readonly pid: number; readonly argv: string }
/** Authenticated inputs used to prove a Meteor instance is application-ready. */
export interface ReadinessContext {
  readonly auditId: string; readonly instanceId: string; readonly port: number; readonly ownershipToken: string;
  readonly signal?: AbortSignal;
}
/** Loopback endpoint pair exposed to the owned audit proxy. */
export interface MeteorBackend {
  readonly id: string; readonly httpUrl: string; readonly webSocketUrl: string;
}
/** Minimal child-process contract required by the cluster lifecycle. */
export interface ManagedMeteorProcess {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  emit(event: 'exit', code: number | null, signal: NodeJS.Signals | null): boolean;
}
/** Mutable lifecycle record for one cluster-owned Meteor instance. */
export interface MeteorInstance {
  readonly id: string;
  readonly port: number;
  readonly workspace: string;
  generation: number;
  child: ManagedMeteorProcess | null;
  pid: number | null;
  readonly markerPath: string;
  stdout: string;
  stderr: string;
}
interface OwnershipMarker {
  readonly auditId: string; readonly ownerId: string; readonly ownershipToken: string;
  readonly instanceId: string; readonly generation: number; readonly pid: number;
  readonly argv: string; readonly launchArgv: readonly string[]; readonly workspace: string;
}
type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string; detached: true; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'];
  }>,
) => ManagedMeteorProcess;
type InspectProcess = (pid: number) => ProcessIdentity | null;
type SignalProcess = (pid: number, signal: NodeJS.Signals) => boolean | void;
type GroupExists = (pid: number) => boolean;
type ReadinessProbe = (context: ReadinessContext) => Promise<void>;

interface OwnedMeteorClusterOptions {
  readonly auditId: string;
  readonly appPath: string;
  readonly meteorCommand: string;
  readonly meteorArgsPrefix?: readonly string[];
  readonly mongoUrl: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly rootPath: string;
  readonly spawnProcess?: SpawnProcess;
  readonly readinessProbe?: ReadinessProbe;
  readonly inspectProcess?: InspectProcess;
  readonly signalProcess?: SignalProcess;
  readonly groupExists?: GroupExists;
  readonly startupTimeoutMs?: number;
  readonly readinessAttemptTimeoutMs?: number;
}
/** Inputs accepted by the safe temporary-root cluster factory. */
export type OwnedMeteorClusterCreateOptions = Omit<OwnedMeteorClusterOptions, 'rootPath'>;

interface ClusterRestoration {
  readonly resource: 'meteor_cluster';
  readonly restored: boolean;
  readonly instanceCount: number;
  readonly terminatedInstanceCount: number;
  readonly forcedShutdownCount: number;
  readonly processGroupsTerminated: boolean;
  readonly workspaceRemoved: boolean;
}

class RestorationAggregateError extends AggregateError {
  readonly restoration: Readonly<ClusterRestoration>;
  constructor(errors: readonly unknown[], message: string, restoration: Readonly<ClusterRestoration>) {
    super(errors, message);
    this.restoration = restoration;
  }
}

const defaultSpawnProcess: SpawnProcess = (command, args, options) => spawn(command, [...args], options);

function isOwnershipMarker(value: unknown): value is OwnershipMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return typeof Reflect.get(value, 'auditId') === 'string'
    && typeof Reflect.get(value, 'ownerId') === 'string'
    && typeof Reflect.get(value, 'ownershipToken') === 'string'
    && typeof Reflect.get(value, 'instanceId') === 'string'
    && typeof Reflect.get(value, 'generation') === 'number'
    && typeof Reflect.get(value, 'pid') === 'number'
    && typeof Reflect.get(value, 'argv') === 'string'
    && Array.isArray(Reflect.get(value, 'launchArgv'))
    && typeof Reflect.get(value, 'workspace') === 'string';
}

function createReadinessSocket(endpoint: string) {
  const socket = new WebSocket(endpoint);
  return {
    on(event: string, listener: (event?: unknown) => void): void {
      if (event === 'message') socket.on(event, (data) => listener(data));
      else socket.on(event, listener);
    },
    send(data: string): void { socket.send(data); },
    close(code?: number, reason?: string): void { socket.close(code, reason); },
    terminate(): void { socket.terminate(); },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
        else reject(new Error('Managed Meteor port reservation did not bind TCP'));
      });
    });
  });
}

function assertOwnedRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
    || !path.basename(resolved).startsWith(CLUSTER_PREFIX)) {
    throw new Error('Managed Meteor cluster root is outside the owned temporary namespace');
  }
  return resolved;
}

function appendBounded(current: string, chunk: unknown): string {
  return `${current}${chunk}`.slice(-STDERR_LIMIT);
}

function immutable<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  deepFreeze(clone);
  return clone;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function defaultInspectProcess(pid: number): ProcessIdentity | null {
  try {
    const argv = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    return argv.length > 0 ? { pid, argv } : null;
  } catch {
    return null;
  }
}

function defaultGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function authenticatedReadinessProbe({
  auditId, instanceId, port, ownershipToken, signal,
}: ReadinessContext): Promise<void> {
  const client = new RawDdpClient({
    endpoint: `ws://127.0.0.1:${port}/websocket`,
    webSocketFactory: createReadinessSocket,
    clientId: `readiness-${instanceId}`,
    maximumLedgerEntries: MAXIMUM_PROBE_LEDGER_ENTRIES,
    operationTimeoutMs: READINESS_ATTEMPT_TIMEOUT_MS,
  });
  try {
    const operationOptions = signal === undefined ? {} : { signal };
    await client.connect(operationOptions);
    await client.call('audit.monitorSnapshot', [{ runId: auditId, ownershipToken }], operationOptions);
  } finally {
    client.terminate();
  }
}

async function boundedReadinessAttempt(
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  instanceId: string,
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Managed Meteor instance ${instanceId} readiness attempt exceeded ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReadiness(
  instance: MeteorInstance,
  cluster: OwnedMeteorCluster,
  timeoutMs = cluster.startupTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = instance.child;
    if (!child) throw new Error('Managed Meteor instance has no process');
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Managed Meteor instance exited during startup: ${instance.stdout}\n${instance.stderr}`);
    }
    try {
      const remainingMs = deadline - Date.now();
      await boundedReadinessAttempt((signal) => cluster.readinessProbe({
        auditId: cluster.auditId,
        instanceId: instance.id,
        port: instance.port,
        ownershipToken: cluster.token,
        signal,
      }), Math.min(cluster.readinessAttemptTimeoutMs, remainingMs), instance.id);
      return;
    } catch {
      // The authenticated method is unavailable until the fixture is fully initialized.
    }
    await delay(250);
  }
  throw new Error(`Managed Meteor instance ${instance.id} did not pass its authenticated readiness probe`);
}

async function waitForExit(child: ManagedMeteorProcess, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  await Promise.race([
    exited,
    delay(timeoutMs).then(() => { throw new Error('Managed Meteor process did not exit'); }),
  ]);
}

async function waitForGroupExit(pid: number, groupExists: GroupExists, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) return;
    await delay(25);
  }
  throw new Error('Managed Meteor process group did not terminate');
}

/** Copies source inputs while keeping dependency storage read-only and shared. */
export function materializeMeteorApp({ sourcePath, destinationPath }: Readonly<{
  sourcePath: string; destinationPath: string;
}>): void {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
    throw new TypeError('Meteor app materialization paths must be absolute');
  }
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(sourcePath, candidate);
      return relative !== 'node_modules'
        && relative !== '.meteor/local'
        && !relative.startsWith(`.meteor${path.sep}local${path.sep}`);
    },
  });
  const nodeModules = path.join(sourcePath, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    fs.symlinkSync(nodeModules, path.join(destinationPath, 'node_modules'), 'dir');
  }
}

/** Owns two isolated Meteor tool workspaces that share only the audit database. */
export class OwnedMeteorCluster {
  readonly auditId: string;
  readonly appPath: string;
  readonly meteorCommand: string;
  readonly meteorArgsPrefix: readonly string[];
  readonly mongoUrl: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly rootPath: string;
  readonly spawnProcess: SpawnProcess;
  readonly readinessProbe: ReadinessProbe;
  readonly inspectProcess: InspectProcess;
  readonly signalProcess: SignalProcess;
  readonly groupExists: GroupExists;
  readonly startupTimeoutMs: number;
  readonly readinessAttemptTimeoutMs: number;
  readonly ownerId: string;
  readonly token: string;
  instances: MeteorInstance[];
  forcedShutdowns: number;

  constructor({
    auditId, appPath, meteorCommand, meteorArgsPrefix = [], mongoUrl, environment = {}, rootPath,
    spawnProcess = defaultSpawnProcess, readinessProbe = authenticatedReadinessProbe,
    inspectProcess = defaultInspectProcess, signalProcess = process.kill, groupExists = defaultGroupExists,
    startupTimeoutMs = STARTUP_TIMEOUT_MS, readinessAttemptTimeoutMs = READINESS_ATTEMPT_TIMEOUT_MS,
  }: OwnedMeteorClusterOptions) {
    if (!auditId) throw new TypeError('auditId is required');
    if (!path.isAbsolute(appPath)) throw new TypeError('appPath must be absolute');
    if (typeof meteorCommand !== 'string' || meteorCommand.length === 0) throw new TypeError('meteorCommand is required');
    if (!Array.isArray(meteorArgsPrefix)
      || meteorArgsPrefix.some((argument) => typeof argument !== 'string' || argument.length === 0)) {
      throw new TypeError('meteorArgsPrefix must contain non-empty argv strings');
    }
    if (typeof mongoUrl !== 'string' || !mongoUrl.startsWith('mongodb://127.0.0.1:')) {
      throw new TypeError('Owned Meteor cluster requires a loopback MongoDB URL');
    }
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1) {
      throw new TypeError('startupTimeoutMs must be a positive integer');
    }
    if (!Number.isSafeInteger(readinessAttemptTimeoutMs) || readinessAttemptTimeoutMs < 1) {
      throw new TypeError('readinessAttemptTimeoutMs must be a positive integer');
    }
    this.auditId = auditId;
    this.appPath = appPath;
    this.meteorCommand = meteorCommand;
    this.meteorArgsPrefix = Object.freeze([...meteorArgsPrefix]);
    this.mongoUrl = mongoUrl;
    this.environment = Object.freeze({ ...environment });
    this.rootPath = assertOwnedRoot(rootPath);
    this.spawnProcess = spawnProcess;
    this.readinessProbe = readinessProbe;
    this.inspectProcess = inspectProcess;
    this.signalProcess = signalProcess;
    this.groupExists = groupExists;
    this.startupTimeoutMs = startupTimeoutMs;
    this.readinessAttemptTimeoutMs = readinessAttemptTimeoutMs;
    this.ownerId = crypto.randomUUID();
    this.token = crypto.randomBytes(32).toString('hex');
    this.instances = [];
    this.forcedShutdowns = 0;
  }

  static async create(options: OwnedMeteorClusterCreateOptions): Promise<OwnedMeteorCluster> {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), CLUSTER_PREFIX));
    const cluster = new OwnedMeteorCluster({ ...options, rootPath });
    try {
      await cluster.start();
      return cluster;
    } catch (error) {
      await cluster.stop().catch(() => {});
      throw error;
    }
  }

  get backends(): readonly MeteorBackend[] {
    return this.instances.map(({ id, port }) => Object.freeze({
      id,
      httpUrl: `http://127.0.0.1:${port}`,
      webSocketUrl: `ws://127.0.0.1:${port}`,
    }));
  }

  async start(): Promise<void> {
    if (this.instances.length > 0) throw new Error('Managed Meteor cluster is already started');
    const ports = await Promise.all(Array.from({ length: INSTANCE_COUNT }, reservePort));
    for (const [index, port] of ports.entries()) {
      const id = `meteor-${index}`;
      const workspace = path.join(this.rootPath, id);
      materializeMeteorApp({ sourcePath: this.appPath, destinationPath: workspace });
      const instance: MeteorInstance = { id, port, workspace, generation: 0, child: null, pid: null, markerPath: path.join(workspace, MARKER_NAME), stdout: '', stderr: '' };
      this.instances.push(instance);
      await this.#spawnInstance(instance);
    }
    await Promise.all(this.instances.map((instance) => waitForReadiness(instance, this)));
    for (const instance of this.instances) this.#writeOwnershipMarker(instance);
  }

  async #spawnInstance(instance: MeteorInstance): Promise<void> {
    const args = [...this.meteorArgsPrefix, 'run', '--port', `127.0.0.1:${instance.port}`];
    const child = this.spawnProcess(this.meteorCommand, args, {
      cwd: instance.workspace,
      detached: true,
      env: {
        ...process.env,
        ...this.environment,
        MONGO_URL: this.mongoUrl,
        ROOT_URL: `http://127.0.0.1:${instance.port}`,
        AUDIT_RUN_ID: this.auditId,
        AUDIT_INSTANCE_ID: instance.id,
        AUDIT_OWNERSHIP_TOKEN: this.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Managed Meteor process did not expose a valid pid');
    instance.child = child;
    instance.pid = pid;
    instance.generation += 1;
    instance.stdout = '';
    instance.stderr = '';
    child.stdout?.on('data', (chunk) => { instance.stdout = appendBounded(instance.stdout, chunk); });
    child.stderr?.on('data', (chunk) => { instance.stderr = appendBounded(instance.stderr, chunk); });
    this.#writeOwnershipMarker(instance);
  }

  #writeOwnershipMarker(instance: MeteorInstance): void {
    const pid = instance.pid;
    if (!instance.child || pid === null) throw new Error('Managed Meteor process is unavailable');
    const liveIdentity = this.inspectProcess(pid);
    if (!liveIdentity || liveIdentity.pid !== pid || typeof liveIdentity.argv !== 'string' || liveIdentity.argv.length === 0) {
      throw new Error('Managed Meteor process identity was unavailable after spawn');
    }
    const launchArgv = [
      this.meteorCommand,
      ...this.meteorArgsPrefix,
      'run',
      '--port',
      `127.0.0.1:${instance.port}`,
    ];
    const marker = {
      auditId: this.auditId,
      ownerId: this.ownerId,
      ownershipToken: this.token,
      instanceId: instance.id,
      generation: instance.generation,
      pid,
      argv: liveIdentity.argv,
      launchArgv,
      workspace: instance.workspace,
    };
    fs.writeFileSync(instance.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'w' });
  }

  assertOwnedInstance(instanceId: string): MeteorInstance {
    const instance = this.instances.find(({ id }) => id === instanceId);
    if (!instance?.child || instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Managed Meteor instance ${instanceId} is not a live owned target`);
    }
    let marker: unknown;
    try {
      marker = JSON.parse(fs.readFileSync(instance.markerPath, 'utf8'));
    } catch {
      throw new Error(`Managed Meteor instance ${instanceId} has no valid ownership marker`);
    }
    const expectedArgs = [this.meteorCommand, ...this.meteorArgsPrefix, 'run', '--port', `127.0.0.1:${instance.port}`];
    if (!isOwnershipMarker(marker) || marker.auditId !== this.auditId || marker.ownerId !== this.ownerId
      || marker.ownershipToken !== this.token || marker.instanceId !== instance.id
      || marker.generation !== instance.generation || marker.pid !== instance.pid
      || marker.workspace !== instance.workspace
      || JSON.stringify(marker.launchArgv) !== JSON.stringify(expectedArgs)
      || typeof marker.argv !== 'string' || marker.argv.length === 0) {
      throw new Error(`Managed Meteor instance ${instanceId} ownership attestation failed`);
    }
    const pid = instance.pid;
    if (pid === null) throw new Error(`Managed Meteor instance ${instanceId} has no process identity`);
    const live = this.inspectProcess(pid);
    if (!live || live.pid !== pid
      || live.argv !== marker.argv) {
      throw new Error(`Managed Meteor instance ${instanceId} live process identity does not match its marker`);
    }
    return instance;
  }

  async #terminate(instance: MeteorInstance): Promise<Readonly<{ terminated: boolean; processGroupTerminated: boolean; forced: boolean }>> {
    this.assertOwnedInstance(instance.id);
    const child = instance.child;
    const pid = instance.pid;
    if (!child || pid === null) throw new Error('Managed Meteor process is unavailable');
    let forced = false;
    try {
      this.signalProcess(-pid, 'SIGTERM');
      await waitForExit(child);
      await waitForGroupExit(pid, this.groupExists);
    } catch {
      forced = true;
      this.forcedShutdowns += 1;
      if (child.exitCode === null && child.signalCode === null) {
        this.signalProcess(-pid, 'SIGKILL');
        await waitForExit(child).catch(() => {});
      }
      await waitForGroupExit(pid, this.groupExists);
    }
    fs.rmSync(instance.markerPath, { force: true });
    return immutable({ terminated: true, processGroupTerminated: true, forced });
  }

  async stopInstance(instanceId: string): Promise<Readonly<{ terminated: boolean; processGroupTerminated: boolean; forced: boolean }>> {
    return this.#terminate(this.assertOwnedInstance(instanceId));
  }

  async restartInstance(instanceId: string): Promise<Readonly<{ id: string; generation: number }>> {
    const instance = this.instances.find(({ id }) => id === instanceId);
    if (!instance) throw new Error(`Managed Meteor instance ${instanceId} is not owned by this cluster`);
    if (instance.child?.exitCode === null && instance.child?.signalCode === null) {
      await this.#terminate(instance);
    }
    await this.#spawnInstance(instance);
    await waitForReadiness(instance, this);
    this.#writeOwnershipMarker(instance);
    return Object.freeze({ id: instance.id, generation: instance.generation });
  }

  async stop(): Promise<Readonly<ClusterRestoration>> {
    const failures: unknown[] = [];
    let terminated = 0;
    for (const instance of this.instances) {
      if (instance.child?.exitCode === null && instance.child?.signalCode === null) {
        try {
          await this.#terminate(instance);
          terminated += 1;
        } catch (error) {
          failures.push(error);
        }
      } else {
        fs.rmSync(instance.markerPath, { force: true });
      }
    }
    const instanceCount = this.instances.length;
    this.instances = [];
    if (failures.length === 0 && fs.existsSync(this.rootPath)) {
      fs.rmSync(assertOwnedRoot(this.rootPath), { recursive: true });
    }
    const restoration = immutable<ClusterRestoration>({
      resource: 'meteor_cluster',
      restored: failures.length === 0 && !fs.existsSync(this.rootPath),
      instanceCount,
      terminatedInstanceCount: terminated,
      forcedShutdownCount: this.forcedShutdowns,
      processGroupsTerminated: failures.length === 0,
      workspaceRemoved: !fs.existsSync(this.rootPath),
    });
    if (failures.length > 0) {
      throw new RestorationAggregateError(failures, 'Managed Meteor cluster cleanup failed', restoration);
    }
    return restoration;
  }
}
