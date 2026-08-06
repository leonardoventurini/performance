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

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function object(value, path, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(`${path}.${key}`, 'is unknown');
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
  return value;
}

function string(value, path, { max = MAX_REASON_LENGTH, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(path, `must be a non-empty string of at most ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function identifier(value, path) {
  return string(value, path, { max: 128, pattern: IDENTIFIER_PATTERN });
}

function digest(value, path) {
  return string(value, path, { max: 64, pattern: DIGEST_PATTERN });
}

function enumeration(value, path, values) {
  if (!values.includes(value)) fail(path, `must be one of: ${values.join(', ')}`);
  return value;
}

function boundedArray(value, path, validate, { max = MAX_COLLECTION_LENGTH } = {}) {
  if (!Array.isArray(value) || value.length > max) {
    fail(path, `must be an array with at most ${max} entries`);
  }
  return value.map((entry, index) => validate(entry, `${path}[${index}]`));
}

function finiteRecord(value, path) {
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

function stableReasons(value, path) {
  return boundedArray(value, path, (reason, reasonPath) => (
    string(reason, reasonPath, { max: MAX_REASON_LENGTH })
  ), { max: MAX_REASON_COUNT });
}

/** Validates and normalizes the immutable release identity boundary. */
export function validateReleaseIdentity(value, path = 'release') {
  const keys = [
    'requested', 'actual', 'sourceRevision', 'fixtureRelease',
    'packageVersionsDigest', 'settingsDigest', 'harnessRevision',
    'harnessDirty', 'executionEnvironment',
  ];
  object(value, path, keys);
  for (const key of ['requested', 'actual', 'sourceRevision', 'fixtureRelease',
    'harnessRevision', 'executionEnvironment']) {
    string(value[key], `${path}.${key}`, { max: 256 });
    if (FORBIDDEN_IDENTITY_VALUES.has(value[key].toLowerCase())) {
      fail(`${path}.${key}`, 'must not be unknown or unavailable');
    }
  }
  if (value.requested !== value.actual) {
    fail(`${path}.actual`, 'must exactly match the requested release');
  }
  if (value.fixtureRelease !== `METEOR@${value.requested}`) {
    fail(`${path}.fixtureRelease`, 'must exactly match the requested release');
  }
  if (!GIT_REVISION_PATTERN.test(value.harnessRevision)) {
    fail(`${path}.harnessRevision`, 'must be an exact Git revision');
  }
  if (!(GIT_REVISION_PATTERN.test(value.sourceRevision)
    || value.sourceRevision === `release:${value.requested}`)) {
    fail(`${path}.sourceRevision`, 'must identify the exact requested source');
  }
  digest(value.packageVersionsDigest, `${path}.packageVersionsDigest`);
  digest(value.settingsDigest, `${path}.settingsDigest`);
  if (typeof value.harnessDirty !== 'boolean') fail(`${path}.harnessDirty`, 'must be boolean');
  return structuredClone(value);
}

/** Validates one exact release-audit case coordinate. */
export function validateCaseCoordinate(value, path = 'coordinate') {
  object(value, path, ['caseId', 'transport', 'observerOrder', 'topology', 'seed', 'faultId'],
    ['caseId', 'transport', 'observerOrder', 'topology', 'seed']);
  identifier(value.caseId, `${path}.caseId`);
  enumeration(value.transport, `${path}.transport`, DDP_TRANSPORTS);
  const observerOrder = boundedArray(value.observerOrder, `${path}.observerOrder`,
    (driver, driverPath) => enumeration(driver, driverPath, OBSERVER_DRIVERS), { max: 3 });
  if (observerOrder.length === 0 || new Set(observerOrder).size !== observerOrder.length) {
    fail(`${path}.observerOrder`, 'must contain one to three unique drivers');
  }
  enumeration(value.topology, `${path}.topology`, MONGO_TOPOLOGIES);
  if (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
    fail(`${path}.seed`, 'must be an unsigned 32-bit integer');
  }
  if (value.faultId !== undefined) identifier(value.faultId, `${path}.faultId`);
  return structuredClone(value);
}

/** Validates one versioned capability declaration. */
export function validateCapabilityDefinition(value, path = 'capability') {
  object(value, path, [
    'id', 'expectation', 'requiredCases', 'applicability', 'source', 'rationale',
  ]);
  identifier(value.id, `${path}.id`);
  enumeration(value.expectation, `${path}.expectation`, CAPABILITY_EXPECTATIONS);
  const requiredCases = boundedArray(value.requiredCases, `${path}.requiredCases`,
    (caseId, casePath) => identifier(caseId, casePath), { max: 128 });
  if (new Set(requiredCases).size !== requiredCases.length) {
    fail(`${path}.requiredCases`, 'contains duplicate case identifiers');
  }
  boundedArray(value.applicability, `${path}.applicability`, (entry, entryPath) => {
    object(entry, entryPath, ['topologies', 'transports', 'observerOrders']);
    boundedArray(entry.topologies, `${entryPath}.topologies`,
      (topology, topologyPath) => enumeration(topology, topologyPath, MONGO_TOPOLOGIES),
      { max: MONGO_TOPOLOGIES.length });
    boundedArray(entry.transports, `${entryPath}.transports`,
      (transport, transportPath) => enumeration(transport, transportPath, DDP_TRANSPORTS),
      { max: DDP_TRANSPORTS.length });
    boundedArray(entry.observerOrders, `${entryPath}.observerOrders`,
      (order, orderPath) => {
        const coordinate = {
          caseId: value.id,
          transport: entry.transports[0],
          observerOrder: order,
          topology: entry.topologies[0],
          seed: 0,
        };
        if (entry.transports.length === 0 || entry.topologies.length === 0) {
          fail(entryPath, 'must not contain empty dimensions');
        }
        validateCaseCoordinate(coordinate, orderPath);
        return [...order];
      }, { max: 8 });
    return structuredClone(entry);
  }, { max: 32 });
  string(value.source, `${path}.source`, { max: 512 });
  string(value.rationale, `${path}.rationale`, { max: 1_024 });
  if (['supported', 'fallback_required'].includes(value.expectation)
    && (value.requiredCases.length === 0 || value.applicability.length === 0)) {
    fail(path, 'must declare required cases and applicability');
  }
  return structuredClone(value);
}

/** Returns the stable identity of a logical case coordinate. */
export function coordinateKey(value) {
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

function validateMongoIdentity(value, path, { allowUnavailable = false } = {}) {
  object(value, path, [
    'serverVersion', 'featureCompatibilityVersion', 'topology', 'topologyName', 'members',
  ]);
  string(value.serverVersion, `${path}.serverVersion`, { max: 64 });
  string(value.featureCompatibilityVersion, `${path}.featureCompatibilityVersion`, { max: 64 });
  enumeration(value.topology, `${path}.topology`, MONGO_TOPOLOGIES);
  string(value.topologyName, `${path}.topologyName`, { max: 128 });
  const unavailableIdentity = value.serverVersion === 'unavailable'
    && value.featureCompatibilityVersion === 'unavailable'
    && value.topologyName === 'unavailable'
    && Array.isArray(value.members)
    && value.members.length === 0;
  if (allowUnavailable && unavailableIdentity) return structuredClone(value);
  if (!VERSION_PATTERN.test(value.serverVersion)) {
    fail(`${path}.serverVersion`, 'must be an exact numeric version');
  }
  if (!VERSION_PATTERN.test(value.featureCompatibilityVersion)) {
    fail(`${path}.featureCompatibilityVersion`, 'must be an exact numeric version');
  }
  if (FORBIDDEN_IDENTITY_VALUES.has(value.topologyName.toLowerCase())) {
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

function validateObserverEvidence(value, path) {
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

function validateOracle(value, path) {
  object(value, path, ['oracleId', 'family', 'producer', 'digest', 'assertions', 'passed', 'failures']);
  identifier(value.oracleId, `${path}.oracleId`);
  enumeration(value.family, `${path}.family`, AUDIT_ORACLE_FAMILIES);
  enumeration(value.producer, `${path}.producer`, ORACLE_PRODUCERS);
  digest(value.digest, `${path}.digest`);
  if (!Number.isSafeInteger(value.assertions) || value.assertions < 0 || value.assertions > 1_000_000) {
    fail(`${path}.assertions`, 'must be a bounded non-negative safe integer');
  }
  if (typeof value.passed !== 'boolean') fail(`${path}.passed`, 'must be boolean');
  stableReasons(value.failures, `${path}.failures`);
  if (value.passed && value.failures.length > 0) {
    fail(`${path}.failures`, 'must be empty when passed is true');
  }
  return structuredClone(value);
}

function validateFaultWitness(value, path) {
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
export function validateAuditCaseResult(value, path = 'caseResult') {
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
    ...(value.schemaVersion === 3 && value.status !== 'incomplete' ? attestationKeys : []),
  ]);
  if (![2, 3].includes(value.schemaVersion)) fail(`${path}.schemaVersion`, 'must equal 2 or 3');
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
    object(value.resolvedParameters, `${path}.resolvedParameters`, Object.keys(value.resolvedParameters), []);
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
export function validateRecoveryEvidence(value, path = 'recovery') {
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
export function validateNegativeControlResult(value, path = 'negativeControl') {
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
export function validateProgressReference(value, path = 'progress') {
  object(value, path, ['firstSequence', 'lastSequence', 'digest']);
  for (const key of ['firstSequence', 'lastSequence']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      fail(`${path}.${key}`, 'must be a positive safe integer');
    }
  }
  if (value.lastSequence < value.firstSequence) {
    fail(`${path}.lastSequence`, 'must not precede firstSequence');
  }
  digest(value.digest, `${path}.digest`);
  return structuredClone(value);
}

/** Validates the immutable aggregate artifact at its persistence boundary. */
export function validateReleaseAuditManifest(value, path = 'manifest') {
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
