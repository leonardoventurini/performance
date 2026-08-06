import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { MongoClient } from 'mongodb';

const MEMBER_COUNT = 3;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const TOPOLOGY_PREFIX = 'meteor-audit-rs-';
const OWNERSHIP_FILE = 'ownership.json';
const STDERR_LIMIT = 16_384;

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForPort(port, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
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

async function waitForMember(member, timeoutMs = STARTUP_TIMEOUT_MS) {
  if (member.child.exitCode !== null || member.child.signalCode !== null) {
    throw new Error(
      `Managed MongoDB member ${member.index} exited during startup `
      + `(code=${member.child.exitCode}, signal=${member.child.signalCode}): ${member.stderr}`,
    );
  }
  let exited;
  const exit = new Promise((resolve) => {
    exited = (code, signal) => resolve({ code, signal });
    member.child.once('exit', exited);
  });
  try {
    const outcome = await Promise.race([
      waitForPort(member.port, timeoutMs).then(() => null),
      exit,
    ]);
    if (outcome) {
      throw new Error(
        `Managed MongoDB member ${member.index} exited during startup `
        + `(code=${outcome.code}, signal=${outcome.signal}): ${member.stderr}`,
      );
    }
  } finally {
    member.child.removeListener('exit', exited);
  }
}

async function waitForExit(child, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  await Promise.race([
    exited,
    wait(timeoutMs).then(() => { throw new Error(`Managed process ${child.pid} did not exit`); }),
  ]);
}

function assertSafeTopologyRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(temporaryRoot)
    || !path.basename(resolved).startsWith(TOPOLOGY_PREFIX)) {
    throw new Error('Managed replica-set root is outside the owned temporary namespace');
  }
  return resolved;
}

/** Builds the closed mongod argument contract used by every owned member. */
export function buildMongodArgs({ dbPath, port, replicaSetName }) {
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
export function validateOwnedTopologyMarker(marker, { auditId, ownerPid, token }) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
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
    if (!member || member.index !== index
      || !Number.isSafeInteger(member.port) || member.port < 1024 || member.port > 65535
      || !Number.isSafeInteger(member.pid) || member.pid < 1
      || typeof member.argvDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(member.argvDigest)) {
      throw new Error('Managed topology ownership marker has invalid members');
    }
    ports.add(member.port);
    pids.add(member.pid);
  }
  if (ports.size !== MEMBER_COUNT || pids.size !== MEMBER_COUNT) {
    throw new Error('Managed topology ownership marker has duplicate member identity');
  }
  return structuredClone(marker);
}

/**
 * Owns a disposable three-member local MongoDB replica set.
 *
 * Fault methods re-read the ownership marker before mutation and never accept
 * arbitrary endpoints. Only processes spawned by this instance are targeted.
 */
export class OwnedReplicaSet {
  constructor({ auditId, mongodPath, rootPath, mongoClient = MongoClient, spawnProcess = spawn }) {
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
  }

  static async create({ auditId, mongodPath, mongoClient, spawnProcess }) {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), TOPOLOGY_PREFIX));
    const instance = new OwnedReplicaSet({
      auditId,
      mongodPath,
      rootPath,
      mongoClient,
      spawnProcess,
    });
    try {
      await instance.start();
      return instance;
    } catch (error) {
      await instance.stop().catch(() => {});
      throw error;
    }
  }

  get ownershipPath() {
    return path.join(this.rootPath, OWNERSHIP_FILE);
  }

  get uri() {
    const hosts = this.members.map(({ port }) => `127.0.0.1:${port}`).join(',');
    return `mongodb://${hosts}/meteor?replicaSet=${this.replicaSetName}`;
  }

  readAndValidateOwnership() {
    const marker = JSON.parse(fs.readFileSync(this.ownershipPath, 'utf8'));
    return validateOwnedTopologyMarker(marker, {
      auditId: this.auditId,
      ownerPid: this.ownerPid,
      token: this.token,
    });
  }

  writeOwnershipMarker() {
    const marker = {
      schemaVersion: 1,
      auditId: this.auditId,
      ownerPid: this.ownerPid,
      token: this.token,
      replicaSetName: this.replicaSetName,
      members: this.members.map(({ index, port, child, args }) => ({
        index,
        port,
        pid: child.pid,
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

  assertLiveOwnership() {
    const marker = this.readAndValidateOwnership();
    for (const [index, member] of this.members.entries()) {
      const attested = marker.members[index];
      const digest = crypto.createHash('sha256').update(JSON.stringify([
        this.mongodPath,
        ...member.args,
      ])).digest('hex');
      if (member.child.pid !== attested.pid || member.port !== attested.port
        || digest !== attested.argvDigest || member.child.exitCode !== null
        || member.child.signalCode !== null) {
        throw new Error('Managed topology live process identity does not match ownership marker');
      }
    }
    return marker;
  }

  async start() {
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
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
        throw new Error(`Managed MongoDB member ${index} did not expose a process id`);
      }
      const member = { index, port, dbPath, child, args, stderr: '' };
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on?.('data', (chunk) => {
        member.stderr = `${member.stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
      });
      this.members.push(member);
    }
    this.writeOwnershipMarker();
    await Promise.all(this.members.map((member) => waitForMember(member)));
    const bootstrapUri = `mongodb://127.0.0.1:${this.members[0].port}/admin?directConnection=true`;
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

  async awaitHealthy(timeoutMs = STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const client = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: 1_000 });
      try {
        await client.connect();
        const status = await client.db('admin').command({ replSetGetStatus: 1 });
        const members = Array.isArray(status.members) ? status.members : [];
        if (members.filter(({ stateStr }) => stateStr === 'PRIMARY').length === 1
          && members.filter(({ stateStr }) => ['PRIMARY', 'SECONDARY'].includes(stateStr)).length === MEMBER_COUNT) {
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

  async stepDownPrimary(seconds = 5) {
    this.assertLiveOwnership();
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 30) {
      throw new TypeError('Managed primary step-down must be between 1 and 30 seconds');
    }
    const client = new this.mongoClient(this.uri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    try {
      await client.db('admin').command({ replSetStepDown: seconds, force: true });
    } catch (error) {
      if (!/not primary|network|closed|interrupted/u.test(String(error.message))) throw error;
    } finally {
      await client.close();
    }
    await this.awaitHealthy();
  }

  async stop() {
    const errors = [];
    if (!fs.existsSync(this.rootPath) && this.members.length === 0) {
      this.started = false;
      this.markerWritten = false;
      return;
    }
    if (this.markerWritten) {
      try {
        this.readAndValidateOwnership();
      } catch (error) {
        throw new AggregateError([error], 'Refusing to stop MongoDB processes without ownership');
      }
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
  }
}

/** Resolves the MongoDB server bundled with the active Meteor dev bundle. */
export function resolveBundledMongod(appPath) {
  const candidate = path.resolve(appPath, '.meteor', 'local', 'dev_bundle', 'mongodb', 'bin', 'mongod');
  if (!fs.existsSync(candidate)) {
    throw new Error('Meteor bundled mongod is unavailable; reset or run the fixture once before audit setup');
  }
  return fs.realpathSync(candidate);
}
