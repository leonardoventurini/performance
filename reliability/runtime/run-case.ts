import { MongoClient } from 'mongodb';

import { contractDigest } from '../contracts/digest.js';
import type {
  CompiledCasePlan,
  DeclarativeCaseDefinition,
  DeclarativeOracle,
  DeclarativeStep,
} from '../contracts/declarative-audit.js';
import { validateAuditCaseResult } from '../contracts/release-audit.js';
import { DECLARATIVE_AUDIT_INTERPRETER_VERSION } from '../declarative/compiler.js';
import { attestMongoIdentity } from '../release-audit/identity.js';
import { evaluateDeclarativeOracles } from '../oracles/evaluator.js';
import {
  buildDeclarativeFixture,
  createDatabaseAdapter,
} from './adapters/database.js';
import type { ReliabilityDocument } from './adapters/database.js';
import { createClientAdapter } from './adapters/clients.js';
import { createEvidenceAdapter } from './adapters/evidence.js';
import { createFaultAdapter } from './adapters/faults.js';
import { createBarrierAdapter, createWaitAdapter } from './adapters/waits.js';
import { DeclarativeCaseInterpreter } from './interpreter.js';
import type { DeclarativeExecution } from './interpreter.js';
import { createDeclarativePrimitiveRegistry } from './primitive-registry.js';

interface OracleEvaluation { readonly passed: boolean; readonly reason: string | null }
interface FaultArtifact {
  readonly faultId: string;
  readonly kind: string;
  readonly activationEvidenceDigest: string;
  readonly restorationEvidenceDigest: string;
  readonly restored: boolean;
}

/** Digests oracle evidence without confusing absent evidence with an observed null. */
export function oracleEvidenceDigest(
  result: OracleEvaluation,
  observed: unknown,
  planDigest: string,
): string {
  return contractDigest({
    result,
    observedPresent: observed !== undefined,
    ...(observed === undefined ? {} : { observed }),
    planDigest,
  });
}

/** Owned runtime resources required to execute one declarative audit case. */
export interface RuntimeEnvironment {
  readonly auditId: string;
  readonly ddpUrl: string;
  readonly proxy: Parameters<typeof createClientAdapter>[0]['proxy'];
  readonly cluster: Parameters<typeof createClientAdapter>[0]['cluster'] & Readonly<{ token: string }>;
  readonly replicaSet: Parameters<typeof createFaultAdapter>[0]['environment']['replicaSet'] & Readonly<{ uri: string }>;
}

interface CapturedExecution {
  readonly definition: DeclarativeCaseDefinition;
  readonly plan: CompiledCasePlan;
  readonly execution: DeclarativeExecution & Readonly<{ contextEvidence: Readonly<{ ddpLedgers: readonly unknown[] }> }>;
  readonly evaluation: unknown;
  readonly result: unknown;
}

function oracleArtifact(
  oracle: DeclarativeOracle,
  result: OracleEvaluation,
  execution: DeclarativeExecution,
  fault?: FaultArtifact,
) {
  return {
    oracleId: oracle.id,
    family: oracle.family,
    producer: oracle.producer,
    digest: oracle.family === 'fault_witness' && fault ? contractDigest({
      activationEvidenceDigest: fault.activationEvidenceDigest,
      restorationEvidenceDigest: fault.restorationEvidenceDigest,
    }) : oracleEvidenceDigest(
      result,
      execution.evidence.outputs[oracle.observed.stepId]?.[oracle.observed.ledger],
      execution.evidence.planDigest,
    ),
    assertions: 1,
    passed: result.passed,
    failures: result.passed ? [] : [result.reason],
  };
}

function observerArtifacts(plan: CompiledCasePlan, execution: DeclarativeExecution) {
  const observations = execution.evidence.outputs.subscribe?.observerEvidence || [];
  if (!Array.isArray(observations)) return [];
  return observations.flatMap((observation) => {
    if (!observation || typeof observation !== 'object') return [];
    const instanceId = Reflect.get(observation, 'instanceId');
    const cursorFingerprint = Reflect.get(observation, 'cursorFingerprint');
    const sequence = Reflect.get(observation, 'sequence');
    const actualDriver = Reflect.get(observation, 'actualDriver');
    if (typeof instanceId !== 'string' || typeof cursorFingerprint !== 'string'
        || !Number.isSafeInteger(sequence) || typeof actualDriver !== 'string') return [];
    const fallbackFrom = Reflect.get(observation, 'fallbackFrom');
    const fallbackReason = Reflect.get(observation, 'fallbackReason');
    return [{
    cursorId: `${instanceId}:${cursorFingerprint}:${String(sequence)}`,
    requestedOrder: plan.coordinate.observerOrder,
    actualDriver,
    ...(typeof fallbackFrom === 'string'
      && typeof fallbackReason === 'string'
      ? { fallbackFrom, fallbackReason }
      : {}),
    }];
  });
}

function faultArtifact(definition: DeclarativeCaseDefinition, execution: DeclarativeExecution): FaultArtifact | undefined {
  const restore = definition.steps.find((step): step is Extract<DeclarativeStep, { kind: 'fault' }> => (
    step.kind === 'fault' && step.operation === 'restore'
  ));
  const activate = definition.steps.find((step): step is Extract<DeclarativeStep, { kind: 'fault' }> => (
    step.kind === 'fault' && step.operation === 'activate'
  ));
  if (!restore || !activate) return undefined;
  const activation = execution.evidence.outputs[activate.id]?.fault_witness;
  const restoration = execution.evidence.outputs[restore.id]?.fault_witness;
  if (!activation || !restoration) return undefined;
  const restored = Reflect.get(restoration, 'restored');
  return {
    faultId: restore.faultId,
    kind: restore.controller,
    activationEvidenceDigest: contractDigest(activation),
    restorationEvidenceDigest: contractDigest(restoration),
    restored: restored === true,
  };
}

function evidenceLedgerDigests(execution: DeclarativeExecution): Readonly<Record<string, string>> {
  const entries = new Map<string, Array<Readonly<{ stepId: string; ledger: string; value: unknown }>>>();
  for (const [stepId, provenance] of Object.entries(execution.evidence.provenance)) {
    for (const [ledger, producer] of Object.entries(provenance)) {
      if (typeof producer !== 'string') continue;
      const values = entries.get(producer) || [];
      values.push({ stepId, ledger, value: execution.evidence.outputs[stepId]?.[ledger] });
      entries.set(producer, values);
    }
  }
  return Object.fromEntries([...entries].map(([producer, values]) => [producer, contractDigest(values)]));
}

/** Executes one compiled coordinate against a running owned environment. */
export async function runDeclarativeCase({
  environment, definition, plan, release, attemptId, mongoClientClass = MongoClient, captureExecution,
}: RunDeclarativeCaseOptions) {
  const mongoClient = new mongoClientClass(environment.replicaSet.uri, {
    serverSelectionTimeoutMS: plan.budget.stepTimeoutMs,
  });
  try {
    await mongoClient.connect();
    return await executeConnectedCase({
      environment, definition, plan, release, attemptId, mongoClient,
      ...(captureExecution ? { captureExecution } : {}),
    });
  } finally {
    await mongoClient.close();
  }
}

interface RunDeclarativeCaseOptions {
  environment: RuntimeEnvironment;
  definition: DeclarativeCaseDefinition;
  plan: CompiledCasePlan;
  release: unknown;
  attemptId: string;
  mongoClientClass?: typeof MongoClient;
  captureExecution?: (capture: CapturedExecution) => void;
}

async function executeConnectedCase({
  environment, definition, plan, release, attemptId, captureExecution, mongoClient,
}: Omit<RunDeclarativeCaseOptions, 'mongoClientClass'> & Readonly<{ mongoClient: MongoClient }>) {
  const runId = environment.auditId;
  const caseExecutionId = attemptId;
  const fixture = buildDeclarativeFixture({ definition, plan, runId, caseExecutionId });
  const databaseHandle = mongoClient.db('meteor');
  const collection = databaseHandle.collection<ReliabilityDocument>('reliabilityDocuments');
  const mongoIdentity = await attestMongoIdentity(databaseHandle);
  const database = createDatabaseAdapter({ collection, fixture });
  const clients = createClientAdapter({
    endpoint: environment.ddpUrl,
    proxy: environment.proxy,
    cluster: environment.cluster,
    runId,
    caseExecutionId,
    ownershipToken: environment.cluster.token,
    maximumLedgerEntries: plan.budget.maximumEvidenceEntries,
    transport: plan.coordinate.transport,
  });
  const faults = createFaultAdapter({
    environment, clients, runId, caseExecutionId, ownershipToken: environment.cluster.token,
  });
  const evidence = createEvidenceAdapter({
    collection, clients, database, proxy: environment.proxy, runId, caseExecutionId,
  });
  const waits = createWaitAdapter({ clients, database, faults });
  const cleanupDatabase = Object.freeze({
    write: database.write,
    async cleanup(invocation: Parameters<typeof database.cleanup>[0]) {
      await faults.restoreAll();
      await clients.close();
      return database.cleanup(invocation);
    },
  });
  const interpreter = new DeclarativeCaseInterpreter({
    registry: createDeclarativePrimitiveRegistry(),
    interpreterVersion: DECLARATIVE_AUDIT_INTERPRETER_VERSION,
  });
  const execution: DeclarativeExecution = await interpreter.execute({
    plan,
    definition,
    runId,
    fixture,
    context: {
      database: cleanupDatabase,
      clients,
      evidence,
      faults,
      waits,
      barriers: createBarrierAdapter(),
    },
  });
  const evaluationDefinition = {
    oracles: definition.oracles.map((oracle) => ({
      ...Object.fromEntries(Object.entries(oracle)),
      id: oracle.id,
      family: oracle.family,
      failureReason: oracle.failureReason,
      gate: oracle.gate,
      expected: {
        ...Object.fromEntries(Object.entries(oracle.expected)),
        kind: oracle.expected.kind,
      },
      observed: {
        ...Object.fromEntries(Object.entries(oracle.observed)),
        producer: oracle.observed.producer,
        stepId: oracle.observed.stepId,
        ledger: oracle.observed.ledger,
      },
    })),
  };
  const evaluationExecution = {
    status: execution.status,
    evidence: {
      coordinate: Object.fromEntries(Object.entries(execution.evidence.coordinate)),
      outputs: execution.evidence.outputs,
      provenance: Object.fromEntries(Object.entries(execution.evidence.provenance).map(([stepId, values]) => [
        stepId,
        Object.fromEntries(Object.entries(values).flatMap(([key, value]) => (
          typeof value === 'string' ? [[key, value]] : []
        ))),
      ])),
    },
  };
  const evaluation = evaluateDeclarativeOracles({
    definition: evaluationDefinition,
    execution: evaluationExecution,
  });
  const fault = faultArtifact(definition, execution);
  const oracleResults = definition.oracles.map((oracle, index) => (
    oracleArtifact(oracle, evaluation.results[index] ?? {
      passed: false,
      reason: 'oracle_evaluation_missing',
    }, execution, fault)
  ));
  const reasons = [
    ...(execution.failure ? [execution.failure.reason.slice(0, 256)] : []),
    ...evaluation.results.filter(({ passed }) => !passed).map(({ reason }) => reason),
  ].slice(0, 32);
  const result = validateAuditCaseResult({
    schemaVersion: 3,
    contractId: plan.contractId,
    contractDigest: plan.contractDigest,
    caseDefinitionDigest: plan.caseDefinitionDigest,
    compiledPlanDigest: plan.digest,
    interpreterVersion: execution.evidence.interpreterVersion,
    resolvedParameters: plan.resolvedParameters,
    stepLedgerDigest: contractDigest(execution.evidence.stepLedger),
    evidenceLedgerDigests: evidenceLedgerDigests(execution),
    coordinate: plan.coordinate,
    attemptId,
    status: evaluation.status,
    release,
    mongo: mongoIdentity,
    observerEvidence: observerArtifacts(plan, execution),
    oracles: oracleResults,
    ...(fault ? { faultWitness: fault } : {}),
    diagnostics: {},
    reasons,
  });
  captureExecution?.({
    definition,
    plan,
    execution: {
      ...execution,
      contextEvidence: { ddpLedgers: clients.ledgers() },
    },
    evaluation,
    result,
  });
  return result;
}
