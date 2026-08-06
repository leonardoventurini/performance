import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import WebSocket from 'ws';

import { RawDdpClient } from '../runtime/ddp/raw-client.js';

const INSTANCE_COUNT = 2;
const CLUSTER_PREFIX = 'meteor-audit-cluster-';
const MARKER_NAME = '.audit-process-owner.json';
const STARTUP_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const STDERR_LIMIT = 32_768;
const MAXIMUM_PROBE_LEDGER_ENTRIES = 32;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function assertOwnedRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
    || !path.basename(resolved).startsWith(CLUSTER_PREFIX)) {
    throw new Error('Managed Meteor cluster root is outside the owned temporary namespace');
  }
  return resolved;
}

function appendBounded(current, chunk) {
  return `${current}${chunk}`.slice(-STDERR_LIMIT);
}

function immutable(value) {
  const clone = structuredClone(value);
  const freeze = (entry) => {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(clone);
}

function defaultInspectProcess(pid) {
  try {
    const argv = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    return argv.length > 0 ? { pid, argv } : null;
  } catch {
    return null;
  }
}

function defaultGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function authenticatedReadinessProbe({ auditId, instanceId, port, ownershipToken }) {
  const client = new RawDdpClient({
    endpoint: `ws://127.0.0.1:${port}/websocket`,
    webSocketFactory: (endpoint) => new WebSocket(endpoint),
    clientId: `readiness-${instanceId}`,
    maximumLedgerEntries: MAXIMUM_PROBE_LEDGER_ENTRIES,
  });
  try {
    await client.connect();
    await client.call('audit.monitorSnapshot', [{ runId: auditId, ownershipToken }]);
  } finally {
    client.close(1000, 'readiness probe complete');
  }
}

async function waitForReadiness(instance, cluster, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Managed Meteor instance exited during startup: ${instance.stdout}\n${instance.stderr}`);
    }
    try {
      await cluster.readinessProbe({
        auditId: cluster.auditId,
        instanceId: instance.id,
        port: instance.port,
        ownershipToken: cluster.token,
      });
      return;
    } catch {
      // The authenticated method is unavailable until the fixture is fully initialized.
    }
    await delay(250);
  }
  throw new Error(`Managed Meteor instance ${instance.id} did not pass its authenticated readiness probe`);
}

async function waitForExit(child, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  await Promise.race([
    exited,
    delay(timeoutMs).then(() => { throw new Error('Managed Meteor process did not exit'); }),
  ]);
}

async function waitForGroupExit(pid, groupExists, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) return;
    await delay(25);
  }
  throw new Error('Managed Meteor process group did not terminate');
}

/** Copies source inputs while keeping dependency storage read-only and shared. */
export function materializeMeteorApp({ sourcePath, destinationPath }) {
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
  constructor({
    auditId, appPath, meteorCommand, meteorArgsPrefix = [], mongoUrl, environment = {}, rootPath,
    spawnProcess = spawn, readinessProbe = authenticatedReadinessProbe,
    inspectProcess = defaultInspectProcess, signalProcess = process.kill, groupExists = defaultGroupExists,
  }) {
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
    this.ownerId = crypto.randomUUID();
    this.token = crypto.randomBytes(32).toString('hex');
    this.instances = [];
    this.forcedShutdowns = 0;
  }

  static async create(options) {
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

  get backends() {
    return this.instances.map(({ id, port }) => Object.freeze({
      id,
      httpUrl: `http://127.0.0.1:${port}`,
      webSocketUrl: `ws://127.0.0.1:${port}`,
    }));
  }

  async start() {
    if (this.instances.length > 0) throw new Error('Managed Meteor cluster is already started');
    const ports = await Promise.all(Array.from({ length: INSTANCE_COUNT }, reservePort));
    for (const [index, port] of ports.entries()) {
      const id = `meteor-${index}`;
      const workspace = path.join(this.rootPath, id);
      materializeMeteorApp({ sourcePath: this.appPath, destinationPath: workspace });
      const instance = { id, port, workspace, generation: 0, child: null, markerPath: path.join(workspace, MARKER_NAME), stdout: '', stderr: '' };
      this.instances.push(instance);
      await this.#spawnInstance(instance);
    }
    await Promise.all(this.instances.map((instance) => waitForReadiness(instance, this)));
    for (const instance of this.instances) this.#writeOwnershipMarker(instance);
  }

  async #spawnInstance(instance) {
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
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error('Managed Meteor process did not expose a valid pid');
    instance.child = child;
    instance.generation += 1;
    instance.stdout = '';
    instance.stderr = '';
    child.stdout?.on('data', (chunk) => { instance.stdout = appendBounded(instance.stdout, chunk); });
    child.stderr?.on('data', (chunk) => { instance.stderr = appendBounded(instance.stderr, chunk); });
    this.#writeOwnershipMarker(instance);
  }

  #writeOwnershipMarker(instance) {
    const liveIdentity = this.inspectProcess(instance.child.pid);
    if (!liveIdentity || liveIdentity.pid !== instance.child.pid || typeof liveIdentity.argv !== 'string' || liveIdentity.argv.length === 0) {
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
      pid: instance.child.pid,
      argv: liveIdentity.argv,
      launchArgv,
      workspace: instance.workspace,
    };
    fs.writeFileSync(instance.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'w' });
  }

  assertOwnedInstance(instanceId) {
    const instance = this.instances.find(({ id }) => id === instanceId);
    if (!instance?.child || instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Managed Meteor instance ${instanceId} is not a live owned target`);
    }
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(instance.markerPath, 'utf8'));
    } catch {
      throw new Error(`Managed Meteor instance ${instanceId} has no valid ownership marker`);
    }
    const expectedArgs = [this.meteorCommand, ...this.meteorArgsPrefix, 'run', '--port', `127.0.0.1:${instance.port}`];
    if (marker.auditId !== this.auditId || marker.ownerId !== this.ownerId
      || marker.ownershipToken !== this.token || marker.instanceId !== instance.id
      || marker.generation !== instance.generation || marker.pid !== instance.child.pid
      || marker.workspace !== instance.workspace
      || JSON.stringify(marker.launchArgv) !== JSON.stringify(expectedArgs)
      || typeof marker.argv !== 'string' || marker.argv.length === 0) {
      throw new Error(`Managed Meteor instance ${instanceId} ownership attestation failed`);
    }
    const live = this.inspectProcess(instance.child.pid);
    if (!live || live.pid !== instance.child.pid
      || live.argv !== marker.argv) {
      throw new Error(`Managed Meteor instance ${instanceId} live process identity does not match its marker`);
    }
    return instance;
  }

  async #terminate(instance) {
    this.assertOwnedInstance(instance.id);
    let forced = false;
    try {
      this.signalProcess(-instance.child.pid, 'SIGTERM');
      await waitForExit(instance.child);
      await waitForGroupExit(instance.child.pid, this.groupExists);
    } catch {
      forced = true;
      this.forcedShutdowns += 1;
      if (instance.child.exitCode === null && instance.child.signalCode === null) {
        this.signalProcess(-instance.child.pid, 'SIGKILL');
        await waitForExit(instance.child).catch(() => {});
      }
      await waitForGroupExit(instance.child.pid, this.groupExists);
    }
    fs.rmSync(instance.markerPath, { force: true });
    return immutable({ terminated: true, processGroupTerminated: true, forced });
  }

  async stopInstance(instanceId) {
    return this.#terminate(this.assertOwnedInstance(instanceId));
  }

  async restartInstance(instanceId) {
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

  async stop() {
    const failures = [];
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
    const restoration = immutable({
      resource: 'meteor_cluster',
      restored: failures.length === 0 && !fs.existsSync(this.rootPath),
      instanceCount,
      terminatedInstanceCount: terminated,
      forcedShutdownCount: this.forcedShutdowns,
      processGroupsTerminated: failures.length === 0,
      workspaceRemoved: !fs.existsSync(this.rootPath),
    });
    if (failures.length > 0) {
      const error = new AggregateError(failures, 'Managed Meteor cluster cleanup failed');
      error.restoration = restoration;
      throw error;
    }
    return restoration;
  }
}
