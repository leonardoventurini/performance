const AUDIT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_CURSOR_SCOPE_OPTION = '_auditObserverScope';
const OBSERVER_DRIVERS = Object.freeze(['changeStreams', 'oplog', 'polling']);

type ObserverDriver = typeof OBSERVER_DRIVERS[number];
interface AuditExpected { runId: string; ownershipToken: string }
interface AuditSelectionAttempt { driver: ObserverDriver; available: boolean; reason?: string }
interface AuditSelection { configuredOrder: ObserverDriver[]; attempts: AuditSelectionAttempt[] }
type FaultOperation = 'activate' | 'status' | 'restore';

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && AUDIT_IDENTIFIER.test(value) ? value : null;
}

/** Reads the closed, server-generated audit tag from a Meteor cursor description. */
export function extractAuditScope(cursorDescription: unknown) {
  const description = objectValue(cursorDescription);
  const options = objectValue(description?.options);
  const value = objectValue(options?.[AUDIT_CURSOR_SCOPE_OPTION]);
  if (!value) return null;
  const expectedKeys = [
    'caseExecutionId', 'cursorFingerprint', 'cursorOrdinal', 'queryId', 'runId',
  ];
  if (Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')) return null;
  const runId = identifier(value.runId);
  const caseExecutionId = identifier(value.caseExecutionId);
  const queryId = identifier(value.queryId);
  const cursorFingerprint = identifier(value.cursorFingerprint);
  const cursorOrdinal = value.cursorOrdinal;
  if (!runId || !caseExecutionId || !queryId || !cursorFingerprint
    || typeof cursorOrdinal !== 'number' || !Number.isSafeInteger(cursorOrdinal) || cursorOrdinal < 0) return null;
  return Object.freeze({ runId, caseExecutionId, queryId, cursorOrdinal, cursorFingerprint });
}

/**
 * Returns fallback provenance only when Meteor's driver selection checks
 * independently observed why the preferred driver was rejected.
 */
export function deriveObservedFallback(selection: AuditSelection | null | undefined, actualDriver: string) {
  if (!selection || typeof selection !== 'object' || !OBSERVER_DRIVERS.includes(actualDriver)) return null;
  if (!Array.isArray(selection.configuredOrder) || !Array.isArray(selection.attempts)) return null;
  const fallbackFrom = selection.configuredOrder[0];
  if (!fallbackFrom || !OBSERVER_DRIVERS.includes(fallbackFrom) || fallbackFrom === actualDriver) return null;
  const rejected = selection.attempts.find(({ driver }) => driver === fallbackFrom);
  if (!rejected || rejected.available !== false || typeof rejected.reason !== 'string' || rejected.reason.length === 0) {
    return null;
  }
  return Object.freeze({ fallbackFrom, fallbackReason: rejected.reason.slice(0, 256) });
}

/** Validates the authenticated read request for correlated observer evidence. */
export function validateAuditMonitorRequest(input: unknown, expected: AuditExpected) {
  const value = objectValue(input);
  if (!value) {
    throw new TypeError('audit monitor request must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !['runId', 'caseExecutionId', 'ownershipToken'].includes(key));
  if (unknown.length > 0) throw new TypeError(`unknown audit monitor fields: ${unknown.sort().join(', ')}`);
  if (identifier(value.runId) !== expected.runId
    || typeof value.ownershipToken !== 'string'
    || value.ownershipToken !== expected.ownershipToken) {
    throw new Error('audit monitor ownership attestation failed');
  }
  const caseExecutionId = value.caseExecutionId === undefined
    ? null
    : identifier(value.caseExecutionId);
  if (value.caseExecutionId !== undefined && !caseExecutionId) {
    throw new TypeError('caseExecutionId must be a valid audit identifier');
  }
  return Object.freeze({ runId: expected.runId, caseExecutionId });
}

/** Validates an ownership-attested request for one closed in-process fault primitive. */
export function validateAuditFaultRequest(input: unknown, expected: AuditExpected, controllers: readonly string[]) {
  const value = objectValue(input);
  if (!value) {
    throw new TypeError('audit fault request must be an object');
  }
  const allowed = ['runId', 'caseExecutionId', 'ownershipToken', 'controller', 'operation', 'faultId'];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`unknown audit fault fields: ${unknown.sort().join(', ')}`);
  const monitor = validateAuditMonitorRequest({
    runId: value.runId,
    caseExecutionId: value.caseExecutionId,
    ownershipToken: value.ownershipToken,
  }, expected);
  if (!monitor.caseExecutionId) throw new TypeError('caseExecutionId is required for audit faults');
  if (typeof value.controller !== 'string' || !controllers.includes(value.controller)) throw new TypeError('unknown audit fault controller');
  if (typeof value.operation !== 'string' || !['activate', 'status', 'restore'].includes(value.operation)) throw new TypeError('unknown audit fault operation');
  const operation = value.operation as FaultOperation;
  const faultId = identifier(value.faultId);
  if (!faultId) throw new TypeError('faultId must be a valid audit identifier');
  return Object.freeze({
    runId: monitor.runId,
    caseExecutionId: monitor.caseExecutionId,
    controller: value.controller,
    operation,
    faultId,
  });
}

/** Validates a bounded ownership-attested EJSON transport echo. */
export function validateAuditEchoRequest(input: unknown, expected: AuditExpected, maximumBytes = 16_777_216) {
  const value = objectValue(input);
  if (!value) {
    throw new TypeError('audit echo request must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !['runId', 'ownershipToken', 'payload'].includes(key));
  if (unknown.length > 0) throw new TypeError(`unknown audit echo fields: ${unknown.sort().join(', ')}`);
  validateAuditMonitorRequest({ runId: value.runId, ownershipToken: value.ownershipToken }, expected);
  const byteLength = Buffer.byteLength(JSON.stringify(value.payload));
  if (byteLength > maximumBytes) throw new TypeError('audit echo payload exceeds the bounded byte ceiling');
  return Object.freeze({ payload: value.payload, byteLength });
}
