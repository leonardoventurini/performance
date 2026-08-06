import {
  CAPABILITY_EXPECTATIONS,
  coordinateKey,
  validateAuditCaseResult,
  validateNegativeControlResult,
  validateProgressReference,
  validateRecoveryEvidence,
  validateReleaseAuditManifest,
  validateReleaseIdentity,
} from '../contracts/release-audit.js';
import { contractDigest } from '../contracts/digest.js';
import {
  NEGATIVE_CONTROL_CONTRACT_DIGEST,
  DECLARATIVE_AUDIT_CONTRACT_DIGEST,
  DECLARATIVE_AUDIT_INTERPRETER_VERSION,
  RELEASE_CAPABILITY_CONTRACT_DIGEST,
  RELEASE_CAPABILITY_CONTRACT_ID,
  RELEASE_CAPABILITY_REGISTRY,
  RELEASE_CAPABILITY_REVIEWED_AT,
  RELEASE_CASE_CONTRACTS,
  REQUIRED_NEGATIVE_CONTROLS,
} from './capability-registry.js';
import { resolveReleaseAuditMatrix } from './matrix.js';

function same(value, expected) {
  return contractDigest(value) === contractDigest(expected);
}

/** Applies the production release-identity gate before evidence is aggregated. */
export function releaseIdentityStatus(candidate, expected) {
  if (candidate === undefined || candidate === null) {
    return { status: 'incomplete', reasons: ['release_identity_missing'] };
  }
  let validated;
  try {
    validated = validateReleaseIdentity(candidate);
  } catch {
    return { status: 'incomplete', reasons: ['release_identity_invalid'] };
  }
  if (validated.harnessDirty) return { status: 'incomplete', reasons: ['harness_dirty'] };
  if (validated.requested !== validated.actual || (expected && !same(validated, expected))) {
    return { status: 'incomplete', reasons: ['release_identity_mismatch'] };
  }
  return { status: 'passed', reasons: [] };
}

/** Applies the production case-artifact gate and returns its exact rejection reason. */
export function caseEvidenceStatus(result, contract) {
  if (result.status === 'failed') return { status: 'failed', reasons: result.reasons };
  if (result.status === 'incomplete' || result.status === 'not_applicable') {
    return { status: 'incomplete', reasons: result.reasons };
  }
  if (result.release.harnessDirty) {
    return { status: 'incomplete', reasons: ['harness_dirty'] };
  }
  if (result.release.requested !== result.release.actual) {
    return { status: 'incomplete', reasons: ['release_identity_mismatch'] };
  }
  if (result.contractId !== RELEASE_CAPABILITY_CONTRACT_ID
    || result.contractDigest !== DECLARATIVE_AUDIT_CONTRACT_DIGEST
    || result.caseDefinitionDigest !== contract?.definitionDigest
    || result.interpreterVersion !== DECLARATIVE_AUDIT_INTERPRETER_VERSION) {
    return { status: 'incomplete', reasons: ['declarative_attestation_mismatch'] };
  }
  if (result.oracles.length === 0 || result.oracles.some(({ assertions }) => assertions === 0)) {
    return { status: 'incomplete', reasons: ['oracle_evidence_missing'] };
  }
  if (result.oracles.some(({ passed }) => !passed)) {
    return { status: 'incomplete', reasons: ['case_status_oracle_mismatch'] };
  }
  const producers = new Set(result.oracles.map(({ producer }) => producer));
  const missingProducer = contract?.requiredOracleProducers
    ?.find((producer) => !producers.has(producer));
  if (missingProducer) {
    return { status: 'incomplete', reasons: [`oracle_producer_missing:${missingProducer}`] };
  }
  if (contract?.requiresObserverEvidence) {
    if (result.observerEvidence.length === 0) {
      return {
        status: 'incomplete',
        reasons: [contract.expectation === 'fallback_required'
          ? 'fallback_evidence_missing'
          : 'observer_evidence_missing'],
      };
    }
    if (result.observerEvidence.some((evidence) => (
      !same(evidence.requestedOrder, result.coordinate.observerOrder)
      || (contract.expectation !== 'fallback_required'
        && evidence.actualDriver !== result.coordinate.observerOrder[0])
    ))) {
      return { status: 'failed', reasons: ['observer_identity_mismatch'] };
    }
  }
  if (contract?.requiresTransportIdentity
    && !result.oracles.some(({ family, producer }) => (
      family === 'transport_identity' && producer === 'meteor_probe'
    ))) {
    return { status: 'incomplete', reasons: ['transport_identity_missing'] };
  }
  if (result.coordinate.faultId) {
    if (!result.faultWitness
      || result.faultWitness.faultId !== result.coordinate.faultId) {
      return { status: 'incomplete', reasons: ['fault_witness_missing'] };
    }
    if (!result.faultWitness.restored) {
      return { status: 'incomplete', reasons: ['fault_restoration_unverified'] };
    }
    const faultOracle = result.oracles.find(({ producer }) => producer === 'fault_controller');
    const expectedFaultDigest = contractDigest({
      activationEvidenceDigest: result.faultWitness.activationEvidenceDigest,
      restorationEvidenceDigest: result.faultWitness.restorationEvidenceDigest,
    });
    if (!faultOracle || faultOracle.digest !== expectedFaultDigest) {
      return { status: 'incomplete', reasons: ['fault_witness_oracle_mismatch'] };
    }
  }
  if (contract?.expectation === 'fallback_required') {
    if (result.observerEvidence.length === 0) {
      return { status: 'incomplete', reasons: ['fallback_evidence_missing'] };
    }
    const expectedDriver = contract.expectedDriverByTopology?.[result.coordinate.topology]
      || contract.expectedDriver;
    if (!expectedDriver) {
      return { status: 'incomplete', reasons: ['fallback_contract_unresolved'] };
    }
    const exactFallback = result.observerEvidence.every((evidence) => (
      evidence.actualDriver === expectedDriver
      && same(evidence.requestedOrder, result.coordinate.observerOrder)
      && (contract.fallbackFrom === undefined || (
        evidence.fallbackFrom === contract.fallbackFrom
        && typeof evidence.fallbackReason === 'string'
      ))
    ));
    if (!exactFallback) {
      return { status: 'failed', reasons: ['fallback_driver_mismatch'] };
    }
    if (!producers.has('mongodb') || !producers.has('ddp_client')) {
      return { status: 'incomplete', reasons: ['fallback_content_oracle_missing'] };
    }
  }
  return { status: 'passed', reasons: [] };
}

/** Applies the production required-coordinate gate to all attempts for one coordinate. */
export function logicalCoordinateStatus(attempts, contract) {
  if (attempts.length === 0) {
    return { status: 'incomplete', reasons: ['required_coordinate_missing'] };
  }
  const evaluated = attempts.map((attempt) => caseEvidenceStatus(attempt, contract));
  const failed = evaluated.find(({ status }) => status === 'failed');
  if (failed) return failed;
  const incomplete = evaluated.find(({ status }) => status === 'incomplete');
  if (incomplete) return incomplete;
  return { status: 'passed', reasons: [] };
}

function negativeControlsComplete(results, suppliedDigest) {
  if (suppliedDigest !== NEGATIVE_CONTROL_CONTRACT_DIGEST) return false;
  const expectedById = new Map(REQUIRED_NEGATIVE_CONTROLS
    .map((control) => [control.controlId, control]));
  if (results.length !== expectedById.size) return false;
  const seen = new Set();
  for (const result of results) {
    if (seen.has(result.controlId)) return false;
    seen.add(result.controlId);
    const expected = expectedById.get(result.controlId);
    if (!expected
      || result.expectedReason !== expected.expectedReason
      || result.actualReason !== expected.expectedReason
      || !result.detected) {
      return false;
    }
  }
  return seen.size === expectedById.size;
}

/** Applies the production restoration gate and preserves an actionable reason. */
export function recoveryEvidenceStatus(recovery) {
  const evidence = {
    runDocumentsRemoved: recovery.runDocumentsRemoved,
    topologyRestored: recovery.topologyRestored,
    profilerRestored: recovery.profilerRestored,
    networkRestored: recovery.networkRestored,
  };
  const complete = recovery.digest === contractDigest(evidence)
    && recovery.runDocumentsRemoved
    && recovery.topologyRestored
    && recovery.profilerRestored
    && recovery.networkRestored;
  return complete
    ? { status: 'passed', reasons: [] }
    : { status: 'incomplete', reasons: ['recovery_incomplete'] };
}

/**
 * Aggregates immutable case attempts into the fail-closed release manifest.
 *
 * Behavioral failure is monotonic. Later passing attempts cannot erase a
 * failed or incomplete attempt for the same logical coordinate.
 */
export function aggregateReleaseAudit({
  release,
  topologyScope,
  transportScope,
  seed,
  caseResults,
  negativeControls,
  negativeControlContractDigest,
  recovery,
  progress,
  registry = RELEASE_CAPABILITY_REGISTRY,
  capabilityContractDigest = RELEASE_CAPABILITY_CONTRACT_DIGEST,
}) {
  const validatedRelease = validateReleaseIdentity(release);
  if (!Array.isArray(caseResults)) throw new TypeError('caseResults must be an array');
  if (!Array.isArray(negativeControls)) {
    throw new TypeError('negativeControls must be an array');
  }
  if (capabilityContractDigest !== RELEASE_CAPABILITY_CONTRACT_DIGEST) {
    throw new TypeError('capability contract digest mismatch');
  }
  const matrix = resolveReleaseAuditMatrix({ topologyScope, transportScope, seed, registry });
  const requiredCoordinateKeys = new Set(matrix.coordinates.map(coordinateKey));
  const attemptsByCoordinate = new Map();
  const seenAttempts = new Set();
  let identityIncomplete = validatedRelease.harnessDirty
    || validatedRelease.requested !== validatedRelease.actual;
  let unknownEvidence = false;
  let mongoVersion;
  let mongoFcv;

  const validatedCases = caseResults.map((result, index) => {
    const validated = validateAuditCaseResult(result, `caseResults[${index}]`);
    const coordinate = coordinateKey(validated.coordinate);
    const attemptKey = `${coordinate}|${validated.attemptId}`;
    if (seenAttempts.has(attemptKey)) {
      throw new TypeError(`duplicate coordinate and attemptId: ${attemptKey}`);
    }
    seenAttempts.add(attemptKey);
    if (!requiredCoordinateKeys.has(coordinate)) unknownEvidence = true;
    if (releaseIdentityStatus(validated.release, validatedRelease).status !== 'passed') {
      identityIncomplete = true;
    }
    if (validated.mongo.topology !== validated.coordinate.topology) identityIncomplete = true;
    mongoVersion ??= validated.mongo.serverVersion;
    mongoFcv ??= validated.mongo.featureCompatibilityVersion;
    if (validated.mongo.serverVersion !== mongoVersion
      || validated.mongo.featureCompatibilityVersion !== mongoFcv) {
      identityIncomplete = true;
    }
    const attempts = attemptsByCoordinate.get(coordinate) || [];
    attempts.push(validated);
    attemptsByCoordinate.set(coordinate, attempts);
    return validated;
  });

  const capabilityIds = new Set();
  const capabilities = registry.map((capability) => {
    if (capabilityIds.has(capability.id)) {
      throw new TypeError(`duplicate capability identifier ${capability.id}`);
    }
    capabilityIds.add(capability.id);
    if (!CAPABILITY_EXPECTATIONS.includes(capability.expectation)) {
      throw new TypeError(`unknown capability expectation ${capability.expectation}`);
    }
    if (capability.expectation === 'out_of_scope'
      || capability.expectation === 'not_supported') {
      return {
        id: capability.id,
        expectation: capability.expectation,
        status: capability.expectation,
        coordinates: [],
        reasons: [],
      };
    }
    const keys = matrix.requiredByCapability[capability.id];
    const outcomes = keys.map((key) => logicalCoordinateStatus(
      attemptsByCoordinate.get(key) || [],
      RELEASE_CASE_CONTRACTS[key.split('|')[0]],
    ));
    const coordinates = keys.map((key) => matrix.coordinates
      .find((coordinate) => coordinateKey(coordinate) === key));
    const failed = outcomes.find(({ status }) => status === 'failed');
    const incomplete = outcomes.find(({ status }) => status === 'incomplete');
    if (failed) {
      return {
        id: capability.id,
        expectation: capability.expectation,
        status: 'failed',
        coordinates,
        reasons: failed.reasons,
      };
    }
    if (incomplete) {
      return {
        id: capability.id,
        expectation: capability.expectation,
        status: 'incomplete',
        coordinates,
        reasons: incomplete.reasons,
      };
    }
    return {
      id: capability.id,
      expectation: capability.expectation,
      status: capability.expectation === 'fallback_required'
        ? 'verified_fallback'
        : 'passed',
      coordinates,
      reasons: [],
    };
  });

  const controls = negativeControls.map((control, index) => (
    validateNegativeControlResult(control, `negativeControls[${index}]`)
  ));
  const validatedRecovery = validateRecoveryEvidence(recovery);
  const validatedProgress = validateProgressReference(progress);
  const hasFailedCapability = capabilities.some(({ status }) => status === 'failed');
  const hasIncompleteCapability = capabilities.some(({ status }) => status === 'incomplete');
  const completionIncomplete = identityIncomplete
    || unknownEvidence
    || hasIncompleteCapability
    || !negativeControlsComplete(controls, negativeControlContractDigest)
    || recoveryEvidenceStatus(validatedRecovery).status !== 'passed';
  const status = hasFailedCapability
    ? 'non_conformant'
    : completionIncomplete ? 'incomplete' : 'conformant';

  return validateReleaseAuditManifest({
    schemaVersion: 1,
    contract: {
      id: RELEASE_CAPABILITY_CONTRACT_ID,
      digest: capabilityContractDigest,
      reviewedAt: RELEASE_CAPABILITY_REVIEWED_AT,
    },
    release: validatedRelease,
    topologyScope: [...topologyScope],
    transportScope: [...transportScope],
    status,
    capabilities,
    cases: validatedCases
      .filter(({ coordinate }) => requiredCoordinateKeys.has(coordinateKey(coordinate)))
      .map((result) => ({
        coordinate: result.coordinate,
        attemptId: result.attemptId,
        status: result.status,
        digest: contractDigest(result),
      }))
      .sort((left, right) => {
        const coordinateOrder = coordinateKey(left.coordinate)
          .localeCompare(coordinateKey(right.coordinate));
        return coordinateOrder || left.attemptId.localeCompare(right.attemptId);
      }),
    negativeControls: controls,
    negativeControlContractDigest,
    recovery: validatedRecovery,
    progress: validatedProgress,
  });
}
