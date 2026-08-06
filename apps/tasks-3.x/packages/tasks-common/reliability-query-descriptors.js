const MAX_AUDIT_ID_LENGTH = 128;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const AUDIT_CURSOR_SCOPE_OPTION = '_auditObserverScope';

const QUERY_BUILDERS = Object.freeze({
  unordered: ({ scope }) => [{ selector: scope, options: {} }],
  selector_included: ({ scope }) => [{
    selector: { ...scope, included: true },
    options: {},
  }],
  selector_secondary_cohort: ({ scope }) => [{
    selector: { ...scope, cohort: 'secondary' },
    options: {},
  }],
  projection_conformance: ({ scope }) => [{
    selector: scope,
    options: { fields: { sequence: 1, revision: 1, projected: 1, nested: 1, objectId: 1 } },
  }],
  multiple_projections: ({ scope }) => [
    { selector: scope, options: { fields: { sequence: 1, projected: 1 } } },
    { selector: scope, options: { fields: { sequence: 1, nested: 1 } } },
  ],
  ordered_sequence: ({ scope }) => [{
    selector: scope,
    options: { sort: { sequence: 1 } },
  }],
  limit_one: ({ scope }) => [{
    selector: scope,
    options: { sort: { sequence: 1 }, limit: 1 },
  }],
  skip_one: ({ scope }) => [{
    selector: scope,
    options: { sort: { sequence: 1 }, skip: 1 },
  }],
  unsupported_json_schema: ({ scope }) => [{
    selector: { ...scope, $jsonSchema: { bsonType: 'object', required: ['runId', 'caseExecutionId'] } },
    options: {},
  }],
  change_stream_unavailable: ({ scope }) => [{ selector: scope, options: {} }],
});

export const RELIABILITY_QUERY_IDS = Object.freeze(Object.keys(QUERY_BUILDERS));

function requireIdentifier(value, field) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_AUDIT_ID_LENGTH
    || !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${field} must be a valid audit identifier of at most ${MAX_AUDIT_ID_LENGTH} characters`);
  }
  return value;
}

function rejectUnknownKeys(value, allowedKeys) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`unknown reliability query fields: ${unknownKeys.sort().join(', ')}`);
  }
}

function cursorFingerprint(queryId, cursorOrdinal, selector, options) {
  const input = JSON.stringify({ queryId, cursorOrdinal, selector, options });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cursor-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Validates a publication request and normalizes the legacy run-only form.
 * The object form is deliberately closed so callers cannot inject MongoDB
 * selectors, options, collection names, or database coordinates.
 */
export function normalizeReliabilityQueryRequest(request) {
  if (typeof request === 'string') {
    return Object.freeze({
      runId: requireIdentifier(request, 'runId'),
      caseExecutionId: null,
      queryId: 'unordered',
      legacy: true,
    });
  }

  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('reliability query must be a runId string or a descriptor object');
  }

  rejectUnknownKeys(request, ['runId', 'caseExecutionId', 'queryId']);
  const queryId = requireIdentifier(request.queryId, 'queryId');
  if (!Object.hasOwn(QUERY_BUILDERS, queryId)) {
    throw new TypeError(`unknown reliability queryId: ${queryId}`);
  }

  return Object.freeze({
    runId: requireIdentifier(request.runId, 'runId'),
    caseExecutionId: requireIdentifier(request.caseExecutionId, 'caseExecutionId'),
    queryId,
    legacy: false,
  });
}

/**
 * Resolves an allowlisted query identifier into server-owned cursor plans.
 * Audit scope is constructed here and cannot be weakened by the subscriber.
 */
export function buildReliabilityCursorPlans(request) {
  const normalized = normalizeReliabilityQueryRequest(request);
  const scope = normalized.legacy
    ? Object.freeze({ runId: normalized.runId })
    : Object.freeze({
      runId: normalized.runId,
      caseExecutionId: normalized.caseExecutionId,
    });
  const plans = QUERY_BUILDERS[normalized.queryId]({ scope });
  return Object.freeze(plans.map(({ selector, options }, cursorOrdinal) => {
    const taggedOptions = normalized.legacy ? options : {
      ...options,
      [AUDIT_CURSOR_SCOPE_OPTION]: Object.freeze({
        runId: normalized.runId,
        caseExecutionId: normalized.caseExecutionId,
        queryId: normalized.queryId,
        cursorOrdinal,
        cursorFingerprint: cursorFingerprint(normalized.queryId, cursorOrdinal, selector, options),
      }),
    };
    return Object.freeze({
      selector: Object.freeze(selector),
      options: Object.freeze(taggedOptions),
    });
  }));
}
