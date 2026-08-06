const AUDIT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function identifier(value) {
  return typeof value === 'string' && AUDIT_IDENTIFIER.test(value) ? value : null;
}

/** Finds only harness-owned correlation fields in a bounded internal cursor description. */
export function extractAuditScope(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  const runId = identifier(value.runId);
  const caseExecutionId = identifier(value.caseExecutionId);
  if (runId && caseExecutionId) return Object.freeze({ runId, caseExecutionId });
  for (const child of Object.values(value)) {
    const found = extractAuditScope(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Validates the authenticated read request for correlated observer evidence. */
export function validateAuditMonitorRequest(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('audit monitor request must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !['runId', 'ownershipToken'].includes(key));
  if (unknown.length > 0) throw new TypeError(`unknown audit monitor fields: ${unknown.sort().join(', ')}`);
  if (identifier(value.runId) !== expected.runId
    || typeof value.ownershipToken !== 'string'
    || value.ownershipToken !== expected.ownershipToken) {
    throw new Error('audit monitor ownership attestation failed');
  }
  return Object.freeze({ runId: value.runId });
}
