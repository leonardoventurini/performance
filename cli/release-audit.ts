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
import type { BenchmarkConfig, CliValues, MeteorSource } from '../lib/benchmark-types.js';
import type { CaseCoordinate } from '../reliability/contracts/release-audit.js';
import type { DeclarativeCaseDefinition, CompiledCasePlan } from '../reliability/contracts/declarative-audit.js';
import type { CatalogEntry, CatalogNegativeControl } from '../reliability/declarative/catalog.js';

const DEFAULT_RELEASE = '3.5.1-beta.0';
const DEFAULT_SEED = 42;

type UnknownRecord = Record<string, unknown>;
interface RecoveryEvidence extends UnknownRecord {
  readonly runDocumentsRemoved: boolean;
  readonly topologyRestored: boolean;
  readonly profilerRestored: boolean;
  readonly networkRestored: boolean;
  readonly digest?: string;
}
interface EnvironmentStopResult { readonly restored?: boolean; readonly recovery?: RecoveryEvidence }
interface ReleaseEnvironment { stop(): Promise<EnvironmentStopResult> }
interface CaseOutcome extends UnknownRecord {
  readonly coordinate: CaseCoordinate;
  readonly attemptId: string;
  readonly status: 'passed' | 'failed' | 'incomplete';
  readonly reasons: readonly string[];
}
type RunCaseCapture = NonNullable<Parameters<typeof runDeclarativeCase>[0]['captureExecution']>;
type CapturedExecution = Parameters<RunCaseCapture>[0];
type NegativeControlRecord = Parameters<typeof runDeclarativeNegativeControls>[0]['records'][number];
interface ExecutorCatalog {
  readonly contract: CatalogEntry;
  readonly digest: string;
  readonly casesById: ReadonlyMap<string, CatalogEntry>;
  readonly profilesById: ReadonlyMap<string, CatalogEntry>;
  readonly negativeControls?: readonly CatalogNegativeControl[];
}
interface CaseRunInput {
  readonly environment: ReleaseEnvironment;
  readonly definition: CatalogEntry;
  readonly plan: CompiledCasePlan;
  readonly release: unknown;
  readonly attemptId: string;
  readonly captureExecution: (record: CapturedExecution) => void;
}
interface CaseExecutor {
  (input: Readonly<{ coordinate: CaseCoordinate; attemptId: string }>): Promise<CaseOutcome>;
  finalize(): Promise<Readonly<{
    recovery: RecoveryEvidence;
    negativeControls: readonly UnknownRecord[];
    caseOutcomes: readonly CaseOutcome[];
  }>>;
}

function parseSeed(value: CliValues[string]): number {
  const seed = value === undefined ? DEFAULT_SEED : Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('release-audit --seed must be an unsigned 32-bit integer');
  }
  return seed;
}

function transportEnvironment(
  transport: CaseCoordinate['transport'],
  observerOrder: CaseCoordinate['observerOrder'],
  extraEnvironment: Readonly<Record<string, string>>,
): Readonly<NodeJS.ProcessEnv> {
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
  environmentFactory = (options: ConstructorParameters<typeof OwnedAuditEnvironment>[0]) => new OwnedAuditEnvironment(options).start(),
  runCase = (input: CaseRunInput) => runProductionCase(input),
}: Readonly<{
  values: CliValues;
  source: MeteorSource;
  appPath: string;
  releaseIdentity: unknown;
  profileId?: string;
  catalog?: ExecutorCatalog;
  environmentFactory?: (options: ConstructorParameters<typeof OwnedAuditEnvironment>[0]) => Promise<ReleaseEnvironment>;
  runCase?: (input: CaseRunInput) => Promise<unknown>;
}>): CaseExecutor {
  const environments = new Map<string, ReleaseEnvironment>();
  const retiredRestorations: EnvironmentStopResult[] = [];
  const caseOutcomes: CaseOutcome[] = [];
  const executionRecords: NegativeControlRecord[] = [];
  const extraEnvironment = Object.fromEntries((Array.isArray(values.env) ? values.env : values.env ? [values.env] : [])
    .map((entry) => String(entry).split(/=(.*)/su).slice(0, 2))
    .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])));

  const environmentKey = (coordinate: CaseCoordinate): string => `${coordinate.transport}|${coordinate.observerOrder.join(',')}`;

  const environmentFor = async (coordinate: CaseCoordinate): Promise<ReleaseEnvironment> => {
    const key = environmentKey(coordinate);
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

  const retireEnvironment = async (coordinate: CaseCoordinate, environment: ReleaseEnvironment): Promise<void> => {
    const key = environmentKey(coordinate);
    if (environments.get(key) === environment) environments.delete(key);
    const restoration = await environment.stop();
    retiredRestorations.push(restoration);
    if (restoration?.restored !== true) {
      throw new Error('audit environment could not be restored after an executor failure');
    }
  };

  const executeCase = async ({ coordinate, attemptId }: Readonly<{ coordinate: CaseCoordinate; attemptId: string }>): Promise<CaseOutcome> => {
    const definition = catalog.casesById.get(coordinate.caseId);
    if (!definition) throw new Error(`required declarative case ${coordinate.caseId} is missing`);
    const plan = compileDeclarativeCase({
      catalog, caseId: coordinate.caseId, profileId, coordinate,
    });
    const environment = await environmentFor(coordinate);
    let rawResult: unknown;
    try {
      rawResult = await runCase({
        environment, definition, plan, release: releaseIdentity, attemptId,
        captureExecution: (record) => executionRecords.push(requireNegativeControlRecord(record)),
      });
    } catch (error) {
      try {
        await retireEnvironment(coordinate, environment);
      } catch (restorationError) {
        throw new AggregateError([error, restorationError], 'case execution and environment restoration failed');
      }
      throw error;
    }
    const result = normalizeCaseOutcome(rawResult, coordinate, attemptId);
    caseOutcomes.push(result);
    return result;
  };

  executeCase.finalize = async () => {
    const restorations: EnvironmentStopResult[] = [...retiredRestorations];
    for (const environment of environments.values()) restorations.push(await environment.stop());
    environments.clear();
    const recoveryPayload = {
      runDocumentsRemoved: restorations.length > 0
        && restorations.every((entry) => entry.recovery?.runDocumentsRemoved === true),
      topologyRestored: restorations.length > 0
        && restorations.every((entry) => entry.recovery?.topologyRestored === true),
      profilerRestored: restorations.length > 0
        && restorations.every((entry) => entry.recovery?.profilerRestored === true),
      networkRestored: restorations.length > 0
        && restorations.every((entry) => entry.recovery?.networkRestored === true),
    };
    const negativeControls = runDeclarativeNegativeControls({
      controls: catalog.negativeControls ?? [],
      records: executionRecords,
      recovery: recoveryPayload,
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
export async function runReleaseAudit({ values, config }: Readonly<{ values: CliValues; config: BenchmarkConfig }>) {
  const releaseName = values['meteor-version'] || values.release || DEFAULT_RELEASE;
  if (typeof releaseName !== 'string') throw new Error('release-audit requires an exact published Meteor release');
  const seed = parseSeed(values.seed);
  const app = config.apps['tasks-3.x'];
  if (app === undefined) throw new Error('release-audit requires the tasks-3.x fixture');
  const repositoryRoot = path.resolve(app.path, '..', '..');
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
    appPath: app.path,
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

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCaseOutcome(value: unknown, coordinate: CaseCoordinate, attemptId: string): CaseOutcome {
  if (!isRecord(value) || !['passed', 'failed', 'incomplete'].includes(String(value.status))) {
    throw new TypeError('case runner returned an invalid outcome');
  }
  const status = value.status;
  if (status !== 'passed' && status !== 'failed' && status !== 'incomplete') {
    throw new TypeError('case runner returned an invalid status');
  }
  const reasons = Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === 'string')
    ? value.reasons : [];
  return { ...value, coordinate, attemptId, status, reasons };
}

function requireCaseDefinition(value: CatalogEntry): DeclarativeCaseDefinition {
  if (!isCaseDefinition(value)) {
    throw new TypeError(`case ${value.id} is missing its validated runtime definition`);
  }
  return value;
}

function isCaseDefinition(value: CatalogEntry): value is CatalogEntry & DeclarativeCaseDefinition {
  return isRecord(value.fixture)
    && value.fixture.collection === 'reliabilityDocuments'
    && value.fixture.publication === 'reliability.documents'
    && typeof value.fixture.generator === 'string'
    && isRecord(value.fixture.subscribers)
    && isRecord(value.fixture.documents)
    && isRecord(value.fixture.payloadBytes)
    && Array.isArray(value.steps)
    && Array.isArray(value.oracles);
}

async function runProductionCase(input: CaseRunInput): Promise<unknown> {
  return runDeclarativeCase({
    ...input,
    environment: requireRuntimeEnvironment(input.environment),
    definition: requireCaseDefinition(input.definition),
  });
}

function requireRuntimeEnvironment(environment: ReleaseEnvironment): Parameters<typeof runDeclarativeCase>[0]['environment'] {
  if (!isRuntimeEnvironment(environment)) {
    throw new TypeError('owned audit environment is not fully started');
  }
  return environment;
}

type RuntimeEnvironment = Parameters<typeof runDeclarativeCase>[0]['environment'];
function isRuntimeEnvironment(environment: ReleaseEnvironment): environment is ReleaseEnvironment & RuntimeEnvironment {
  return isRecord(environment) && typeof environment.auditId === 'string'
    && typeof environment.ddpUrl === 'string' && isRecord(environment.proxy)
    && isRecord(environment.cluster) && typeof environment.cluster.token === 'string'
    && isRecord(environment.replicaSet) && typeof environment.replicaSet.uri === 'string';
}

function requireNegativeControlRecord(record: CapturedExecution): NegativeControlRecord {
  if (!isNegativeControlRecord(record)) {
    throw new TypeError('case runner capture is missing negative-control evidence');
  }
  return record;
}

function isNegativeControlRecord(record: CapturedExecution): record is CapturedExecution & NegativeControlRecord {
  return isRecord(record.definition) && typeof record.definition.id === 'string'
    && Array.isArray(record.definition.oracles) && isRecord(record.execution)
    && typeof record.execution.status === 'string' && isRecord(record.execution.evidence)
    && isRecord(record.execution.evidence.coordinate) && isRecord(record.execution.evidence.outputs)
    && isRecord(record.result) && typeof record.result.status === 'string'
    && Array.isArray(record.result.observerEvidence);
}
