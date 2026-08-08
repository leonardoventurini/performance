const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REASON_COUNT = 32;
const MAX_REASON_LENGTH = 256;
const MAX_COLLECTION_LENGTH = 10_000;
const FORBIDDEN_IDENTITY_VALUES = new Set(['unknown', 'system', 'unavailable']);
const GIT_REVISION_PATTERN = /^[a-f0-9]{40,64}$/u;
const RELEASE_SOURCE_PATTERN = /^release:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?$/u;
const AUDIT_ORACLE_FAMILIES = Object.freeze([
  'snapshot_exact', 'event_present', 'event_absent', 'revision_monotonic',
  'field_absent', 'observer_identity', 'fallback_identity', 'transport_identity',
  'session_identity', 'fault_witness', 'cleanup_complete', 'release_identity',
  'required_coordinate',
]);

type UnknownRecord = Record<string, unknown>;
type EnumerationValue = string | number | boolean | null;

/** One validated release-audit coordinate. */
export interface CaseCoordinate {
  readonly caseId: string;
  readonly transport: typeof DDP_TRANSPORTS[number];
  readonly observerOrder: readonly (typeof OBSERVER_DRIVERS[number])[];
  readonly topology: typeof MONGO_TOPOLOGIES[number];
  readonly seed: number;
  readonly faultId?: string;
}

export const RELEASE_AUDIT_STATUSES = Object.freeze([
  'conformant',
  'non_conformant',
  'incomplete',
]);
export const AUDIT_CASE_STATUSES = Object.freeze([
  'passed',
  'failed',
  'incomplete',
  'not_applicable',
]);
export const CAPABILITY_STATUSES = Object.freeze([
  'passed',
  'failed',
  'incomplete',
  'verified_fallback',
  'not_supported',
  'out_of_scope',
]);
export const CAPABILITY_EXPECTATIONS = Object.freeze([
  'supported',
  'fallback_required',
  'not_supported',
  'out_of_scope',
]);
export const OBSERVER_DRIVERS = Object.freeze(['changeStreams', 'oplog', 'polling']);
export const DDP_TRANSPORTS = Object.freeze(['sockjs', 'sockjs-polling', 'uws']);
export const MONGO_TOPOLOGIES = Object.freeze([
  'replica_set',
  'sharded_cluster',
  'standalone',
]);
export const ORACLE_PRODUCERS = Object.freeze([
  'mongodb',
  'ddp_client',
  'meteor_probe',
  'fault_controller',
]);

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}

function object(value: unknown, path: string, allowedKeys: readonly string[], requiredKeys: readonly string[] = allowedKeys): asserts value is UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(`${path}.${key}`, 'is unknown');
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
}

function string(value: unknown, path: string, { max = MAX_REASON_LENGTH, pattern }: { max?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(path, `must be a non-empty string of at most ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function identifier(value: unknown, path: string): string {
  return string(value, path, { max: 128, pattern: IDENTIFIER_PATTERN });
}

function digest(value: unknown, path: string): string {
  return string(value, path, { max: 64, pattern: DIGEST_PATTERN });
}

function enumeration<const Value extends EnumerationValue>(value: unknown, path: string, values: readonly Value[]): Value {
  if (!values.includes(value as Value)) fail(path, `must be one of: ${values.join(', ')}`);
  return value as Value;
}

function boundedArray<T>(value: unknown, path: string, validate: (entry: unknown, path: string) => T, { max = MAX_COLLECTION_LENGTH }: { max?: number } = {}): T[] {
  if (!Array.isArray(value) || value.length > max) {
    fail(path, `must be an array with at most ${max} entries`);
  }
  return value.map((entry, index) => validate(entry, `${path}[${index}]`));
}

function finiteRecord(value: unknown, path: string): Record<string, number> {
  object(value, path, Object.keys(value || {}), []);
  const entries = Object.entries(value);
  if (entries.length > 128) fail(path, 'must contain at most 128 measurements');
  return Object.fromEntries(entries.map(([key, entry]) => {
    identifier(key, `${path}.${key}`);
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      fail(`${path}.${key}`, 'must be finite');
    }
    return [key, entry];
  }));
}

function stableReasons(value: unknown, path: string): string[] {
  return boundedArray(value, path, (reason, reasonPath) => (
    string(reason, reasonPath, { max: MAX_REASON_LENGTH })
  ), { max: MAX_REASON_COUNT });
}

/** Validates and normalizes the immutable release identity boundary. */
export function validateReleaseIdentity(value: unknown, path = 'release'): UnknownRecord {
  const keys = [
    'requested', 'actual', 'sourceRevision', 'fixtureRelease',
    'packageVersionsDigest', 'settingsDigest', 'harnessRevision',
    'harnessDirty', 'executionEnvironment',
  ];
  object(value, path, keys);
  const validatedStrings = new Map<string, string>();
  for (const key of ['requested', 'actual', 'sourceRevision', 'fixtureRelease',
    'harnessRevision', 'executionEnvironment']) {
    const validated = string(value[key], `${path}.${key}`, { max: 256 });
    validatedStrings.set(key, validated);
    if (FORBIDDEN_IDENTITY_VALUES.has(validated.toLowerCase())) {
      fail(`${path}.${key}`, 'must not be unknown or unavailable');
    }
  }
  const requested = validatedStrings.get('requested');
  const actual = validatedStrings.get('actual');
  const fixtureRelease = validatedStrings.get('fixtureRelease');
  const harnessRevision = validatedStrings.get('harnessRevision');
  const sourceRevision = validatedStrings.get('sourceRevision');
  if (requested === undefined || actual === undefined || fixtureRelease === undefined
      || harnessRevision === undefined || sourceRevision === undefined) fail(path, 'is missing validated identity fields');
  if (requested !== actual) {
    fail(`${path}.actual`, 'must exactly match the requested release');
  }
  if (fixtureRelease !== `METEOR@${requested}`) {
    fail(`${path}.fixtureRelease`, 'must exactly match the requested release');
  }
  if (!GIT_REVISION_PATTERN.test(harnessRevision)) {
    fail(`${path}.harnessRevision`, 'must be an exact Git revision');
  }
  if (!(GIT_REVISION_PATTERN.test(sourceRevision)
    || (RELEASE_SOURCE_PATTERN.test(sourceRevision) && sourceRevision === `release:${requested}`))) {
    fail(`${path}.sourceRevision`, 'must identify the exact requested source');
  }
  digest(value.packageVersionsDigest, `${path}.packageVersionsDigest`);
  digest(value.settingsDigest, `${path}.settingsDigest`);
  if (typeof value.harnessDirty !== 'boolean') fail(`${path}.harnessDirty`, 'must be boolean');
  return structuredClone(value);
}

/** Validates one exact release-audit case coordinate. */
export function validateCaseCoordinate(value: unknown, path = 'coordinate'): CaseCoordinate {
  object(value, path, ['caseId', 'transport', 'observerOrder', 'topology', 'seed', 'faultId'],
    ['caseId', 'transport', 'observerOrder', 'topology', 'seed']);
  const caseId = identifier(value.caseId, `${path}.caseId`);
  const transport = enumeration(value.transport, `${path}.transport`, DDP_TRANSPORTS);
  const observerOrder = boundedArray(value.observerOrder, `${path}.observerOrder`,
    (driver, driverPath) => enumeration(driver, driverPath, OBSERVER_DRIVERS), { max: 3 });
  if (observerOrder.length === 0 || new Set(observerOrder).size !== observerOrder.length) {
    fail(`${path}.observerOrder`, 'must contain one to three unique drivers');
  }
  const topology = enumeration(value.topology, `${path}.topology`, MONGO_TOPOLOGIES);
  if (!Number.isSafeInteger(value.seed) || typeof value.seed !== 'number' || value.seed < 0 || value.seed > 0xffffffff) {
    fail(`${path}.seed`, 'must be an unsigned 32-bit integer');
  }
  const faultId = value.faultId === undefined ? undefined : identifier(value.faultId, `${path}.faultId`);
  return faultId === undefined
    ? { caseId, transport, observerOrder, topology, seed: value.seed }
    : { caseId, transport, observerOrder, topology, seed: value.seed, faultId };
}

/** Validates one versioned capability declaration. */
export function validateCapabilityDefinition(value: unknown, path = 'capability'): UnknownRecord {
  object(value, path, [
    'id', 'expectation', 'requiredCases', 'applicability', 'source', 'rationale',
  ]);
  const capabilityId = identifier(value.id, `${path}.id`);
  const expectation = enumeration(value.expectation, `${path}.expectation`, CAPABILITY_EXPECTATIONS);
  const requiredCases = boundedArray(value.requiredCases, `${path}.requiredCases`,
    (caseId, casePath) => identifier(caseId, casePath), { max: 128 });
  if (new Set(requiredCases).size !== requiredCases.length) {
    fail(`${path}.requiredCases`, 'contains duplicate case identifiers');
  }
  const applicability = boundedArray(value.applicability, `${path}.applicability`, (entry, entryPath) => {
    object(entry, entryPath, ['topologies', 'transports', 'observerOrders']);
    const topologies = boundedArray(entry.topologies, `${entryPath}.topologies`,
      (topology, topologyPath) => enumeration(topology, topologyPath, MONGO_TOPOLOGIES),
      { max: MONGO_TOPOLOGIES.length });
    const transports = boundedArray(entry.transports, `${entryPath}.transports`,
      (transport, transportPath) => enumeration(transport, transportPath, DDP_TRANSPORTS),
      { max: DDP_TRANSPORTS.length });
    const observerOrders = boundedArray(entry.observerOrders, `${entryPath}.observerOrders`,
      (order, orderPath) => {
        if (transports.length === 0 || topologies.length === 0) {
          fail(entryPath, 'must not contain empty dimensions');
        }
        const transport = transports.at(0);
        const topology = topologies.at(0);
        if (transport === undefined || topology === undefined) fail(entryPath, 'must not contain empty dimensions');
        const coordinate = {
          caseId: capabilityId,
          transport,
          observerOrder: order,
          topology,
          seed: 0,
        };
        validateCaseCoordinate(coordinate, orderPath);
        return order;
      }, { max: 8 });
    return { topologies, transports, observerOrders };
  }, { max: 32 });
  string(value.source, `${path}.source`, { max: 512 });
  string(value.rationale, `${path}.rationale`, { max: 1_024 });
  if (['supported', 'fallback_required'].includes(expectation)
    && (requiredCases.length === 0 || applicability.length === 0)) {
    fail(path, 'must declare required cases and applicability');
  }
  return structuredClone(value);
}

/** Returns the stable identity of a logical case coordinate. */
export function coordinateKey(value: unknown): string {
  const coordinate = validateCaseCoordinate(value);
  return [
    coordinate.caseId,
    coordinate.transport,
    coordinate.observerOrder.join(','),
    coordinate.topology,
    coordinate.seed,
    coordinate.faultId || '',
  ].join('|');
}

function validateMongoIdentity(value: unknown, path: string, { allowUnavailable = false }: { allowUnavailable?: boolean } = {}): UnknownRecord {
  object(value, path, [
    'serverVersion', 'featureCompatibilityVersion', 'topology', 'topologyName', 'members',
  ]);
  const serverVersion = string(value.serverVersion, `${path}.serverVersion`, { max: 64 });
  const featureCompatibilityVersion = string(value.featureCompatibilityVersion, `${path}.featureCompatibilityVersion`, { max: 64 });
  enumeration(value.topology, `${path}.topology`, MONGO_TOPOLOGIES);
  const topologyName = string(value.topologyName, `${path}.topologyName`, { max: 128 });
  const unavailableIdentity = serverVersion === 'unavailable'
    && featureCompatibilityVersion === 'unavailable'
    && topologyName === 'unavailable'
    && Array.isArray(value.members)
    && value.members.length === 0;
  if (allowUnavailable && unavailableIdentity) return structuredClone(value);
  if (!VERSION_PATTERN.test(serverVersion)) {
    fail(`${path}.serverVersion`, 'must be an exact numeric version');
  }
  if (!VERSION_PATTERN.test(featureCompatibilityVersion)) {
    fail(`${path}.featureCompatibilityVersion`, 'must be an exact numeric version');
  }
  if (FORBIDDEN_IDENTITY_VALUES.has(topologyName.toLowerCase())) {
    fail(`${path}.topologyName`, 'must not be unavailable');
  }
  const members = boundedArray(value.members, `${path}.members`, (member, memberPath) => {
    object(member, memberPath, ['id', 'role']);
    identifier(member.id, `${memberPath}.id`);
    enumeration(member.role, `${memberPath}.role`,
      ['primary', 'secondary', 'arbiter', 'mongos', 'shard']);
    return structuredClone(member);
  }, { max: 128 });
  if (new Set(members.map(({ id }) => id)).size !== members.length) {
    fail(`${path}.members`, 'contains duplicate identifiers');
  }
  if (value.topology === 'replica_set'
    && (!members.some(({ role }) => role === 'primary') || members.length === 0)) {
    fail(`${path}.members`, 'must attest a replica-set primary');
  }
  return structuredClone(value);
}

function validateObserverEvidence(value: unknown, path: string): UnknownRecord {
  object(value, path, [
    'cursorId', 'requestedOrder', 'actualDriver', 'fallbackFrom', 'fallbackReason',
  ], ['cursorId', 'requestedOrder', 'actualDriver']);
  identifier(value.cursorId, `${path}.cursorId`);
  const requested = boundedArray(value.requestedOrder, `${path}.requestedOrder`,
    (driver, driverPath) => enumeration(driver, driverPath, OBSERVER_DRIVERS), { max: 3 });
  if (requested.length === 0 || new Set(requested).size !== requested.length) {
    fail(`${path}.requestedOrder`, 'must contain unique drivers');
  }
  enumeration(value.actualDriver, `${path}.actualDriver`, OBSERVER_DRIVERS);
  if (value.fallbackFrom !== undefined) {
    enumeration(value.fallbackFrom, `${path}.fallbackFrom`, OBSERVER_DRIVERS);
  }
  if (value.fallbackReason !== undefined) {
    string(value.fallbackReason, `${path}.fallbackReason`, { max: MAX_REASON_LENGTH });
  }
  return structuredClone(value);
}

function validateOracle(value: unknown, path: string): UnknownRecord {
  object(value, path, ['oracleId', 'family', 'producer', 'digest', 'assertions', 'passed', 'failures']);
  identifier(value.oracleId, `${path}.oracleId`);
  enumeration(value.family, `${path}.family`, AUDIT_ORACLE_FAMILIES);
  enumeration(value.producer, `${path}.producer`, ORACLE_PRODUCERS);
  digest(value.digest, `${path}.digest`);
  if (!Number.isSafeInteger(value.assertions) || typeof value.assertions !== 'number' || value.assertions < 0 || value.assertions > 1_000_000) {
    fail(`${path}.assertions`, 'must be a bounded non-negative safe integer');
  }
  if (typeof value.passed !== 'boolean') fail(`${path}.passed`, 'must be boolean');
  const failures = stableReasons(value.failures, `${path}.failures`);
  if (value.passed && failures.length > 0) {
    fail(`${path}.failures`, 'must be empty when passed is true');
  }
  return structuredClone(value);
}

function validateFaultWitness(value: unknown, path: string): UnknownRecord {
  object(value, path, [
    'faultId', 'kind', 'activationEvidenceDigest', 'restorationEvidenceDigest', 'restored',
  ]);
  identifier(value.faultId, `${path}.faultId`);
  identifier(value.kind, `${path}.kind`);
  digest(value.activationEvidenceDigest, `${path}.activationEvidenceDigest`);
  digest(value.restorationEvidenceDigest, `${path}.restorationEvidenceDigest`);
  if (typeof value.restored !== 'boolean') fail(`${path}.restored`, 'must be boolean');
  return structuredClone(value);
}

/** Validates a persisted case artifact and rejects all unknown fields. */
export function validateAuditCaseResult(value: unknown, path = 'caseResult'): UnknownRecord {
  const attestationKeys = [
    'contractId', 'contractDigest', 'caseDefinitionDigest', 'compiledPlanDigest',
    'interpreterVersion', 'resolvedParameters', 'stepLedgerDigest', 'evidenceLedgerDigests',
  ];
  object(value, path, [
    'schemaVersion', 'coordinate', 'attemptId', 'status', 'release', 'mongo',
    'observerEvidence', 'oracles', 'faultWitness', 'diagnostics', 'reasons',
    ...attestationKeys,
  ], [
    'schemaVersion', 'coordinate', 'attemptId', 'status', 'release', 'mongo',
    'observerEvidence', 'oracles', 'diagnostics', 'reasons',
  ]);
  if (typeof value.schemaVersion !== 'number' || ![2, 3].includes(value.schemaVersion)) fail(`${path}.schemaVersion`, 'must equal 2 or 3');
  if (value.schemaVersion === 3 && value.status !== 'incomplete') {
    for (const key of attestationKeys) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
  if (value.schemaVersion === 2 && attestationKeys.some((key) => Object.hasOwn(value, key))) {
    fail(path, 'schema version 2 cannot contain declarative attestations');
  }
  if (attestationKeys.some((key) => Object.hasOwn(value, key))) {
    for (const key of attestationKeys) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required when attestation evidence is present');
    }
    identifier(value.contractId, `${path}.contractId`);
    for (const key of ['contractDigest', 'caseDefinitionDigest', 'compiledPlanDigest', 'stepLedgerDigest']) {
      digest(value[key], `${path}.${key}`);
    }
    identifier(value.interpreterVersion, `${path}.interpreterVersion`);
    const resolvedParameters = value.resolvedParameters;
    if (!resolvedParameters || typeof resolvedParameters !== 'object' || Array.isArray(resolvedParameters)) {
      fail(`${path}.resolvedParameters`, 'must be an object');
    }
    object(resolvedParameters, `${path}.resolvedParameters`, Object.keys(resolvedParameters), []);
    object(value.evidenceLedgerDigests, `${path}.evidenceLedgerDigests`, ORACLE_PRODUCERS, []);
    if (Object.keys(value.evidenceLedgerDigests).length === 0) {
      fail(`${path}.evidenceLedgerDigests`, 'must not be empty');
    }
    for (const [producer, evidenceDigest] of Object.entries(value.evidenceLedgerDigests)) {
      enumeration(producer, `${path}.evidenceLedgerDigests.${producer}`, ORACLE_PRODUCERS);
      digest(evidenceDigest, `${path}.evidenceLedgerDigests.${producer}`);
    }
  }
  validateCaseCoordinate(value.coordinate, `${path}.coordinate`);
  identifier(value.attemptId, `${path}.attemptId`);
  enumeration(value.status, `${path}.status`, AUDIT_CASE_STATUSES);
  validateReleaseIdentity(value.release, `${path}.release`);
  validateMongoIdentity(value.mongo, `${path}.mongo`, {
    allowUnavailable: value.status === 'incomplete',
  });
  const observers = boundedArray(value.observerEvidence, `${path}.observerEvidence`,
    validateObserverEvidence, { max: 1_000 });
  if (new Set(observers.map(({ cursorId }) => cursorId)).size !== observers.length) {
    fail(`${path}.observerEvidence`, 'contains duplicate cursor identifiers');
  }
  const oracles = boundedArray(value.oracles, `${path}.oracles`, validateOracle, { max: 1_000 });
  if (new Set(oracles.map(({ oracleId }) => oracleId)).size !== oracles.length) {
    fail(`${path}.oracles`, 'contains duplicate oracle identifiers');
  }
  if (value.faultWitness !== undefined) {
    validateFaultWitness(value.faultWitness, `${path}.faultWitness`);
  }
  object(value.diagnostics, `${path}.diagnostics`,
    ['propagation', 'resources', 'volumes'], []);
  for (const key of ['propagation', 'resources', 'volumes']) {
    if (value.diagnostics[key] !== undefined) {
      finiteRecord(value.diagnostics[key], `${path}.diagnostics.${key}`);
    }
  }
  stableReasons(value.reasons, `${path}.reasons`);
  return structuredClone(value);
}

/** Validates cleanup evidence required before a release can conform. */
export function validateRecoveryEvidence(value: unknown, path = 'recovery'): UnknownRecord {
  object(value, path, [
    'runDocumentsRemoved', 'topologyRestored', 'profilerRestored', 'networkRestored', 'digest',
  ]);
  for (const key of [
    'runDocumentsRemoved', 'topologyRestored', 'profilerRestored', 'networkRestored',
  ]) {
    if (typeof value[key] !== 'boolean') fail(`${path}.${key}`, 'must be boolean');
  }
  digest(value.digest, `${path}.digest`);
  return structuredClone(value);
}

/** Validates one oracle-sensitivity result. */
export function validateNegativeControlResult(value: unknown, path = 'negativeControl'): UnknownRecord {
  object(value, path, [
    'controlId', 'expectedReason', 'actualReason', 'detected', 'evidenceDigest',
  ]);
  identifier(value.controlId, `${path}.controlId`);
  string(value.expectedReason, `${path}.expectedReason`, { max: MAX_REASON_LENGTH });
  string(value.actualReason, `${path}.actualReason`, { max: MAX_REASON_LENGTH });
  if (typeof value.detected !== 'boolean') fail(`${path}.detected`, 'must be boolean');
  digest(value.evidenceDigest, `${path}.evidenceDigest`);
  return structuredClone(value);
}

/** Validates the sealed progress-journal reference. */
export function validateProgressReference(value: unknown, path = 'progress'): UnknownRecord {
  object(value, path, ['firstSequence', 'lastSequence', 'digest']);
  const firstSequence = value.firstSequence;
  const lastSequence = value.lastSequence;
  if (!Number.isSafeInteger(firstSequence) || typeof firstSequence !== 'number' || firstSequence < 1) {
    fail(`${path}.firstSequence`, 'must be a positive safe integer');
  }
  if (!Number.isSafeInteger(lastSequence) || typeof lastSequence !== 'number' || lastSequence < 1) {
    fail(`${path}.lastSequence`, 'must be a positive safe integer');
  }
  if (lastSequence < firstSequence) {
    fail(`${path}.lastSequence`, 'must not precede firstSequence');
  }
  digest(value.digest, `${path}.digest`);
  return structuredClone(value);
}

/** Validates the immutable aggregate artifact at its persistence boundary. */
export function validateReleaseAuditManifest(value: unknown, path = 'manifest'): UnknownRecord {
  object(value, path, [
    'schemaVersion', 'contract', 'release', 'topologyScope', 'transportScope',
    'status', 'capabilities', 'cases', 'negativeControls',
    'negativeControlContractDigest', 'recovery', 'progress',
  ]);
  if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  object(value.contract, `${path}.contract`, ['id', 'digest', 'reviewedAt']);
  identifier(value.contract.id, `${path}.contract.id`);
  digest(value.contract.digest, `${path}.contract.digest`);
  string(value.contract.reviewedAt, `${path}.contract.reviewedAt`, { max: 32 });
  validateReleaseIdentity(value.release, `${path}.release`);
  boundedArray(value.topologyScope, `${path}.topologyScope`,
    (topology, topologyPath) => enumeration(topology, topologyPath, MONGO_TOPOLOGIES),
    { max: MONGO_TOPOLOGIES.length });
  boundedArray(value.transportScope, `${path}.transportScope`,
    (transport, transportPath) => enumeration(transport, transportPath, DDP_TRANSPORTS),
    { max: DDP_TRANSPORTS.length });
  enumeration(value.status, `${path}.status`, RELEASE_AUDIT_STATUSES);
  const capabilities = boundedArray(value.capabilities, `${path}.capabilities`,
    (capability, capabilityPath) => {
      object(capability, capabilityPath,
        ['id', 'expectation', 'status', 'coordinates', 'reasons']);
      identifier(capability.id, `${capabilityPath}.id`);
      enumeration(capability.expectation, `${capabilityPath}.expectation`,
        CAPABILITY_EXPECTATIONS);
      enumeration(capability.status, `${capabilityPath}.status`, CAPABILITY_STATUSES);
      boundedArray(capability.coordinates, `${capabilityPath}.coordinates`,
        validateCaseCoordinate);
      stableReasons(capability.reasons, `${capabilityPath}.reasons`);
      return structuredClone(capability);
    });
  if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length) {
    fail(`${path}.capabilities`, 'contains duplicate identifiers');
  }
  const cases = boundedArray(value.cases, `${path}.cases`, (reference, referencePath) => {
    object(reference, referencePath, ['coordinate', 'attemptId', 'status', 'digest']);
    validateCaseCoordinate(reference.coordinate, `${referencePath}.coordinate`);
    identifier(reference.attemptId, `${referencePath}.attemptId`);
    enumeration(reference.status, `${referencePath}.status`, AUDIT_CASE_STATUSES);
    digest(reference.digest, `${referencePath}.digest`);
    return structuredClone(reference);
  });
  const caseIdentities = cases.map((reference) => (
    `${coordinateKey(reference.coordinate)}|${reference.attemptId}`
  ));
  if (new Set(caseIdentities).size !== caseIdentities.length) {
    fail(`${path}.cases`, 'contains duplicate coordinate and attempt identities');
  }
  const controls = boundedArray(value.negativeControls, `${path}.negativeControls`,
    validateNegativeControlResult, { max: 128 });
  if (new Set(controls.map(({ controlId }) => controlId)).size !== controls.length) {
    fail(`${path}.negativeControls`, 'contains duplicate identifiers');
  }
  digest(value.negativeControlContractDigest, `${path}.negativeControlContractDigest`);
  validateRecoveryEvidence(value.recovery, `${path}.recovery`);
  validateProgressReference(value.progress, `${path}.progress`);
  return structuredClone(value);
}
