import path from 'node:path';

import { resolveMeteorSource } from '../meteor-source.js';
import { contractDigest } from '../reliability/contracts/digest.js';
import { loadDeclarativeAuditCatalog } from '../reliability/declarative/catalog.js';
import { attestReleaseIdentity } from '../reliability/release-audit/identity.js';
import { buildResult, writeResult, appendToHistory } from '../reporters/json-reporter.js';
import { createReleaseCaseExecutor } from './release-audit.js';
import type { BenchmarkResult, CollectorResult } from '../reporters/json-reporter.js';
import type { CliValues, MeteorSource } from '../lib/benchmark-types.js';
import type { CaseCoordinate } from '../reliability/contracts/release-audit.js';
import type { CatalogEntry } from '../reliability/declarative/catalog.js';

const PROFILES = new Set(['smoke', 'extreme']);
const OBSERVER_DRIVERS = new Set(['changeStreams', 'oplog']);
const DEFAULT_SEED = 42;

type AuditProfile = 'smoke' | 'extreme';
type AuditObserverDriver = 'changeStreams' | 'oplog';
type UnknownRecord = Record<string, unknown>;
interface AuditRunValues extends Readonly<Record<string, unknown>> {
  readonly profile: AuditProfile;
  readonly observerDriver: AuditObserverDriver;
  readonly observerOrder: readonly ['changeStreams', 'oplog', 'polling'] | readonly ['oplog', 'changeStreams', 'polling'];
  readonly seed: number;
}
interface AuditCaseDefinition extends CatalogEntry {
  readonly applicability: readonly Readonly<{
    readonly topologies: readonly string[];
    readonly transports: readonly string[];
    readonly observerOrders: readonly (readonly string[])[];
  }>[];
  readonly steps: readonly Readonly<{ readonly kind: string; readonly operation?: string; readonly faultId?: string }>[];
}
interface AuditCatalog {
  readonly contract: CatalogEntry;
  readonly digest: string;
  readonly cases: readonly AuditCaseDefinition[];
  readonly casesById: ReadonlyMap<string, AuditCaseDefinition>;
}
interface AuditCaseOutcome {
  readonly coordinate: CaseCoordinate;
  readonly status: 'passed' | 'failed' | 'incomplete';
  readonly reasons: readonly string[];
}
interface NegativeControlOutcome {
  readonly controlId: string;
  readonly expectedReason: string;
  readonly actualReason: string;
  readonly detected: boolean;
  readonly [key: string]: unknown;
}
interface RecoveryOutcome {
  readonly runDocumentsRemoved: boolean;
  readonly topologyRestored: boolean;
  readonly profilerRestored: boolean;
  readonly networkRestored: boolean;
  readonly [key: string]: unknown;
}
interface AuditFinalization {
  readonly negativeControls?: readonly NegativeControlOutcome[];
  readonly recovery: RecoveryOutcome;
}
interface AuditExecutor {
  (input: Readonly<{ coordinate: CaseCoordinate; attemptId: string }>): Promise<AuditCaseOutcome>;
  finalize(): Promise<unknown>;
}
interface AuditReleaseIdentity {
  readonly requested: string;
  readonly actual: string;
  readonly harnessDirty: boolean;
}
interface AuditConfig {
  readonly apps: Readonly<Record<string, Readonly<{ path: string }>>>;
  readonly results: Readonly<{ dir: string; history: string }>;
  readonly meteorCheckoutPath?: string;
  readonly meteorVersion?: string;
}
interface AuditDependencies {
  readonly resolveMeteorSource?: (inputs: unknown) => MeteorSource;
  readonly loadCatalog?: () => AuditCatalog;
  readonly attestReleaseIdentity?: (inputs: unknown) => AuditReleaseIdentity;
  readonly createExecutor?: (inputs: UnknownRecord) => AuditExecutor;
  readonly writeResult?: (result: BenchmarkResult, outputPath: string) => void;
  readonly appendToHistory?: (result: BenchmarkResult, historyDir: string) => void;
}

/** Validates bounded audit inputs without deriving executable arguments. */
export function buildAuditRunValues(values: CliValues): AuditRunValues {
  const profile = values.profile || 'smoke';
  const observerDriver = values['observer-driver'] || 'changeStreams';
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  if (typeof profile !== 'string' || !PROFILES.has(profile)) throw new Error(`Unknown audit profile "${String(profile)}". Expected smoke or extreme.`);
  if (typeof observerDriver !== 'string' || !OBSERVER_DRIVERS.has(observerDriver)) throw new Error(`Unknown observer driver "${String(observerDriver)}". Expected changeStreams or oplog.`);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('Audit seed must be an unsigned 32-bit integer.');
  }
  const validatedProfile: AuditProfile = profile === 'extreme' ? 'extreme' : 'smoke';
  const validatedDriver: AuditObserverDriver = observerDriver === 'oplog' ? 'oplog' : 'changeStreams';
  const observerOrder: AuditRunValues['observerOrder'] = validatedDriver === 'changeStreams'
    ? ['changeStreams', 'oplog', 'polling']
    : ['oplog', 'changeStreams', 'polling'];
  return Object.freeze({
    ...values,
    profile: validatedProfile,
    observerDriver: validatedDriver,
    observerOrder: Object.freeze(observerOrder),
    seed,
  });
}

function applicableCaseIds(catalog: AuditCatalog, observerOrder: AuditRunValues['observerOrder']): readonly string[] {
  return catalog.cases.filter((definition) => definition.applicability.some((scope) => (
    scope.topologies.includes('replica_set')
    && scope.transports.includes('sockjs')
    && scope.observerOrders.some((order) => contractDigest(order) === contractDigest(observerOrder))
  ))).map(({ id }) => id);
}

function metricFromExecution({ catalog, profile, observerDriver, releaseIdentity, results, finalization, requiredCaseIds }: Readonly<{
  catalog: AuditCatalog;
  profile: AuditProfile;
  observerDriver: AuditObserverDriver;
  releaseIdentity: AuditReleaseIdentity;
  results: readonly AuditCaseOutcome[];
  finalization: AuditFinalization;
  requiredCaseIds: readonly string[];
}>): CollectorResult & Readonly<{ status: 'passed' | 'failed' | 'incomplete'; failure_reasons: readonly string[] }> {
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
export async function runAudit({ values, config, dependencies = {} }: Readonly<{
  values: CliValues;
  config: AuditConfig;
  dependencies?: AuditDependencies;
}>): Promise<BenchmarkResult> {
  const options = buildAuditRunValues(values);
  const startedAt = Date.now();
  const app = config.apps['tasks-3.x'];
  if (app === undefined) throw new Error('audit requires the tasks-3.x fixture');
  const repositoryRoot = path.resolve(app.path, '..', '..');
  const sourceResolver = dependencies.resolveMeteorSource ?? resolveMeteorSource;
  const source = sourceResolver({
    flags: values,
    env: process.env,
    config: {
      ...(config.meteorCheckoutPath === undefined ? {} : { meteorCheckoutPath: config.meteorCheckoutPath }),
      ...(config.meteorVersion === undefined ? {} : { meteorVersion: config.meteorVersion }),
    },
  });
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
  const executorInputs = {
    values: options,
    source,
    appPath: app.path,
    releaseIdentity,
    profileId: options.profile,
    catalog,
  };
  let executeCase: AuditExecutor;
  if (dependencies.createExecutor === undefined) {
    if (!isExecutorCatalog(catalog)) throw new TypeError('audit catalog is missing executor profiles');
    executeCase = createReleaseCaseExecutor({ ...executorInputs, catalog, values });
  } else {
    executeCase = dependencies.createExecutor(executorInputs);
  }
  const requiredCaseIds = applicableCaseIds(catalog, options.observerOrder);
  const results: AuditCaseOutcome[] = [];
  let finalization: AuditFinalization;
  try {
    for (const caseId of requiredCaseIds) {
      const definition = catalog.casesById.get(caseId);
      if (definition === undefined) throw new Error(`required declarative case ${caseId} is missing`);
      const faultStep = definition.steps.find((step) => step.kind === 'fault'
        && Reflect.get(step, 'operation') === 'activate');
      const faultId = faultStep === undefined ? undefined : Reflect.get(faultStep, 'faultId');
      const coordinate = {
        caseId,
        transport: 'sockjs',
        topology: 'replica_set',
        observerOrder: options.observerOrder,
        seed: options.seed,
        ...(typeof faultId === 'string' ? { faultId } : {}),
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
      finalization = normalizeFinalization(await executeCase.finalize());
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
    tag: typeof options.tag === 'string' ? options.tag : source.version,
    meteor: { version: source.version, sha: source.sha },
    runtime: { observer_driver: options.observerDriver, observer_driver_actual: options.observerDriver, transport: 'sockjs' },
    collectorResults: [metric],
    wallClockMs: Date.now() - startedAt,
  });
  const outputPath = typeof options.output === 'string'
    ? options.output : path.join(config.results.dir, `${scenario}-${result.tag}-${Date.now()}.json`);
  (dependencies.writeResult || writeResult)(result, outputPath);
  (dependencies.appendToHistory || appendToHistory)(result, config.results.history);
  console.log(`Audit result: ${outputPath}`);
  console.log(`Audit status: ${metric.status}`);
  if (metric.status !== 'passed') throw new Error(`Change-stream audit ${metric.status}: ${metric.failure_reasons.join(', ')}`);
  return result;
}

function normalizeFinalization(value: unknown): AuditFinalization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('audit finalization must be an object');
  }
  const recovery = Reflect.get(value, 'recovery');
  if (recovery === null) throw new TypeError('audit finalization recovery evidence is invalid');
  if (typeof recovery !== 'object' || Array.isArray(recovery)
    || typeof Reflect.get(recovery, 'runDocumentsRemoved') !== 'boolean'
    || typeof Reflect.get(recovery, 'topologyRestored') !== 'boolean'
    || typeof Reflect.get(recovery, 'profilerRestored') !== 'boolean'
    || typeof Reflect.get(recovery, 'networkRestored') !== 'boolean') {
    throw new TypeError('audit finalization recovery evidence is invalid');
  }
  const negativeControls = Reflect.get(value, 'negativeControls');
  if (negativeControls !== undefined && (!Array.isArray(negativeControls)
    || !negativeControls.every(isNegativeControlOutcome))) {
    throw new TypeError('audit finalization negative controls are invalid');
  }
  const normalizedRecovery: RecoveryOutcome = {
    ...Object.fromEntries(Object.entries(recovery)),
    runDocumentsRemoved: Reflect.get(recovery, 'runDocumentsRemoved'),
    topologyRestored: Reflect.get(recovery, 'topologyRestored'),
    profilerRestored: Reflect.get(recovery, 'profilerRestored'),
    networkRestored: Reflect.get(recovery, 'networkRestored'),
  };
  return negativeControls === undefined
    ? { recovery: normalizedRecovery }
    : { recovery: normalizedRecovery, negativeControls };
}

function isExecutorCatalog(catalog: AuditCatalog | ReturnType<typeof loadDeclarativeAuditCatalog>): catalog is ReturnType<typeof loadDeclarativeAuditCatalog> {
  return 'profilesById' in catalog && catalog.profilesById instanceof Map;
}

function isNegativeControlOutcome(value: unknown): value is NegativeControlOutcome {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof Reflect.get(value, 'controlId') === 'string'
    && typeof Reflect.get(value, 'expectedReason') === 'string'
    && typeof Reflect.get(value, 'actualReason') === 'string'
    && typeof Reflect.get(value, 'detected') === 'boolean';
}
