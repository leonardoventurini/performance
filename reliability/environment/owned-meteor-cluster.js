import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const INSTANCE_COUNT = 2;
const CLUSTER_PREFIX = 'meteor-audit-cluster-';
const STARTUP_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const STDERR_LIMIT = 32_768;

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

async function waitForHttp(url, child, getStderr, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Managed Meteor instance exited during startup: ${getStderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) return;
    } catch {
      // Startup routinely refuses connections until the bundle is ready.
    }
    await delay(250);
  }
  throw new Error(`Managed Meteor instance did not become ready at ${url}`);
}

async function waitForExit(child, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => { throw new Error(`Managed Meteor process ${child.pid} did not exit`); }),
  ]);
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
  constructor({ auditId, appPath, meteorCommand, meteorArgsPrefix = [], mongoUrl, environment = {}, rootPath, spawnProcess = spawn }) {
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
    this.token = crypto.randomBytes(32).toString('hex');
    this.instances = [];
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
      const args = [...this.meteorArgsPrefix, 'run', '--port', `127.0.0.1:${port}`];
      const child = this.spawnProcess(this.meteorCommand, args, {
        cwd: workspace,
        detached: true,
        env: {
          ...process.env,
          ...this.environment,
          MONGO_URL: this.mongoUrl,
          ROOT_URL: `http://127.0.0.1:${port}`,
          AUDIT_RUN_ID: this.auditId,
          AUDIT_INSTANCE_ID: id,
          AUDIT_OWNERSHIP_TOKEN: this.token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const instance = { id, port, workspace, child, stdout: '', stderr: '' };
      child.stdout?.on('data', (chunk) => { instance.stdout = appendBounded(instance.stdout, chunk); });
      child.stderr?.on('data', (chunk) => { instance.stderr = appendBounded(instance.stderr, chunk); });
      this.instances.push(instance);
    }
    await Promise.all(this.instances.map((instance) => waitForHttp(
      `http://127.0.0.1:${instance.port}`,
      instance.child,
      () => `${instance.stdout}\n${instance.stderr}`,
    )));
  }

  assertOwnedInstance(instanceId) {
    const instance = this.instances.find(({ id }) => id === instanceId);
    if (!instance || instance.child.exitCode !== null || instance.child.signalCode !== null) {
      throw new Error(`Managed Meteor instance ${instanceId} is not a live owned target`);
    }
    return instance;
  }

  async stopInstance(instanceId) {
    const instance = this.assertOwnedInstance(instanceId);
    process.kill(-instance.child.pid, 'SIGTERM');
    await waitForExit(instance.child);
  }

  async stop() {
    const failures = [];
    for (const instance of this.instances) {
      if (instance.child.exitCode === null && instance.child.signalCode === null) {
        try {
          process.kill(-instance.child.pid, 'SIGTERM');
          await waitForExit(instance.child);
        } catch (error) {
          failures.push(error);
          if (instance.child.exitCode === null && instance.child.signalCode === null) {
            process.kill(-instance.child.pid, 'SIGKILL');
            await waitForExit(instance.child).catch(() => {});
          }
        }
      }
    }
    this.instances = [];
    if (fs.existsSync(this.rootPath)) fs.rmSync(assertOwnedRoot(this.rootPath), { recursive: true });
    if (failures.length > 0) throw new AggregateError(failures, 'Managed Meteor cluster cleanup failed');
  }
}
