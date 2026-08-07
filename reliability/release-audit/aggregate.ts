import {
  CAPABILITY_EXPECTATIONS,
  coordinateKey,
  validateCaseCoordinate,
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
import type { CaseCoordinate } from '../contracts/release-audit.js';
import type { Capability } from './capability-registry.js';

type UnknownRecord = Record<string, unknown>;
interface ReleaseIdentity extends UnknownRecord { readonly harnessDirty: boolean; readonly requested: string; readonly actual: string }
interface OracleEvidence extends UnknownRecord { readonly assertions: number; readonly passed: boolean; readonly producer: string; readonly family: string; readonly digest: string }
interface ObserverEvidence extends UnknownRecord { readonly requestedOrder: readonly string[]; readonly actualDriver: string; readonly fallbackFrom?: string; readonly fallbackReason?: string }
interface FaultWitness extends UnknownRecord { readonly faultId: string; readonly restored: boolean; readonly activationEvidenceDigest: string; readonly restorationEvidenceDigest: string }
interface MongoIdentity extends UnknownRecord { readonly topology: string; readonly serverVersion: string; readonly featureCompatibilityVersion: string }
interface AuditCaseResult extends UnknownRecord { readonly status: string; readonly reasons: readonly string[]; readonly release: ReleaseIdentity; readonly contractId?: string; readonly contractDigest?: string; readonly caseDefinitionDigest?: string; readonly interpreterVersion?: string; readonly oracles: readonly OracleEvidence[]; readonly observerEvidence: readonly ObserverEvidence[]; readonly coordinate: CaseCoordinate; readonly faultWitness?: FaultWitness; readonly attemptId: string; readonly mongo: MongoIdentity }
interface CaseContract extends UnknownRecord { readonly definitionDigest: string; readonly requiredOracleProducers: readonly string[]; readonly requiresObserverEvidence: boolean; readonly requiresTransportIdentity: boolean; readonly expectation: string; readonly expectedDriverByTopology?: Readonly<Record<string, string>>; readonly expectedDriver?: string; readonly fallbackFrom?: string }
interface NegativeControl extends UnknownRecord { readonly controlId: string; readonly expectedReason: string; readonly actualReason: string; readonly detected: boolean }
interface RecoveryEvidence extends UnknownRecord { readonly digest: string; readonly runDocumentsRemoved: boolean; readonly topologyRestored: boolean; readonly profilerRestored: boolean; readonly networkRestored: boolean }
interface StatusResult { readonly status: string; readonly reasons: readonly string[] }
export interface ReleaseManifestCapability extends UnknownRecord { readonly id: string; readonly status: string; readonly coordinates: readonly CaseCoordinate[]; readonly reasons: readonly string[] }
export interface ReleaseAuditManifest extends UnknownRecord { readonly status: string; readonly capabilities: readonly ReleaseManifestCapability[]; readonly cases: readonly UnknownRecord[] }

function isRecord(value: unknown): value is UnknownRecord { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function releaseIdentity(value: unknown): ReleaseIdentity {
  const result = validateReleaseIdentity(value);
  if (typeof result.harnessDirty !== 'boolean' || typeof result.requested !== 'string' || typeof result.actual !== 'string') throw new TypeError('validated release identity has invalid shape');
  return { ...result, harnessDirty: result.harnessDirty, requested: result.requested, actual: result.actual };
}
function caseResult(value: unknown, path: string): AuditCaseResult {
  const result = validateAuditCaseResult(value, path);
  if (typeof result.status !== 'string' || !Array.isArray(result.reasons) || !result.reasons.every((entry) => typeof entry === 'string')
    || !isRecord(result.release) || !isRecord(result.coordinate) || !isRecord(result.mongo)
    || typeof result.attemptId !== 'string' || !Array.isArray(result.oracles) || !Array.isArray(result.observerEvidence)) throw new TypeError(`${path} has invalid validated shape`);
  const release = releaseIdentity(result.release);
  const coordinate = validateCaseCoordinate(result.coordinate);
  const mongo = result.mongo;
  if (typeof mongo.topology !== 'string' || typeof mongo.serverVersion !== 'string' || typeof mongo.featureCompatibilityVersion !== 'string') throw new TypeError(`${path}.mongo has invalid shape`);
  const oracles = result.oracles.map((oracle, index) => {
    if (!isRecord(oracle) || typeof oracle.assertions !== 'number' || typeof oracle.passed !== 'boolean' || typeof oracle.producer !== 'string' || typeof oracle.family !== 'string' || typeof oracle.digest !== 'string') throw new TypeError(`${path}.oracles[${index}] has invalid shape`);
    return { ...oracle, assertions: oracle.assertions, passed: oracle.passed, producer: oracle.producer, family: oracle.family, digest: oracle.digest };
  });
  const observerEvidence = result.observerEvidence.map((evidence, index) => {
    if (!isRecord(evidence) || !Array.isArray(evidence.requestedOrder) || !evidence.requestedOrder.every((entry) => typeof entry === 'string') || typeof evidence.actualDriver !== 'string') throw new TypeError(`${path}.observerEvidence[${index}] has invalid shape`);
    return { ...evidence, requestedOrder: evidence.requestedOrder, actualDriver: evidence.actualDriver, ...(typeof evidence.fallbackFrom === 'string' ? { fallbackFrom: evidence.fallbackFrom } : {}), ...(typeof evidence.fallbackReason === 'string' ? { fallbackReason: evidence.fallbackReason } : {}) };
  });
  let faultWitness: FaultWitness | undefined;
  if (result.faultWitness !== undefined) {
    const witness = result.faultWitness;
    if (!isRecord(witness) || typeof witness.faultId !== 'string' || typeof witness.restored !== 'boolean' || typeof witness.activationEvidenceDigest !== 'string' || typeof witness.restorationEvidenceDigest !== 'string') throw new TypeError(`${path}.faultWitness has invalid shape`);
    faultWitness = { ...witness, faultId: witness.faultId, restored: witness.restored, activationEvidenceDigest: witness.activationEvidenceDigest, restorationEvidenceDigest: witness.restorationEvidenceDigest };
  }
  return { ...result, status: result.status, reasons: result.reasons, release, ...(typeof result.contractId === 'string' ? { contractId: result.contractId } : {}), ...(typeof result.contractDigest === 'string' ? { contractDigest: result.contractDigest } : {}), ...(typeof result.caseDefinitionDigest === 'string' ? { caseDefinitionDigest: result.caseDefinitionDigest } : {}), ...(typeof result.interpreterVersion === 'string' ? { interpreterVersion: result.interpreterVersion } : {}), oracles, observerEvidence, coordinate, ...(faultWitness === undefined ? {} : { faultWitness }), attemptId: result.attemptId, mongo: { ...mongo, topology: mongo.topology, serverVersion: mongo.serverVersion, featureCompatibilityVersion: mongo.featureCompatibilityVersion } };
}
function negativeControl(value: unknown, path: string): NegativeControl {
  const result = validateNegativeControlResult(value, path);
  if (typeof result.controlId !== 'string' || typeof result.expectedReason !== 'string' || typeof result.actualReason !== 'string' || typeof result.detected !== 'boolean') throw new TypeError(`${path} has invalid shape`);
  return { ...result, controlId: result.controlId, expectedReason: result.expectedReason, actualReason: result.actualReason, detected: result.detected };
}
function recoveryEvidence(value: unknown): RecoveryEvidence {
  const result = validateRecoveryEvidence(value);
  if (typeof result.digest !== 'string' || typeof result.runDocumentsRemoved !== 'boolean' || typeof result.topologyRestored !== 'boolean' || typeof result.profilerRestored !== 'boolean' || typeof result.networkRestored !== 'boolean') throw new TypeError('recovery has invalid shape');
  return { ...result, digest: result.digest, runDocumentsRemoved: result.runDocumentsRemoved, topologyRestored: result.topologyRestored, profilerRestored: result.profilerRestored, networkRestored: result.networkRestored };
}
function caseContract(value: unknown): CaseContract | undefined {
  if (!isRecord(value) || typeof value.definitionDigest !== 'string' || !Array.isArray(value.requiredOracleProducers)
    || !value.requiredOracleProducers.every((entry) => typeof entry === 'string') || typeof value.requiresObserverEvidence !== 'boolean'
    || typeof value.requiresTransportIdentity !== 'boolean' || typeof value.expectation !== 'string') return undefined;
  let expectedDriverByTopology: Record<string, string> | undefined;
  if (isRecord(value.expectedDriverByTopology)) {
    const entries = Object.entries(value.expectedDriverByTopology);
    if (entries.every(([, entry]) => typeof entry === 'string')) {
      expectedDriverByTopology = {};
      for (const [key, entry] of entries) {
        if (typeof entry === 'string') expectedDriverByTopology[key] = entry;
      }
    }
  }
  return { ...value, definitionDigest: value.definitionDigest, requiredOracleProducers: value.requiredOracleProducers, requiresObserverEvidence: value.requiresObserverEvidence, requiresTransportIdentity: value.requiresTransportIdentity, expectation: value.expectation, ...(expectedDriverByTopology === undefined ? {} : { expectedDriverByTopology }), ...(typeof value.expectedDriver === 'string' ? { expectedDriver: value.expectedDriver } : {}), ...(typeof value.fallbackFrom === 'string' ? { fallbackFrom: value.fallbackFrom } : {}) };
}
function releaseManifest(value: unknown): ReleaseAuditManifest {
  const result = validateReleaseAuditManifest(value);
  if (typeof result.status !== 'string' || !Array.isArray(result.capabilities) || !Array.isArray(result.cases)) throw new TypeError('validated manifest has invalid shape');
  const capabilities = result.capabilities.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.status !== 'string' || !Array.isArray(entry.coordinates)
      || !Array.isArray(entry.reasons) || !entry.reasons.every((reason) => typeof reason === 'string')) throw new TypeError(`manifest.capabilities[${index}] has invalid shape`);
    return { ...entry, id: entry.id, status: entry.status, coordinates: entry.coordinates.map((coordinate) => validateCaseCoordinate(coordinate)), reasons: entry.reasons };
  });
  const cases = result.cases.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`manifest.cases[${index}] has invalid shape`);
    return entry;
  });
  return { ...result, status: result.status, capabilities, cases };
}

function same(value: unknown, expected: unknown): boolean {
  return contractDigest(value) === contractDigest(expected);
}

/** Applies the production release-identity gate before evidence is aggregated. */
export function releaseIdentityStatus(candidate: unknown, expected?: unknown): StatusResult {
  if (candidate === undefined || candidate === null) {
    return { status: 'incomplete', reasons: ['release_identity_missing'] };
  }
  let validated;
  try {
    validated = releaseIdentity(candidate);
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
export function caseEvidenceStatus(result: AuditCaseResult, contract: CaseContract | undefined): StatusResult {
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
export function logicalCoordinateStatus(attempts: readonly AuditCaseResult[], contract: CaseContract | undefined): StatusResult {
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

function negativeControlsComplete(results: readonly NegativeControl[], suppliedDigest: string): boolean {
  if (suppliedDigest !== NEGATIVE_CONTROL_CONTRACT_DIGEST) return false;
  const expectedById = new Map(REQUIRED_NEGATIVE_CONTROLS
    .map((control) => [control.controlId, control]));
  if (results.length !== expectedById.size) return false;
  const seen = new Set<string>();
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
export function recoveryEvidenceStatus(recovery: RecoveryEvidence): StatusResult {
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
}: { release: unknown; topologyScope: readonly string[]; transportScope: readonly string[]; seed: number; caseResults: readonly unknown[]; negativeControls: readonly unknown[]; negativeControlContractDigest: string; recovery: unknown; progress: unknown; registry?: readonly Capability[]; capabilityContractDigest?: string }): ReleaseAuditManifest {
  const validatedRelease = releaseIdentity(release);
  if (!Array.isArray(caseResults)) throw new TypeError('caseResults must be an array');
  if (!Array.isArray(negativeControls)) {
    throw new TypeError('negativeControls must be an array');
  }
  if (capabilityContractDigest !== RELEASE_CAPABILITY_CONTRACT_DIGEST) {
    throw new TypeError('capability contract digest mismatch');
  }
  const matrix = resolveReleaseAuditMatrix({ topologyScope, transportScope, seed, registry });
  const requiredCoordinateKeys = new Set(matrix.coordinates.map(coordinateKey));
  const attemptsByCoordinate = new Map<string, AuditCaseResult[]>();
  const seenAttempts = new Set<string>();
  let identityIncomplete = validatedRelease.harnessDirty
    || validatedRelease.requested !== validatedRelease.actual;
  let unknownEvidence = false;
  let mongoVersion: string | undefined;
  let mongoFcv: string | undefined;

  const validatedCases = caseResults.map((result, index) => {
    const validated = caseResult(result, `caseResults[${index}]`);
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

  const capabilityIds = new Set<string>();
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
    if (keys === undefined) throw new TypeError(`capability ${capability.id} is absent from the resolved matrix`);
    const outcomes = keys.map((key) => logicalCoordinateStatus(
      attemptsByCoordinate.get(key) || [],
      caseContract(RELEASE_CASE_CONTRACTS[key.split('|')[0] ?? '']),
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
    negativeControl(control, `negativeControls[${index}]`)
  ));
  const validatedRecovery = recoveryEvidence(recovery);
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

  return releaseManifest({
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
