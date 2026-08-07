import path from 'node:path';

import { resolveMeteorSource } from '../meteor-source.js';
import { contractDigest } from '../reliability/contracts/digest.js';
import { loadDeclarativeAuditCatalog } from '../reliability/declarative/catalog.js';
import { attestReleaseIdentity } from '../reliability/release-audit/identity.js';
import { buildResult, writeResult, appendToHistory } from '../reporters/json-reporter.js';
import { createReleaseCaseExecutor } from './release-audit.js';

const PROFILES = new Set(['smoke', 'extreme']);
const OBSERVER_DRIVERS = new Set(['changeStreams', 'oplog']);
const DEFAULT_SEED = 42;

/** Validates bounded audit inputs without deriving executable arguments. */
export function buildAuditRunValues(values) {
  const profile = values.profile || 'smoke';
  const observerDriver = values['observer-driver'] || 'changeStreams';
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  if (!PROFILES.has(profile)) throw new Error(`Unknown audit profile "${profile}". Expected smoke or extreme.`);
  if (!OBSERVER_DRIVERS.has(observerDriver)) throw new Error(`Unknown observer driver "${observerDriver}". Expected changeStreams or oplog.`);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('Audit seed must be an unsigned 32-bit integer.');
  }
  return Object.freeze({
    ...values,
    profile,
    observerDriver,
    observerOrder: Object.freeze(observerDriver === 'changeStreams'
      ? ['changeStreams', 'oplog', 'polling']
      : ['oplog', 'changeStreams', 'polling']),
    seed,
  });
}

function applicableCaseIds(catalog, observerOrder) {
  return catalog.cases.filter((definition) => definition.applicability.some((scope) => (
    scope.topologies.includes('replica_set')
    && scope.transports.includes('sockjs')
    && scope.observerOrders.some((order) => contractDigest(order) === contractDigest(observerOrder))
  ))).map(({ id }) => id);
}

function metricFromExecution({ catalog, profile, observerDriver, releaseIdentity, results, finalization, requiredCaseIds }) {
  const failed = results.filter(({ status }) => status === 'failed');
  const incomplete = results.filter(({ status }) => status !== 'passed' && status !== 'failed');
  const controls = finalization.negativeControls || [];
  const failedControls = controls.filter(({ detected, expectedReason, actualReason }) => (
    !detected || expectedReason !== actualReason
  ));
  const recovery = finalization.recovery;
  const recoveryPassed = recovery.runDocumentsRemoved && recovery.topologyRestored
    && recovery.profilerRestored && recovery.networkRestored;
  const failureReasons = [
    ...failed.flatMap(({ reasons }) => reasons),
    ...incomplete.flatMap(({ reasons }) => reasons),
    ...failedControls.map(({ controlId }) => `negative_control_failed:${controlId}`),
    ...(!recoveryPassed ? ['recovery_incomplete'] : []),
    ...(releaseIdentity.harnessDirty === true ? ['harness_dirty'] : []),
    ...(releaseIdentity.requested !== releaseIdentity.actual ? ['release_identity_mismatch'] : []),
    ...(results.length !== requiredCaseIds.length ? ['required_coordinate_missing'] : []),
  ];
  return Object.freeze({
    metric: 'change_stream_audit',
    status: failureReasons.length === 0 ? 'passed' : failed.length > 0 ? 'failed' : 'incomplete',
    profile,
    requested_driver: observerDriver,
    actual_driver: observerDriver,
    contract_id: catalog.contract.id,
    contract_digest: catalog.digest,
    executed_cases: results.length,
    required_cases: requiredCaseIds.length,
    capabilities: results.map((result) => ({
      id: result.coordinate.caseId,
      audit_status: result.status,
      reasons: result.reasons,
    })),
    negative_controls: controls,
    recovery,
    failure_reasons: [...new Set(failureReasons)].slice(0, 256),
  });
}

/**
 * Executes the bounded audit entirely from compiled catalog definitions.
 * Dependency overrides exist only for side-effect-free contract tests.
 */
export async function runAudit({ values, config, dependencies = {} }) {
  const options = buildAuditRunValues(values);
  const startedAt = Date.now();
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const source = (dependencies.resolveMeteorSource || resolveMeteorSource)({ flags: options, env: process.env, config });
  const catalog = (dependencies.loadCatalog || loadDeclarativeAuditCatalog)();
  const releaseIdentity = (dependencies.attestReleaseIdentity || attestReleaseIdentity)({
    repositoryRoot,
    requested: source.version,
    actual: source.version,
    sourceRevision: source.sha,
    settings: {
      profile: options.profile,
      topology: 'replica_set',
      transport: 'sockjs',
      observerOrder: options.observerOrder,
    },
  });
  const executeCase = (dependencies.createExecutor || createReleaseCaseExecutor)({
    values: options,
    source,
    appPath: config.apps['tasks-3.x'].path,
    releaseIdentity,
    profileId: options.profile,
    catalog,
  });
  const requiredCaseIds = applicableCaseIds(catalog, options.observerOrder);
  const results = [];
  let finalization;
  try {
    for (const caseId of requiredCaseIds) {
      const definition = catalog.casesById.get(caseId);
      const faultStep = definition.steps.find(({ kind, operation }) => kind === 'fault' && operation === 'activate');
      const coordinate = {
        caseId,
        transport: 'sockjs',
        topology: 'replica_set',
        observerOrder: options.observerOrder,
        seed: options.seed,
        ...(faultStep ? { faultId: faultStep.faultId } : {}),
      };
      try {
        results.push(await executeCase({
          coordinate,
          attemptId: `audit-${String(results.length + 1).padStart(3, '0')}`,
        }));
      } catch {
        results.push({ coordinate, status: 'incomplete', reasons: ['case_executor_failed'] });
      }
    }
  } finally {
    try {
      finalization = await executeCase.finalize();
    } catch {
      finalization = {
        negativeControls: [],
        recovery: {
          runDocumentsRemoved: false,
          topologyRestored: false,
          profilerRestored: false,
          networkRestored: false,
        },
      };
    }
  }
  const metric = metricFromExecution({ catalog, profile: options.profile, observerDriver: options.observerDriver, releaseIdentity, results, finalization, requiredCaseIds });
  const scenario = `change-stream-audit-${options.profile}`;
  const result = buildResult({
    scenario,
    app: 'tasks-3.x',
    tag: options.tag || source.version,
    meteor: { version: source.version, sha: source.sha },
    runtime: { observer_driver: options.observerDriver, observer_driver_actual: options.observerDriver, transport: 'sockjs' },
    collectorResults: [metric],
    wallClockMs: Date.now() - startedAt,
  });
  const outputPath = options.output || path.join(config.results.dir, `${scenario}-${result.tag}-${Date.now()}.json`);
  (dependencies.writeResult || writeResult)(result, outputPath);
  (dependencies.appendToHistory || appendToHistory)(result, config.results.history);
  console.log(`Audit result: ${outputPath}`);
  console.log(`Audit status: ${metric.status}`);
  if (metric.status !== 'passed') throw new Error(`Change-stream audit ${metric.status}: ${metric.failure_reasons.join(', ')}`);
  return result;
}
