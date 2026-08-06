import path from 'node:path';

import { resolveMeteorSource } from '../meteor-source.js';
import { contractDigest } from '../reliability/contracts/digest.js';
import { loadDeclarativeAuditCatalog } from '../reliability/declarative/catalog.js';
import { compileDeclarativeCase } from '../reliability/declarative/compiler.js';
import { OwnedAuditEnvironment } from '../reliability/environment/owned-audit-environment.js';
import { coordinateReleaseAudit } from '../reliability/release-audit/coordinator.js';
import { attestReleaseIdentity } from '../reliability/release-audit/identity.js';
import { runDeclarativeCase } from '../reliability/runtime/run-case.js';
import { runDeclarativeNegativeControls } from '../reliability/runtime/negative-controls.js';

const DEFAULT_RELEASE = '3.5.1-beta.0';
const DEFAULT_SEED = 42;

function parseSeed(value) {
  const seed = value === undefined ? DEFAULT_SEED : Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('release-audit --seed must be an unsigned 32-bit integer');
  }
  return seed;
}

function transportEnvironment(transport, observerOrder, extraEnvironment) {
  return {
    ...extraEnvironment,
    METEOR_REACTIVITY_ORDER: observerOrder.join(','),
    DDP_TRANSPORT: transport,
    ...(transport === 'uws' ? { DISABLE_SOCKJS: '1' } : {}),
  };
}

/** Creates the fail-closed executor for every compiled declarative coordinate. */
export function createReleaseCaseExecutor({
  values,
  source,
  appPath,
  releaseIdentity,
  profileId = 'smoke',
  catalog = loadDeclarativeAuditCatalog(),
  environmentFactory = (options) => new OwnedAuditEnvironment(options).start(),
  runCase = runDeclarativeCase,
}) {
  const environments = new Map();
  const caseOutcomes = [];
  const executionRecords = [];
  let attemptedCoordinates = 0;
  const extraEnvironment = Object.fromEntries((Array.isArray(values.env) ? values.env : values.env ? [values.env] : [])
    .map((entry) => String(entry).split(/=(.*)/su).slice(0, 2))
    .filter(([key]) => key));

  const environmentFor = async (coordinate) => {
    const key = `${coordinate.transport}|${coordinate.observerOrder.join(',')}`;
    let environment = environments.get(key);
    if (!environment) {
      environment = await environmentFactory({
        auditId: `declarative-${Date.now()}-${coordinate.transport}`,
        source,
        appPath,
        environment: transportEnvironment(coordinate.transport, coordinate.observerOrder, extraEnvironment),
      });
      environments.set(key, environment);
    }
    return environment;
  };

  const executeCase = async ({ coordinate, attemptId }) => {
    attemptedCoordinates += 1;
    const definition = catalog.casesById.get(coordinate.caseId);
    if (!definition) throw new Error(`required declarative case ${coordinate.caseId} is missing`);
    const plan = compileDeclarativeCase({
      catalog, caseId: coordinate.caseId, profileId, coordinate,
    });
    const environment = await environmentFor(coordinate);
    const result = await runCase({
      environment, definition, plan, release: releaseIdentity, attemptId,
      captureExecution: (record) => executionRecords.push(record),
    });
    caseOutcomes.push(result);
    return result;
  };

  executeCase.finalize = async () => {
    const restorations = [];
    for (const environment of environments.values()) restorations.push(await environment.stop());
    environments.clear();
    const restored = restorations.length > 0 && restorations.every((entry) => entry.restored);
    const recoveryPayload = {
      runDocumentsRemoved: restored,
      topologyRestored: restored,
      profilerRestored: true,
      networkRestored: restored,
    };
    const negativeControls = runDeclarativeNegativeControls({
      controls: catalog.negativeControls || [],
      records: executionRecords,
      recovery: recoveryPayload,
      requiredCoordinateCount: attemptedCoordinates,
    });
    return {
      recovery: { ...recoveryPayload, digest: contractDigest(recoveryPayload) },
      negativeControls,
      caseOutcomes,
    };
  };
  return executeCase;
}

/** Runs the canonical release-level coordinator and fails unless conformant. */
export async function runReleaseAudit({ values, config }) {
  const releaseName = values['meteor-version'] || values.release || DEFAULT_RELEASE;
  const seed = parseSeed(values.seed);
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const source = resolveMeteorSource({
    flags: { ...values, 'meteor-version': releaseName }, env: process.env, config,
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
    source,
    appPath: config.apps['tasks-3.x'].path,
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
  if (result.manifest.status !== 'conformant') throw new Error(`Release audit is ${result.manifest.status}`);
  return result;
}
