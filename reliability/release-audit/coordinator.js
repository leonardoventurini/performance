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

const SAFE_RELEASE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;

function defaultRecoveryEvidence() {
  const recovery = {
    runDocumentsRemoved: false,
    topologyRestored: false,
    profilerRestored: false,
    networkRestored: false,
  };
  return { ...recovery, digest: contractDigest(recovery) };
}

function incompleteCase({ coordinate, release, mongo, attemptId, reason }) {
  return {
    schemaVersion: 2,
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

function unavailableMongoIdentity(topology) {
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
  repositoryRoot,
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
}) {
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
  const caseResults = [];

  const append = async ({ kind, state, payload, coordinate, attemptId }) => {
    sequence += 1;
    return journal.append(createProgressEvent({
      auditId,
      sequence,
      startedAt,
      now: now(),
      kind,
      state,
      payload,
      coordinate,
      attemptId,
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
      if (typeof executeCase.supports === 'function' && !executeCase.supports(coordinate)) {
        continue;
      }
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
      ]) {
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

    releaseExecution = advanceReleaseExecution(releaseExecution, 'aggregating');
    await append({
      kind: 'cleanup_verified',
      state: 'cleanup_verified',
      payload: {
        runDocumentsRemoved: recovery.runDocumentsRemoved,
        topologyRestored: recovery.topologyRestored,
        profilerRestored: recovery.profilerRestored,
        networkRestored: recovery.networkRestored,
      },
    });
    const provisional = aggregateReleaseAudit({
      release: releaseIdentity,
      topologyScope,
      transportScope,
      seed,
      caseResults,
      negativeControls,
      negativeControlContractDigest: NEGATIVE_CONTROL_CONTRACT_DIGEST,
      recovery,
      progress: {
        firstSequence: 1,
        lastSequence: sequence + 1,
        digest: '0'.repeat(64),
      },
    });
    await append({
      kind: 'audit_completed',
      state: provisional.status,
      payload: {
        status: provisional.status,
        passedCases: caseResults.filter(({ status }) => status === 'passed').length,
        failedCases: caseResults.filter(({ status }) => status === 'failed').length,
        incompleteCases: matrix.coordinates.length
          - caseResults.filter(({ status }) => status !== 'incomplete').length,
      },
    });
    const progressSeal = await journal.seal();
    const manifest = validateReleaseAuditManifest(aggregateReleaseAudit({
      release: releaseIdentity,
      topologyScope,
      transportScope,
      seed,
      caseResults,
      negativeControls,
      negativeControlContractDigest: NEGATIVE_CONTROL_CONTRACT_DIGEST,
      recovery,
      progress: {
        firstSequence: progressSeal.firstSequence,
        lastSequence: progressSeal.lastSequence,
        digest: progressSeal.digest,
      },
    }));
    releaseExecution = advanceReleaseExecution(releaseExecution, manifest.status);
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
