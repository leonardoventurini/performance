const EVENT_KINDS = new Set([
  'audit_started',
  'identity_verified',
  'case_started',
  'case_state_changed',
  'case_completed',
  'cleanup_verified',
  'audit_completed',
  'audit_aborted',
]);
const EXECUTION_STATES = new Set([
  'planned',
  'identity_verified',
  'executing',
  'preflighted',
  'environment_ready',
  'clients_ready',
  'workload_running',
  'converging',
  'evidence_sealed',
  'cleanup_verified',
  'aggregating',
  'passed',
  'failed',
  'incomplete',
  'conformant',
  'non_conformant',
  'aborted',
]);
const GLOBAL_EVENT_KINDS = new Set([
  'audit_started',
  'identity_verified',
  'cleanup_verified',
  'audit_completed',
  'audit_aborted',
]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/u;
const MAX_EVENT_JSON_BYTES = 4 * 1024;

function exactObject(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${path}.${key} is unknown`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  }
}

function identifier(value, path) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new TypeError(`${path} must be a bounded identifier`);
  }
}

function boundedPayload(value) {
  exactObject(value, 'event.payload', Object.keys(value || {}), []);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024) {
    throw new RangeError('event.payload exceeds 2048 bytes');
  }
}

/** Validates a public, bounded progress event and binds it to one audit. */
export function validateProgressEvent(value, expectedAuditId) {
  exactObject(
    value,
    'event',
    [
      'auditId',
      'sequence',
      'timestamp',
      'elapsedMs',
      'kind',
      'state',
      'payload',
      'coordinate',
      'attemptId',
    ],
    ['auditId', 'sequence', 'timestamp', 'elapsedMs', 'kind', 'state', 'payload'],
  );
  identifier(value.auditId, 'event.auditId');
  if (expectedAuditId !== undefined && value.auditId !== expectedAuditId) {
    throw new TypeError('event.auditId does not match the journal audit');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new TypeError('event.sequence must be a positive safe integer');
  }
  if (!Number.isFinite(Date.parse(value.timestamp))) {
    throw new TypeError('event.timestamp must be an ISO timestamp');
  }
  if (!Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) {
    throw new TypeError('event.elapsedMs must be a non-negative safe integer');
  }
  if (!EVENT_KINDS.has(value.kind)) throw new TypeError('event.kind is unknown');
  if (!EXECUTION_STATES.has(value.state)) throw new TypeError('event.state is unknown');
  boundedPayload(value.payload);

  const isGlobal = GLOBAL_EVENT_KINDS.has(value.kind);
  if (isGlobal && (value.coordinate !== undefined || value.attemptId !== undefined)) {
    throw new TypeError('global progress events must not identify a case');
  }
  if (!isGlobal) {
    if (!value.coordinate || typeof value.coordinate !== 'object') {
      throw new TypeError('case progress events require a coordinate');
    }
    identifier(value.attemptId, 'event.attemptId');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_JSON_BYTES) {
    throw new RangeError('progress event exceeds 4096 bytes');
  }
  return structuredClone(value);
}

/** Creates one immutable journal event using measured state only. */
export function createProgressEvent({
  auditId,
  sequence,
  startedAt,
  kind,
  state,
  payload,
  coordinate,
  attemptId,
  now = Date.now(),
}) {
  return validateProgressEvent({
    auditId,
    sequence,
    timestamp: new Date(now).toISOString(),
    elapsedMs: Math.max(0, now - startedAt),
    kind,
    state,
    payload,
    ...(coordinate ? { coordinate } : {}),
    ...(attemptId ? { attemptId } : {}),
  }, auditId);
}
