import { MongoClient } from 'mongodb';

import { contractDigest } from '../contracts/digest.js';
import { validateAuditCaseResult } from '../contracts/release-audit.js';
import { DECLARATIVE_AUDIT_INTERPRETER_VERSION } from '../declarative/compiler.js';
import { attestMongoIdentity } from '../release-audit/identity.js';
import { evaluateDeclarativeOracles } from '../oracles/evaluator.js';
import { buildDeclarativeFixture, createDatabaseAdapter } from './adapters/database.js';
import { createClientAdapter } from './adapters/clients.js';
import { createEvidenceAdapter } from './adapters/evidence.js';
import { createFaultAdapter } from './adapters/faults.js';
import { createBarrierAdapter, createWaitAdapter } from './adapters/waits.js';
import { DeclarativeCaseInterpreter } from './interpreter.js';
import { createDeclarativePrimitiveRegistry } from './primitive-registry.js';

function oracleArtifact(oracle, result, execution, fault) {
  return {
    oracleId: oracle.id,
    family: oracle.family,
    producer: oracle.producer,
    digest: oracle.family === 'fault_witness' && fault ? contractDigest({
      activationEvidenceDigest: fault.activationEvidenceDigest,
      restorationEvidenceDigest: fault.restorationEvidenceDigest,
    }) : contractDigest({
      result,
      observed: execution.evidence.outputs[oracle.observed.stepId]?.[oracle.observed.ledger],
      planDigest: execution.evidence.planDigest,
    }),
    assertions: 1,
    passed: result.passed,
    failures: result.passed ? [] : [result.reason],
  };
}

function observerArtifacts(definition, plan, execution) {
  const observations = execution.evidence.outputs.subscribe?.observerEvidence || [];
  return observations.map((observation) => ({
    cursorId: `${observation.instanceId}:${observation.cursorFingerprint}:${observation.sequence}`,
    requestedOrder: plan.coordinate.observerOrder,
    actualDriver: observation.actualDriver,
    ...(typeof observation.fallbackFrom === 'string'
      && typeof observation.fallbackReason === 'string'
      ? { fallbackFrom: observation.fallbackFrom, fallbackReason: observation.fallbackReason }
      : {}),
  }));
}

function faultArtifact(definition, execution) {
  const restore = definition.steps.find(({ kind, operation }) => kind === 'fault' && operation === 'restore');
  const activate = definition.steps.find(({ kind, operation }) => kind === 'fault' && operation === 'activate');
  if (!restore || !activate) return undefined;
  const activation = execution.evidence.outputs[activate.id]?.fault_witness;
  const restoration = execution.evidence.outputs[restore.id]?.fault_witness;
  if (!activation || !restoration) return undefined;
  return {
    faultId: restore.faultId,
    kind: restore.controller,
    activationEvidenceDigest: contractDigest(activation),
    restorationEvidenceDigest: contractDigest(restoration),
    restored: restoration.restored === true,
  };
}

function evidenceLedgerDigests(execution) {
  const entries = new Map();
  for (const [stepId, provenance] of Object.entries(execution.evidence.provenance)) {
    for (const [ledger, producer] of Object.entries(provenance)) {
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
}) {
  const runId = environment.auditId;
  const caseExecutionId = attemptId;
  const fixture = buildDeclarativeFixture({ definition, plan, runId, caseExecutionId });
  const mongoClient = new mongoClientClass(environment.replicaSet.uri, {
    serverSelectionTimeoutMS: plan.budget.stepTimeoutMs,
  });
  await mongoClient.connect();
  const databaseHandle = mongoClient.db('meteor');
  const collection = databaseHandle.collection('reliabilityDocuments');
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
    async cleanup(invocation) {
      await faults.restoreAll();
      await clients.close();
      return database.cleanup(invocation);
    },
  });
  const interpreter = new DeclarativeCaseInterpreter({
    registry: createDeclarativePrimitiveRegistry(),
    interpreterVersion: DECLARATIVE_AUDIT_INTERPRETER_VERSION,
  });
  let execution;
  try {
    execution = await interpreter.execute({
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
  } finally {
    await mongoClient.close();
  }
  const evaluation = evaluateDeclarativeOracles({ definition, execution });
  const fault = faultArtifact(definition, execution);
  const oracleResults = definition.oracles.map((oracle, index) => (
    oracleArtifact(oracle, evaluation.results[index], execution, fault)
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
    observerEvidence: observerArtifacts(definition, plan, execution),
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
