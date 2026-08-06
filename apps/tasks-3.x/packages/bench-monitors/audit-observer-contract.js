const AUDIT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_CURSOR_SCOPE_OPTION = '_auditObserverScope';

function identifier(value) {
  return typeof value === 'string' && AUDIT_IDENTIFIER.test(value) ? value : null;
}

/** Reads the closed, server-generated audit tag from a Meteor cursor description. */
export function extractAuditScope(cursorDescription) {
  const value = cursorDescription?.options?.[AUDIT_CURSOR_SCOPE_OPTION];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
    || !Number.isSafeInteger(cursorOrdinal) || cursorOrdinal < 0) return null;
  return Object.freeze({ runId, caseExecutionId, queryId, cursorOrdinal, cursorFingerprint });
}

/** Validates the authenticated read request for correlated observer evidence. */
export function validateAuditMonitorRequest(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
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
  return Object.freeze({ runId: value.runId, caseExecutionId });
}

/** Validates an ownership-attested request for one closed in-process fault primitive. */
export function validateAuditFaultRequest(value, expected, controllers) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('audit fault request must be an object');
  }
  const allowed = ['runId', 'caseExecutionId', 'ownershipToken', 'controller', 'operation', 'faultId'];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`unknown audit fault fields: ${unknown.sort().join(', ')}`);
  validateAuditMonitorRequest({
    runId: value.runId,
    caseExecutionId: value.caseExecutionId,
    ownershipToken: value.ownershipToken,
  }, expected);
  if (!controllers.includes(value.controller)) throw new TypeError('unknown audit fault controller');
  if (!['activate', 'status', 'restore'].includes(value.operation)) throw new TypeError('unknown audit fault operation');
  if (!identifier(value.faultId)) throw new TypeError('faultId must be a valid audit identifier');
  return Object.freeze({
    runId: value.runId,
    caseExecutionId: value.caseExecutionId,
    controller: value.controller,
    operation: value.operation,
    faultId: value.faultId,
  });
}
