const MAX_AUDIT_ID_LENGTH = 128;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type QueryId = 'unordered' | 'selector_included' | 'selector_secondary_cohort'
  | 'projection_conformance' | 'multiple_projections' | 'ordered_sequence'
  | 'limit_one' | 'skip_one' | 'unsupported_json_schema' | 'change_stream_unavailable';
type Selector = Readonly<Record<string, unknown>>;
interface AuditCursorScope { runId: string; caseExecutionId: string | null; queryId: QueryId; cursorOrdinal: number; cursorFingerprint: string }
type QueryOptions = Readonly<Record<string, unknown>> & {
  readonly fields?: Readonly<Record<string, number>>;
  readonly _auditObserverScope?: Readonly<AuditCursorScope>;
};
type QueryScope = Readonly<Record<string, unknown>> & { readonly runId: string; readonly caseExecutionId?: string };
interface QueryPlan { readonly selector: Selector; readonly options: QueryOptions }
interface QueryBuilderInput { readonly scope: QueryScope }
type QueryBuilder = (input: QueryBuilderInput) => readonly QueryPlan[];
interface NormalizedRequest { readonly runId: string; readonly caseExecutionId: string | null; readonly queryId: QueryId; readonly legacy: boolean }

export const AUDIT_CURSOR_SCOPE_OPTION = '_auditObserverScope';

const QUERY_BUILDERS: Readonly<Record<QueryId, QueryBuilder>> = Object.freeze({
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

export const RELIABILITY_QUERY_IDS: readonly QueryId[] = Object.freeze([
  'unordered', 'selector_included', 'selector_secondary_cohort', 'projection_conformance',
  'multiple_projections', 'ordered_sequence', 'limit_one', 'skip_one',
  'unsupported_json_schema', 'change_stream_unavailable',
]);

function requireIdentifier(value: unknown, field: string): string {
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

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`unknown reliability query fields: ${unknownKeys.sort().join(', ')}`);
  }
}

function cursorFingerprint(queryId: string, cursorOrdinal: number, selector: Selector, options: QueryOptions): string {
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
export function normalizeReliabilityQueryRequest(request: unknown): Readonly<NormalizedRequest> {
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

  const objectRequest = request as Record<string, unknown>;
  rejectUnknownKeys(objectRequest, ['runId', 'caseExecutionId', 'queryId']);
  const queryId = requireIdentifier(objectRequest.queryId, 'queryId');
  if (!Object.hasOwn(QUERY_BUILDERS, queryId)) {
    throw new TypeError(`unknown reliability queryId: ${queryId}`);
  }

  return Object.freeze({
    runId: requireIdentifier(objectRequest.runId, 'runId'),
    caseExecutionId: requireIdentifier(objectRequest.caseExecutionId, 'caseExecutionId'),
    queryId: queryId as QueryId,
    legacy: false,
  });
}

/**
 * Resolves an allowlisted query identifier into server-owned cursor plans.
 * Audit scope is constructed here and cannot be weakened by the subscriber.
 */
export function buildReliabilityCursorPlans(request: unknown): readonly Readonly<QueryPlan>[] {
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
