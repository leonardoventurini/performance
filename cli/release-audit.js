import path from 'node:path';
import { runAudit } from './audit.js';
import { resolveMeteorSource } from '../meteor-source.js';
import {
  BOUNDED_CRUD_CASES,
  buildBoundedCrudCaseResult,
} from '../reliability/cases/bounded-crud.js';
import { attestReleaseIdentity } from '../reliability/release-audit/identity.js';
import { coordinateReleaseAudit } from '../reliability/release-audit/coordinator.js';

const DEFAULT_RELEASE = '3.5.1-beta.0';
const DEFAULT_SEED = 42;

function parseSeed(value) {
  const seed = value === undefined ? DEFAULT_SEED : Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('release-audit --seed must be an unsigned 32-bit integer');
  }
  return seed;
}

/** Creates the currently qualified bounded CRUD adapter with per-transport caching. */
export function createReleaseCaseExecutor({
  values,
  config,
  releaseName,
  releaseIdentity,
}) {
  const transportRuns = new Map();
  const executeCase = async ({ coordinate, attemptId, artifactRoot }) => {
    let benchmark = transportRuns.get(coordinate.transport);
    if (!benchmark) {
      benchmark = runAudit({
        values: {
          profile: 'smoke',
          'observer-driver': 'changeStreams',
          seed: String(coordinate.seed),
          'meteor-version': releaseName,
          env: [
            ...(Array.isArray(values.env) ? values.env : values.env ? [values.env] : []),
            `DDP_TRANSPORT=${coordinate.transport}`,
            ...(coordinate.transport === 'uws' ? ['DISABLE_SOCKJS=1'] : []),
          ],
          tag: `release-audit-${releaseName}-${coordinate.transport}`,
          output: path.join(artifactRoot, `bounded-${coordinate.transport}.json`),
        },
        config,
      });
      transportRuns.set(coordinate.transport, benchmark);
    }
    return buildBoundedCrudCaseResult({
      coordinate,
      release: releaseIdentity,
      benchmarkResult: await benchmark,
      attemptId,
    });
  };
  executeCase.supports = (coordinate) => (
    Object.hasOwn(BOUNDED_CRUD_CASES, coordinate.caseId)
    && coordinate.topology === 'replica_set'
    && ['sockjs', 'uws'].includes(coordinate.transport)
    && coordinate.observerOrder[0] === 'changeStreams'
  );
  return executeCase;
}

/** Runs the canonical release-level coordinator and fails unless conformant. */
export async function runReleaseAudit({ values, config }) {
  const releaseName = values['meteor-version'] || values.release || DEFAULT_RELEASE;
  const seed = parseSeed(values.seed);
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const source = resolveMeteorSource({
    flags: { ...values, 'meteor-version': releaseName },
    env: process.env,
    config,
  });
  if (source.mode !== 'release' || source.version !== releaseName) {
    throw new Error('release-audit requires an exact published Meteor release');
  }
  const releaseIdentity = attestReleaseIdentity({
    repositoryRoot,
    requested: releaseName,
    actual: source.version,
    sourceRevision: source.sha,
    settings: {
      topologyScope: ['replica_set'],
      transportScope: ['sockjs', 'uws'],
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    },
  });
  const executeCase = createReleaseCaseExecutor({
    values,
    config,
    releaseName,
    releaseIdentity,
  });
  const result = await coordinateReleaseAudit({
    repositoryRoot,
    resultsRoot: path.join(config.results.dir, 'release-audits'),
    release: releaseName,
    releaseIdentity,
    topologyScope: ['replica_set'],
    transportScope: ['sockjs', 'uws'],
    seed,
    executeCase,
  });
  console.log(`Release audit manifest: ${path.join(result.artifactRoot, 'manifest.json')}`);
  console.log(`Release audit status: ${result.manifest.status}`);
  if (result.manifest.status !== 'conformant') {
    throw new Error(`Release audit is ${result.manifest.status}`);
  }
  return result;
}
