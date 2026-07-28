import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RELEASE_PREFIX = 'METEOR@';
const UNKNOWN_IDENTITY = 'unknown';

/** Returns a stable SHA-256 digest for a buffer or string. */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Reads a required identity file and fails closed when it is absent. */
export function readIdentityFile(filePath) {
  const value = fs.readFileSync(filePath);
  if (value.length === 0) {
    throw new Error(`Identity file is empty: ${path.basename(filePath)}`);
  }
  return value;
}

/** Normalizes the fixture's exact Meteor release identifier. */
export function readFixtureRelease(repositoryRoot) {
  const release = readIdentityFile(
    path.join(repositoryRoot, 'apps', 'tasks-3.x', '.meteor', 'release'),
  ).toString('utf8').trim();
  if (!release.startsWith(RELEASE_PREFIX) || release.length === RELEASE_PREFIX.length) {
    throw new Error('Fixture release must be an exact METEOR@ release identifier');
  }
  return release;
}

/** Resolves the harness revision and dirtiness without mutating the worktree. */
export function readHarnessIdentity(repositoryRoot, git = execFileSync) {
  const revision = git('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const status = git('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (!/^[0-9a-f]{40,64}$/u.test(revision)) {
    throw new Error('Harness revision is not an exact Git object identifier');
  }
  return { harnessRevision: revision, harnessDirty: status.trim().length > 0 };
}

/** Attests the immutable release and harness inputs for one release audit. */
export function attestReleaseIdentity({
  repositoryRoot,
  requested,
  actual,
  sourceRevision,
  settings = {},
  git,
}) {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error('Release identity requires an absolute repository root');
  }
  for (const [name, value] of Object.entries({ requested, actual, sourceRevision })) {
    if (typeof value !== 'string' || value.trim() === '' || value === UNKNOWN_IDENTITY) {
      throw new Error(`Release identity ${name} must be exact`);
    }
  }

  const fixtureRelease = readFixtureRelease(repositoryRoot);
  const requestedFixture = requested.startsWith(RELEASE_PREFIX)
    ? requested
    : `${RELEASE_PREFIX}${requested}`;
  if (fixtureRelease !== requestedFixture) {
    throw new Error(
      `Fixture release ${fixtureRelease} does not match requested release ${requestedFixture}`,
    );
  }

  const packageVersions = readIdentityFile(
    path.join(repositoryRoot, 'apps', 'tasks-3.x', '.meteor', 'versions'),
  );
  const harness = readHarnessIdentity(repositoryRoot, git);
  return {
    requested,
    actual,
    sourceRevision,
    fixtureRelease,
    packageVersionsDigest: sha256(packageVersions),
    settingsDigest: sha256(JSON.stringify(sortObject(settings))),
    ...harness,
    executionEnvironment: [
      `${process.platform}-${process.arch}`,
      `node-${process.versions.node}`,
      `host-${sha256(os.hostname()).slice(0, 12)}`,
    ].join('/'),
  };
}

/** Attests MongoDB version, FCV, and observed replica-set member roles. */
export async function attestMongoIdentity(database) {
  const admin = database.admin();
  const [buildInfo, featureCompatibility, hello] = await Promise.all([
    admin.command({ buildInfo: 1 }),
    admin.command({ getParameter: 1, featureCompatibilityVersion: 1 }),
    admin.command({ hello: 1 }),
  ]);
  const serverVersion = buildInfo?.version;
  const featureCompatibilityVersion = featureCompatibility?.featureCompatibilityVersion?.version;
  if (typeof serverVersion !== 'string' || typeof featureCompatibilityVersion !== 'string') {
    throw new Error('MongoDB identity is missing version or feature compatibility version');
  }

  const topology = hello?.msg === 'isdbgrid'
    ? 'sharded_cluster'
    : hello?.setName
      ? 'replica_set'
      : 'standalone';
  const topologyName = hello?.setName || (topology === 'sharded_cluster' ? 'mongos' : 'standalone');
  const members = topology === 'replica_set'
    ? [
      ...(hello.primary ? [{ id: stableEndpointId(hello.primary), role: 'primary' }] : []),
      ...((hello.hosts || [])
        .filter((host) => host !== hello.primary)
        .map((host) => ({ id: stableEndpointId(host), role: 'secondary' }))),
      ...((hello.arbiters || [])
        .map((host) => ({ id: stableEndpointId(host), role: 'arbiter' }))),
    ]
    : [{ id: stableEndpointId(topologyName), role: topology === 'sharded_cluster' ? 'mongos' : 'primary' }];

  return {
    serverVersion,
    featureCompatibilityVersion,
    topology,
    topologyName: stableEndpointId(topologyName),
    members,
  };
}

function stableEndpointId(endpoint) {
  return `member-${sha256(String(endpoint)).slice(0, 16)}`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}
