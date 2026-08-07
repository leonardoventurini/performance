import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateReleaseAuditManifest,
} from '../contracts/release-audit.js';
import { contractDigest } from '../contracts/digest.js';
import { aggregateReleaseAudit } from './aggregate.js';
import { writeAtomicJson } from './atomic-artifacts.js';
import { caseArtifactFileName } from './artifact-names.js';
import {
  NEGATIVE_CONTROL_CONTRACT_DIGEST,
  RELEASE_CAPABILITY_CONTRACT_ID,
} from './capability-registry.js';
import { resolveReleaseAuditMatrix } from './matrix.js';
import { ProgressJournal } from './progress-journal.js';
import { createProgressEvent, validateProgressEvent } from './progress-events.js';
import {
  advanceCaseExecution,
  advanceReleaseExecution,
  createCaseExecution,
  createReleaseExecution,
} from './state-machine.js';
import type { CaseCoordinate } from '../contracts/release-audit.js';
import type { ReleaseAuditManifest } from './aggregate.js';
import type { ReleaseExecutionState } from './state-machine.js';

type UnknownRecord = Record<string, unknown>;
interface ReleaseIdentity extends UnknownRecord { readonly actual: string; readonly harnessDirty: boolean }
interface RecoveryEvidence extends UnknownRecord { readonly runDocumentsRemoved: boolean; readonly topologyRestored: boolean; readonly profilerRestored: boolean; readonly networkRestored: boolean }
interface CaseResult extends UnknownRecord { readonly coordinate: CaseCoordinate; readonly attemptId: string; readonly status: 'passed' | 'failed' | 'incomplete'; readonly reasons: readonly string[] }
interface ExecutorFinalization { readonly recovery?: RecoveryEvidence; readonly negativeControls?: readonly UnknownRecord[] }
interface CaseExecutor {
  (input: { coordinate: CaseCoordinate; release: ReleaseIdentity; attemptId: string; artifactRoot: string }): Promise<CaseResult | null | undefined>;
  finalize?: () => Promise<ExecutorFinalization | null | undefined>;
}
interface CoordinateReleaseAuditOptions {
  readonly repositoryRoot: string;
  readonly resultsRoot: string;
  readonly release: string;
  readonly releaseIdentity: ReleaseIdentity;
  readonly topologyScope?: readonly string[];
  readonly transportScope?: readonly string[];
  readonly seed?: number;
  readonly executeCase: CaseExecutor;
  readonly negativeControls?: readonly UnknownRecord[];
  readonly recovery?: RecoveryEvidence;
  readonly now?: () => number;
}
export interface CoordinateReleaseAuditResult extends Record<string, unknown> {
  readonly auditId: string;
  readonly artifactRoot: string;
  readonly manifest: ReleaseAuditManifest;
  readonly releaseExecution: Readonly<{ state: ReleaseExecutionState; history: readonly ReleaseExecutionState[] }>;
  readonly progressSeal: Readonly<{ algorithm: 'sha256'; digest: string; byteLength: number; eventCount: number; firstSequence: number | null; lastSequence: number | null }>;
}

const SAFE_RELEASE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;

function defaultRecoveryEvidence(): RecoveryEvidence {
  const recovery = {
    runDocumentsRemoved: false,
    topologyRestored: false,
    profilerRestored: false,
    networkRestored: false,
  };
  return { ...recovery, digest: contractDigest(recovery) };
}

function incompleteCase({ coordinate, release, mongo, attemptId, reason }: { coordinate: CaseCoordinate; release: ReleaseIdentity; mongo: UnknownRecord; attemptId: string; reason: string }): CaseResult {
  return {
    schemaVersion: 3,
    coordinate,
    attemptId,
    status: 'incomplete',
    release,
    mongo,
    observerEvidence: [],
    oracles: [],
    diagnostics: {},
    reasons: [reason],
  };
}

function unavailableMongoIdentity(topology: string): UnknownRecord {
  return {
    serverVersion: 'unavailable',
    featureCompatibilityVersion: 'unavailable',
    topology,
    topologyName: 'unavailable',
    members: [],
  };
}

/** Executes one complete, fail-closed release-audit coordination attempt. */
export async function coordinateReleaseAudit({
  resultsRoot,
  release,
  releaseIdentity,
  topologyScope = ['replica_set'],
  transportScope = ['sockjs', 'uws'],
  seed = 42,
  executeCase,
  negativeControls = [],
  recovery = defaultRecoveryEvidence(),
  now = Date.now,
}: CoordinateReleaseAuditOptions): Promise<CoordinateReleaseAuditResult> {
  if (!SAFE_RELEASE.test(release)) {
    throw new TypeError('release must be an exact bounded release identifier');
  }
  if (typeof executeCase !== 'function') {
    throw new TypeError('coordinateReleaseAudit requires an executeCase adapter');
  }
  const auditId = `release-audit-${now()}-${crypto.randomUUID()}`;
  const artifactRoot = path.resolve(resultsRoot, release, auditId);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const startedAt = now();
  const matrix = resolveReleaseAuditMatrix({ topologyScope, transportScope, seed });
  const journal = await ProgressJournal.open({
    journalPath: path.join(artifactRoot, 'progress.ndjson'),
    validateEvent: (event) => validateProgressEvent(event, auditId),
  });
  let releaseExecution = createReleaseExecution();
  let sequence = journal.lastSequence || 0;
  const caseResults: CaseResult[] = [];
  let effectiveRecovery = recovery;
  let effectiveNegativeControls = negativeControls;
  let executorFinalized = false;

  const finalizeExecutor = async () => {
    if (executorFinalized) return;
    executorFinalized = true;
    if (typeof executeCase.finalize !== 'function') return;
    const finalization = await executeCase.finalize();
    if (finalization?.recovery) effectiveRecovery = finalization.recovery;
    if (finalization?.negativeControls) effectiveNegativeControls = finalization.negativeControls;
  };

  const append = async ({ kind, state, payload, coordinate, attemptId }: { kind: string; state: string; payload: UnknownRecord; coordinate?: CaseCoordinate; attemptId?: string }) => {
    sequence += 1;
    return journal.append(createProgressEvent({
      auditId,
      sequence,
      startedAt,
      now: now(),
      kind,
      state,
      payload,
      ...(coordinate === undefined ? {} : { coordinate }),
      ...(attemptId === undefined ? {} : { attemptId }),
    }));
  };

  try {
    await append({
      kind: 'audit_started',
      state: releaseExecution.state,
      payload: {
        contractId: RELEASE_CAPABILITY_CONTRACT_ID,
        requestedRelease: release,
        totalLogicalCases: matrix.coordinates.length,
      },
    });
    releaseExecution = advanceReleaseExecution(releaseExecution, 'identity_verified');
    await append({
      kind: 'identity_verified',
      state: releaseExecution.state,
      payload: {
        actualRelease: releaseIdentity.actual,
        harnessDirty: releaseIdentity.harnessDirty,
      },
    });
    releaseExecution = advanceReleaseExecution(releaseExecution, 'executing');

    for (const coordinate of matrix.coordinates) {
      const attemptId = crypto.randomUUID();
      let caseExecution = createCaseExecution();
      caseExecution = advanceCaseExecution(caseExecution, 'preflighted');
      await append({
        kind: 'case_started',
        state: caseExecution.state,
        coordinate,
        attemptId,
        payload: { caseId: coordinate.caseId },
      });
      let result;
      try {
        result = await executeCase({ coordinate, release: releaseIdentity, attemptId, artifactRoot });
      } catch (error) {
        result = incompleteCase({
          coordinate,
          release: releaseIdentity,
          mongo: unavailableMongoIdentity(coordinate.topology),
          attemptId,
          reason: 'case_executor_failed',
        });
      }
      if (!result) {
        result = incompleteCase({
          coordinate,
          release: releaseIdentity,
          mongo: unavailableMongoIdentity(coordinate.topology),
          attemptId,
          reason: 'case_executor_returned_no_evidence',
        });
      }
      caseResults.push(result);
      for (const nextState of [
        'environment_ready',
        'clients_ready',
        'workload_running',
        'converging',
        'evidence_sealed',
        'cleanup_verified',
        result.status,
      ] as const) {
        caseExecution = advanceCaseExecution(caseExecution, nextState);
      }
      await writeAtomicJson({
        artifactRoot,
        targetPath: path.join('cases', caseArtifactFileName(coordinate, attemptId)),
        value: result,
      });
      await append({
        kind: 'case_completed',
        state: caseExecution.state,
        coordinate,
        attemptId,
        payload: { status: result.status, reasonCount: result.reasons.length },
      });
    }

    await finalizeExecutor();

    releaseExecution = advanceReleaseExecution(releaseExecution, 'aggregating');
    await append({
      kind: 'cleanup_verified',
      state: 'cleanup_verified',
      payload: {
        runDocumentsRemoved: effectiveRecovery.runDocumentsRemoved,
        topologyRestored: effectiveRecovery.topologyRestored,
        profilerRestored: effectiveRecovery.profilerRestored,
        networkRestored: effectiveRecovery.networkRestored,
      },
    });
    const provisional = aggregateReleaseAudit({
      release: releaseIdentity,
      topologyScope,
      transportScope,
      seed,
      caseResults,
      negativeControls: effectiveNegativeControls,
      negativeControlContractDigest: NEGATIVE_CONTROL_CONTRACT_DIGEST,
      recovery: effectiveRecovery,
      progress: {
        firstSequence: 1,
        lastSequence: sequence + 1,
        digest: '0'.repeat(64),
      },
    });
    const provisionalStatus = provisional.status;
    if (typeof provisionalStatus !== 'string') throw new TypeError('provisional aggregate has no status');
    await append({
      kind: 'audit_completed',
      state: provisionalStatus,
      payload: {
        status: provisionalStatus,
        passedCases: caseResults.filter(({ status }) => status === 'passed').length,
        failedCases: caseResults.filter(({ status }) => status === 'failed').length,
        incompleteCases: matrix.coordinates.length
          - caseResults.filter(({ status }) => status !== 'incomplete').length,
      },
    });
    const progressSeal = await journal.seal();
    const manifest = aggregateReleaseAudit({
      release: releaseIdentity,
      topologyScope,
      transportScope,
      seed,
      caseResults,
      negativeControls: effectiveNegativeControls,
      negativeControlContractDigest: NEGATIVE_CONTROL_CONTRACT_DIGEST,
      recovery: effectiveRecovery,
      progress: {
        firstSequence: progressSeal.firstSequence,
        lastSequence: progressSeal.lastSequence,
        digest: progressSeal.digest,
      },
    });
    validateReleaseAuditManifest(manifest);
    const manifestStatus = manifest.status;
    if (manifestStatus !== 'conformant' && manifestStatus !== 'non_conformant' && manifestStatus !== 'incomplete') {
      throw new TypeError('release manifest has an invalid terminal status');
    }
    releaseExecution = advanceReleaseExecution(releaseExecution, manifestStatus);
    await writeAtomicJson({
      artifactRoot,
      targetPath: 'manifest.json',
      value: manifest,
    });
    return {
      auditId,
      artifactRoot,
      manifest,
      releaseExecution,
      progressSeal,
    };
  } catch (error) {
    await finalizeExecutor().catch(() => {});
    if (journal.lastSequence !== null) {
      await append({
        kind: 'audit_aborted',
        state: 'aborted',
        payload: { reasonCode: 'coordinator_failed' },
      }).catch(() => {});
    }
    await journal.close();
    throw error;
  }
}
