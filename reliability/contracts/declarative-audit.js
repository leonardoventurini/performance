/** Closed runtime contracts for declarative change-stream audit definitions. */

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_NESTING = 12;
const MAX_EJSON_STRING = 1_048_576;
const GLOBAL_LIMITS = Object.freeze({
  maximumSteps: 256,
  maximumDocuments: 10_000,
  maximumSubscribers: 256,
  maximumPayloadBytes: 16_777_216,
  maximumEvidenceEntries: 100_000,
  stepTimeoutMs: 120_000,
  caseTimeoutMs: 900_000,
});

export const DECLARATIVE_AUDIT_PRODUCERS = Object.freeze([
  'expected_model', 'mongodb', 'ddp_client', 'meteor_probe', 'fault_controller',
]);
export const DECLARATIVE_AUDIT_ORACLE_FAMILIES = Object.freeze([
  'snapshot_exact', 'event_present', 'event_absent', 'revision_monotonic',
  'field_absent', 'observer_identity', 'fallback_identity', 'transport_identity',
  'session_identity', 'fault_witness', 'cleanup_complete', 'release_identity',
  'workload_process', 'required_coordinate',
]);
export const DECLARATIVE_AUDIT_GENERATORS = Object.freeze([
  'array_shapes-v1',
  'ascii_and_empty_strings-v1',
  'binary-v1',
  'compressible_payload-v1',
  'concurrent_distinct_fields-v1',
  'dates-v1',
  'ejson_scalars-v1',
  'emoji_surrogate_boundaries-v1',
  'field_removal_no_stale_residue-v1',
  'hot_key-v1',
  'identical_projected_state-v1',
  'near_bson_ceiling-v1',
  'object_ids-v1',
  'object_shapes-v1',
  'replacement-document-v1',
  'replacement_no_stale_residue-v1',
  'right_to_left_text-v1',
  'seeded_incompressible_payload-v1',
  'synthetic-document-v1',
  'unicode_composed_decomposed-v1',
]);
export const DECLARATIVE_AUDIT_CLIENT_ACTIONS = Object.freeze([
  'abrupt_disconnect',
  'await_publication_ready',
  'capture_frames',
  'clean_client_shutdown',
  'clean_server_shutdown',
  'concurrent_resume_storm',
  'connect',
  'deliver_events',
  'fanout',
  'fragment_frames',
  'fresh_after_grace',
  'fresh_non_sticky_instance',
  'reconnect_storm',
  'resume_after_hot_code_push',
  'resume_auth_context',
  'resume_inflight_method',
  'resume_queue_boundary',
  'resume_sticky_instance',
  'resume_subscription',
  'resume_within_grace',
  'round_trip_ejson',
  'send_payload_512_kib',
  'send_payload_near_ceiling',
  'slow_consumer',
  'stop_subscription',
  'verify_catchup_timeout_convergence',
  'verify_isolated_multiplexers',
  'verify_normal_read_your_writes',
  'verify_ready_snapshot',
  'verify_shared_multiplexer',
]);
export const DECLARATIVE_AUDIT_FAULT_CONTROLLERS = Object.freeze([
  'catchup_timeout',
  'change_stream_recoverable_error',
  'change_stream_repeated_restart',
  'change_stream_unexpected_close',
  'ddp_client_disconnect',
  'meteor_mongo_interruption',
  'mongodb_primary_step_down',
  'replica_set_election',
  'startup_snapshot_pause',
  'stream_restart',
  'watch_setup_pause',
  'writes_continue_during_recovery',
]);

function fail(path, message) { throw new TypeError(`${path} ${message}`); }
function record(value, path, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'is unknown');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  return value;
}
function text(value, path, max = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(path, `must be a non-empty string of at most ${max} characters`);
  return value;
}
function id(value, path) { text(value, path, 128); if (!ID.test(value)) fail(path, 'has an invalid identifier'); return value; }
function oneOf(value, path, choices) { if (!choices.includes(value)) fail(path, `must be one of: ${choices.join(', ')}`); return value; }
function integer(value, path, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} through ${max}`); return value; }
function list(value, path, validator, max = 256, nonempty = false) {
  if (!Array.isArray(value) || value.length > max || (nonempty && value.length === 0)) fail(path, `must be ${nonempty ? 'a non-empty' : 'an'} array with at most ${max} entries`);
  return value.map((entry, index) => validator(entry, `${path}[${index}]`));
}
function unique(values, path) { if (new Set(values).size !== values.length) fail(path, 'must contain unique entries'); return values; }
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) frozen(child);
  }
  return value;
}
function normalized(value) { return frozen(structuredClone(value)); }

function boundedEjson(value, path, depth = 0) {
  if (depth > MAX_NESTING) fail(path, `must not exceed ${MAX_NESTING} levels`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > MAX_EJSON_STRING) fail(path, 'string is too large'); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(path, 'must be finite'); return; }
  if (Array.isArray(value)) { if (value.length > 10_000) fail(path, 'array is too large'); value.forEach((v, i) => boundedEjson(v, `${path}[${i}]`, depth + 1)); return; }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(path, 'must be JSON-compatible data');
  const entries = Object.entries(value); if (entries.length > 1_000) fail(path, 'object is too large');
  for (const [key, child] of entries) { if (key.startsWith('$') || key.includes('.') || key === '__proto__') fail(`${path}.${key}`, 'has an unsafe key'); boundedEjson(child, `${path}.${key}`, depth + 1); }
}

/** @typedef {{kind:'literal',value:unknown}|{kind:'parameter',name:string}|{kind:'coordinate',field:'seed'|'transport'|'topology'|'observerOrder'}|{kind:'run',field:'runId'}|{kind:'fixture',field:'documents'|'subscriberIds'}|{kind:'step',stepId:string,output:string}} ValueRef */
/** Validates a closed, non-interpolating declarative value reference. */
export function validateValueRef(value, path = 'valueRef') {
  record(value, path, ['kind', 'value', 'name', 'field', 'stepId', 'output'], ['kind']);
  switch (value.kind) {
    case 'literal': record(value, path, ['kind', 'value']); boundedEjson(value.value, `${path}.value`); break;
    case 'parameter': record(value, path, ['kind', 'name']); id(value.name, `${path}.name`); break;
    case 'coordinate': record(value, path, ['kind', 'field']); oneOf(value.field, `${path}.field`, ['seed', 'transport', 'topology', 'observerOrder']); break;
    case 'run': record(value, path, ['kind', 'field']); oneOf(value.field, `${path}.field`, ['runId']); break;
    case 'fixture': record(value, path, ['kind', 'field']); oneOf(value.field, `${path}.field`, ['documents', 'subscriberIds']); break;
    case 'step': record(value, path, ['kind', 'stepId', 'output']); id(value.stepId, `${path}.stepId`); id(value.output, `${path}.output`); break;
    default: fail(`${path}.kind`, 'is unknown');
  }
  return normalized(value);
}

function literalOrValueRef(value, path) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'kind')) {
    validateValueRef(value, path);
  } else {
    boundedEjson(value, path);
  }
}

function selector(value, path) {
  record(value, path, ['kind', 'index', 'field', 'value'], ['kind']);
  if (value.kind === 'fixture_document') { record(value, path, ['kind', 'index']); integer(value.index, `${path}.index`, 0, GLOBAL_LIMITS.maximumDocuments - 1); return; }
  if (value.kind === 'field_equals') { record(value, path, ['kind', 'field', 'value']); id(value.field, `${path}.field`); if (['runId', '_id'].includes(value.field)) fail(`${path}.field`, 'is interpreter-owned'); validateValueRef(value.value, `${path}.value`); return; }
  fail(`${path}.kind`, 'is not an allowlisted selector');
}
function mutation(value, path) {
  if (value?.kind && ['literal', 'parameter', 'coordinate', 'run', 'fixture', 'step'].includes(value.kind)) { validateValueRef(value, path); return; }
  record(value, path, ['kind', 'path', 'value', 'amount', 'index', 'generator', 'variant'], ['kind']);
  oneOf(value.kind, `${path}.kind`, ['set', 'unset', 'increment', 'push', 'fixture_document', 'generated_document', 'projection_variant', 'none']);
  if (value.kind === 'fixture_document') { record(value, path, ['kind', 'index']); integer(value.index, `${path}.index`, 0, GLOBAL_LIMITS.maximumDocuments - 1); return; }
  if (value.kind === 'generated_document') { record(value, path, ['kind', 'generator']); oneOf(value.generator, `${path}.generator`, DECLARATIVE_AUDIT_GENERATORS); return; }
  if (value.kind === 'projection_variant') { record(value, path, ['kind', 'variant']); id(value.variant, `${path}.variant`); return; }
  if (value.kind === 'none') { record(value, path, ['kind']); return; }
  const scalarField = value.kind === 'increment' ? 'amount' : 'value';
  record(value, path, ['kind', 'path', scalarField], value.kind === 'unset' ? ['kind', 'path'] : ['kind', 'path', scalarField]);
  const parts = list(value.path, `${path}.path`, (part, partPath) => id(part, partPath), 16, true);
  if (parts.some((part) => part === 'runId' || part === '_id')) fail(`${path}.path`, 'targets an interpreter-owned field');
  if (value.kind !== 'unset') literalOrValueRef(value[scalarField], `${path}.${scalarField}`);
}
function transition(value, path) {
  record(value, path, ['kind', 'path', 'value', 'amount', 'variant'], ['kind']);
  oneOf(value.kind, `${path}.kind`, ['insert', 'replace', 'delete', 'set_field', 'remove_field', 'increment_field', 'append_array', 'projection_variant']);
  if (['set_field', 'remove_field', 'increment_field', 'append_array'].includes(value.kind)) list(value.path, `${path}.path`, (part, p) => id(part, p), 16, true);
  if (['set_field', 'append_array'].includes(value.kind)) literalOrValueRef(value.value, `${path}.value`);
  if (value.kind === 'increment_field') literalOrValueRef(value.amount, `${path}.amount`);
  if (value.kind === 'projection_variant') id(value.variant, `${path}.variant`);
}
function refRecord(value, path) {
  record(value, path, ['producer', 'stepId', 'ledger']);
  oneOf(value.producer, `${path}.producer`, DECLARATIVE_AUDIT_PRODUCERS.filter((p) => p !== 'expected_model'));
  id(value.stepId, `${path}.stepId`); id(value.ledger, `${path}.ledger`);
}

const STEP_KINDS = ['subscribe', 'mongo_write', 'wait', 'barrier', 'client_lifecycle', 'fault', 'snapshot', 'seal_evidence'];
function query(value, path) {
  record(value, path, ['kind', 'selector', 'sort', 'skip', 'limit', 'fields', 'projections', 'operator'], ['kind']);
  oneOf(value.kind, `${path}.kind`, ['unordered', 'ordered', 'windowed', 'selector', 'projection', 'multiple_projections', 'unsupported_selector']);
  if (value.selector !== undefined) selector(value.selector, `${path}.selector`);
  if (value.sort !== undefined) list(value.sort, `${path}.sort`, (entry, entryPath) => { record(entry, entryPath, ['field', 'direction']); id(entry.field, `${entryPath}.field`); oneOf(entry.direction, `${entryPath}.direction`, ['ascending', 'descending']); return entry; }, 8, true);
  if (value.skip !== undefined) literalOrValueRef(value.skip, `${path}.skip`);
  if (value.limit !== undefined) literalOrValueRef(value.limit, `${path}.limit`);
  if (value.fields !== undefined) list(value.fields, `${path}.fields`, (field, fieldPath) => id(field, fieldPath), 64, true);
  if (value.projections !== undefined) list(value.projections, `${path}.projections`, (fields, fieldsPath) => list(fields, fieldsPath, (field, fieldPath) => id(field, fieldPath), 64, true), 16, true);
  if (value.operator !== undefined) oneOf(value.operator, `${path}.operator`, ['near']);
  if (value.kind === 'ordered' && value.sort === undefined) fail(`${path}.sort`, 'is required');
  if (value.kind === 'windowed' && value.limit === undefined && value.skip === undefined) fail(`${path}`, 'requires skip or limit');
  if (value.kind === 'selector' && value.selector === undefined) fail(`${path}.selector`, 'is required');
  if (value.kind === 'unsupported_selector' && value.operator === undefined) fail(`${path}.operator`, 'is required');
  if (value.kind === 'projection' && value.fields === undefined) fail(`${path}.fields`, 'is required');
  if (value.kind === 'multiple_projections' && value.projections === undefined) fail(`${path}.projections`, 'is required');
}
function step(value, path) {
  record(value, path, ['id', 'kind', 'timeoutMs', 'onFailure', 'concurrencyGroup', 'operation', 'selector', 'mutation', 'expectedTransition', 'predicate', 'inputs', 'controller', 'faultId', 'action', 'clients', 'producer', 'barrier', 'query', 'schedule', 'participants', 'scope'], ['id', 'kind', 'onFailure']);
  id(value.id, `${path}.id`); oneOf(value.kind, `${path}.kind`, STEP_KINDS); oneOf(value.onFailure, `${path}.onFailure`, ['fail_case', 'incomplete_case']);
  if (value.timeoutMs !== undefined) integer(value.timeoutMs, `${path}.timeoutMs`, 1, GLOBAL_LIMITS.stepTimeoutMs);
  if (value.concurrencyGroup !== undefined) {
    if (value.kind === 'barrier' || value.kind === 'seal_evidence' || value.kind === 'snapshot') {
      fail(`${path}.concurrencyGroup`, `is not allowed for ${value.kind}`);
    }
    id(value.concurrencyGroup, `${path}.concurrencyGroup`);
  }
  const base = ['id', 'kind', 'timeoutMs', 'onFailure', 'concurrencyGroup'];
  const requiredBase = ['id', 'kind', 'onFailure'];
  if (value.kind === 'mongo_write') { record(value, path, [...base, 'operation', 'selector', 'mutation', 'expectedTransition'], [...requiredBase, 'operation', 'selector', 'mutation', 'expectedTransition']); oneOf(value.operation, `${path}.operation`, ['insert_one', 'insert_many', 'update_one', 'replace_one', 'delete_one', 'delete_many']); selector(value.selector, `${path}.selector`); mutation(value.mutation, `${path}.mutation`); transition(value.expectedTransition, `${path}.expectedTransition`); }
  else if (value.kind === 'wait') { record(value, path, [...base, 'predicate', 'inputs'], [...requiredBase, 'predicate', 'inputs']); oneOf(value.predicate, `${path}.predicate`, ['all_subscribers_ready', 'event_ledger_contains', 'all_subscribers_converged', 'observer_driver_witnessed', 'fault_activated', 'fault_engaged', 'fault_recovered']); record(value.inputs, `${path}.inputs`, Object.keys(value.inputs || {}), []); for (const [key, ref] of Object.entries(value.inputs)) { id(key, `${path}.inputs.${key}`); validateValueRef(ref, `${path}.inputs.${key}`); } }
  else if (value.kind === 'fault') { record(value, path, [...base, 'operation', 'controller', 'faultId'], [...requiredBase, 'operation', 'controller', 'faultId']); oneOf(value.operation, `${path}.operation`, ['activate', 'restore']); oneOf(value.controller, `${path}.controller`, DECLARATIVE_AUDIT_FAULT_CONTROLLERS); id(value.faultId, `${path}.faultId`); }
  else if (value.kind === 'client_lifecycle') { record(value, path, [...base, 'action', 'clients'], [...requiredBase, 'action', 'clients']); oneOf(value.action, `${path}.action`, DECLARATIVE_AUDIT_CLIENT_ACTIONS); validateValueRef(value.clients, `${path}.clients`); }
  else if (value.kind === 'snapshot') { record(value, path, [...base, 'producer', 'scope'], [...requiredBase, 'producer', 'scope']); oneOf(value.producer, `${path}.producer`, DECLARATIVE_AUDIT_PRODUCERS); oneOf(value.scope, `${path}.scope`, ['expected', 'mongodb', 'ddp', 'all']); }
  else if (value.kind === 'barrier') { record(value, path, [...base, 'barrier', 'schedule', 'participants'], [...requiredBase, 'barrier', 'schedule', 'participants']); id(value.barrier, `${path}.barrier`); oneOf(value.schedule, `${path}.schedule`, ['serialized', 'concurrent', 'burst']); validateValueRef(value.participants, `${path}.participants`); }
  else if (value.kind === 'subscribe') { record(value, path, [...base, 'query', 'clients'], [...requiredBase, 'query', 'clients']); query(value.query, `${path}.query`); validateValueRef(value.clients, `${path}.clients`); }
  else record(value, path, base, requiredBase);
  return value;
}

function parameters(value, path) {
  record(value, path, Object.keys(value || {}), []);
  if (Object.keys(value).length > 64) fail(path, 'has too many parameters');
  for (const [name, definition] of Object.entries(value)) {
    id(name, `${path}.${name}`); record(definition, `${path}.${name}`, ['type', 'default', 'minimum', 'maximum', 'values'], ['type', 'default']);
    if (definition.type === 'integer') { record(definition, `${path}.${name}`, ['type', 'default', 'minimum', 'maximum']); integer(definition.minimum, `${path}.${name}.minimum`, 0, GLOBAL_LIMITS.maximumPayloadBytes); integer(definition.maximum, `${path}.${name}.maximum`, definition.minimum, GLOBAL_LIMITS.maximumPayloadBytes); integer(definition.default, `${path}.${name}.default`, definition.minimum, definition.maximum); }
    else if (definition.type === 'enum') { record(definition, `${path}.${name}`, ['type', 'default', 'values']); const values = unique(list(definition.values, `${path}.${name}.values`, (v, p) => text(v, p, 128), 32, true), `${path}.${name}.values`); if (!values.includes(definition.default)) fail(`${path}.${name}.default`, 'must be an allowed value'); }
    else if (definition.type === 'boolean') { record(definition, `${path}.${name}`, ['type', 'default']); if (typeof definition.default !== 'boolean') fail(`${path}.${name}.default`, 'must be boolean'); }
    else fail(`${path}.${name}.type`, 'is unknown');
  }
}

/** Validates one authored CaseDefinitionV1 and statically checks backward step references. */
export function validateDeclarativeCaseDefinition(value, path = 'case') {
  const keys = ['schemaVersion', 'id', 'title', 'source', 'rationale', 'applicability', 'parameters', 'fixture', 'preconditions', 'steps', 'evidence', 'oracles', 'diagnostics', 'cleanup', 'budget', 'sharing'];
  record(value, path, keys); if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1'); id(value.id, `${path}.id`); text(value.title, `${path}.title`, 256); text(value.source, `${path}.source`, 512); text(value.rationale, `${path}.rationale`, 2048);
  list(value.applicability, `${path}.applicability`, (entry, p) => { record(entry, p, ['topologies', 'transports', 'observerOrders']); list(entry.topologies, `${p}.topologies`, (v, q) => oneOf(v, q, ['replica_set', 'sharded_cluster', 'standalone']), 3, true); list(entry.transports, `${p}.transports`, (v, q) => oneOf(v, q, ['sockjs', 'sockjs-polling', 'uws']), 3, true); list(entry.observerOrders, `${p}.observerOrders`, (order, q) => list(order, q, (v, r) => oneOf(v, r, ['changeStreams', 'oplog', 'polling']), 3, true), 8, true); }, 32, true);
  parameters(value.parameters, `${path}.parameters`);
  record(value.fixture, `${path}.fixture`, ['collection', 'publication', 'generator', 'subscribers', 'documents', 'payloadBytes']); oneOf(value.fixture.collection, `${path}.fixture.collection`, ['reliabilityDocuments']); oneOf(value.fixture.publication, `${path}.fixture.publication`, ['reliability.documents']); oneOf(value.fixture.generator, `${path}.fixture.generator`, DECLARATIVE_AUDIT_GENERATORS); for (const key of ['subscribers', 'documents', 'payloadBytes']) validateValueRef(value.fixture[key], `${path}.fixture.${key}`);
  list(value.preconditions, `${path}.preconditions`, (entry, p) => { record(entry, p, ['kind', 'driver', 'topology', 'transport'], ['kind']); oneOf(entry.kind, `${p}.kind`, ['actual_observer_available', 'observer_driver_unavailable', 'topology_available', 'topology_matches_coordinate', 'transport_available', 'fault_controller_available']); if (entry.driver !== undefined) oneOf(entry.driver, `${p}.driver`, ['changeStreams', 'oplog', 'polling']); if (entry.topology !== undefined) oneOf(entry.topology, `${p}.topology`, ['replica_set', 'sharded_cluster', 'standalone']); if (entry.transport !== undefined) validateValueRef(entry.transport, `${p}.transport`); return entry; }, 32);
  const steps = list(value.steps, `${path}.steps`, step, GLOBAL_LIMITS.maximumSteps, true); unique(steps.map((entry) => entry.id), `${path}.steps`);
  const openConcurrencyGroups = new Set();
  for (const entry of steps) {
    if (entry.concurrencyGroup !== undefined) openConcurrencyGroups.add(entry.concurrencyGroup);
    if (entry.kind === 'barrier') {
      if (!openConcurrencyGroups.delete(entry.barrier)) fail(`${path}.steps`, `barrier ${entry.id} has no open concurrency group ${entry.barrier}`);
    }
  }
  if (openConcurrencyGroups.size > 0) fail(`${path}.steps`, `has unjoined concurrency groups: ${[...openConcurrencyGroups].sort().join(', ')}`);
  const stepIndex = new Map(steps.map((entry, index) => [entry.id, index]));
  const visitRefs = (node, nodePath, ownerIndex) => { if (!node || typeof node !== 'object') return; if (node.kind === 'step') { validateValueRef(node, nodePath); const target = stepIndex.get(node.stepId); if (target === undefined) fail(`${nodePath}.stepId`, 'references an unknown step'); if (target >= ownerIndex) fail(`${nodePath}.stepId`, 'must reference an earlier step'); } for (const [key, child] of Object.entries(node)) visitRefs(child, `${nodePath}.${key}`, ownerIndex); };
  steps.forEach((entry, index) => visitRefs(entry, `${path}.steps[${index}]`, index));
  record(value.evidence, `${path}.evidence`, ['requiredProducers', 'observer', 'transportIdentity', 'fault', 'ledgers']); const producers = unique(list(value.evidence.requiredProducers, `${path}.evidence.requiredProducers`, (v, p) => oneOf(v, p, DECLARATIVE_AUDIT_PRODUCERS.filter((x) => x !== 'expected_model')), 4, true), `${path}.evidence.requiredProducers`); record(value.evidence.observer, `${path}.evidence.observer`, ['kind', 'driver', 'from', 'to', 'reasonRequired'], ['kind']); oneOf(value.evidence.observer.kind, `${path}.evidence.observer.kind`, ['selected', 'fallback']); if (value.evidence.observer.kind === 'selected') { record(value.evidence.observer, `${path}.evidence.observer`, ['kind', 'driver']); validateValueRef(value.evidence.observer.driver, `${path}.evidence.observer.driver`); } else { record(value.evidence.observer, `${path}.evidence.observer`, ['kind', 'from', 'to', 'reasonRequired']); oneOf(value.evidence.observer.from, `${path}.evidence.observer.from`, ['changeStreams', 'oplog', 'polling']); if (typeof value.evidence.observer.to === 'string') oneOf(value.evidence.observer.to, `${path}.evidence.observer.to`, ['changeStreams', 'oplog', 'polling']); else record(value.evidence.observer.to, `${path}.evidence.observer.to`, ['replica_set', 'sharded_cluster', 'standalone'], []); if (value.evidence.observer.reasonRequired !== true) fail(`${path}.evidence.observer.reasonRequired`, 'must equal true'); }
  oneOf(value.evidence.transportIdentity, `${path}.evidence.transportIdentity`, ['required', 'diagnostic']); if (value.evidence.fault !== null) { record(value.evidence.fault, `${path}.evidence.fault`, ['kind', 'controller']); oneOf(value.evidence.fault.kind, `${path}.evidence.fault.kind`, ['activated_and_restored']); oneOf(value.evidence.fault.controller, `${path}.evidence.fault.controller`, DECLARATIVE_AUDIT_FAULT_CONTROLLERS); } list(value.evidence.ledgers, `${path}.evidence.ledgers`, (v, p) => id(v, p), 32, true);
  const oracles = list(value.oracles, `${path}.oracles`, (oracle, p) => { record(oracle, p, ['id', 'family', 'producer', 'expected', 'observed', 'failureReason', 'gate']); id(oracle.id, `${p}.id`); oneOf(oracle.family, `${p}.family`, DECLARATIVE_AUDIT_ORACLE_FAMILIES); oneOf(oracle.producer, `${p}.producer`, DECLARATIVE_AUDIT_PRODUCERS.filter((x) => x !== 'expected_model')); validateValueRef(oracle.expected, `${p}.expected`); refRecord(oracle.observed, `${p}.observed`); id(oracle.failureReason, `${p}.failureReason`); oneOf(oracle.gate, `${p}.gate`, ['hard', 'diagnostic']); return oracle; }, 64, true); unique(oracles.map((o) => o.id), `${path}.oracles`); if (!oracles.some((o) => o.gate === 'hard' && producers.includes(o.producer))) fail(`${path}.oracles`, 'must hard-gate a required independent producer');
  oracles.forEach((oracle, index) => { const target = stepIndex.get(oracle.expected.stepId); if (oracle.expected.kind === 'step' && target === undefined) fail(`${path}.oracles[${index}].expected.stepId`, 'references an unknown step'); if (oracle.observed.stepId !== 'cleanup' && !stepIndex.has(oracle.observed.stepId)) fail(`${path}.oracles[${index}].observed.stepId`, 'references an unknown step'); });
  list(value.diagnostics, `${path}.diagnostics`, (entry, p) => { record(entry, p, ['kind', 'fromStep'], ['kind']); oneOf(entry.kind, `${p}.kind`, ['propagation_latency', 'event_counts', 'resource_usage']); if (entry.fromStep !== undefined) { id(entry.fromStep, `${p}.fromStep`); if (!stepIndex.has(entry.fromStep)) fail(`${p}.fromStep`, 'references an unknown step'); } if (entry.kind === 'propagation_latency' && entry.fromStep === undefined) fail(`${p}.fromStep`, 'is required for propagation latency'); }, 32);
  record(value.cleanup, `${path}.cleanup`, ['kind', 'verifyEmpty']); oneOf(value.cleanup.kind, `${path}.cleanup.kind`, ['run_scoped']); if (value.cleanup.verifyEmpty !== true) fail(`${path}.cleanup.verifyEmpty`, 'must equal true');
  record(value.budget, `${path}.budget`, [...Object.keys(GLOBAL_LIMITS), 'maximumRetries']); for (const [key, maximum] of Object.entries(GLOBAL_LIMITS)) integer(value.budget[key], `${path}.budget.${key}`, 1, maximum); oneOf(value.budget.maximumRetries, `${path}.budget.maximumRetries`, [0, 1]); if (value.budget.maximumSteps < steps.length) fail(`${path}.budget.maximumSteps`, 'must cover all declared steps'); oneOf(value.sharing, `${path}.sharing`, ['isolated']);
  return normalized(value);
}

/** Canonical public name for the CaseDefinitionV1 validator. */
export const validateCaseDefinition = validateDeclarativeCaseDefinition;

/** Validates a bounded AuditProfileV1 parameter source. */
export function validateDeclarativeAuditProfile(value, path = 'profile') {
  record(value, path, ['schemaVersion', 'id', 'parameters', 'caseTimeoutMs']); if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1'); id(value.id, `${path}.id`); record(value.parameters, `${path}.parameters`, Object.keys(value.parameters || {}), []); if (Object.keys(value.parameters).length > 64) fail(`${path}.parameters`, 'has too many entries'); for (const [key, entry] of Object.entries(value.parameters)) { id(key, `${path}.parameters.${key}`); boundedEjson(entry, `${path}.parameters.${key}`); } integer(value.caseTimeoutMs, `${path}.caseTimeoutMs`, 1, GLOBAL_LIMITS.caseTimeoutMs); return normalized(value);
}

/** Validates the closed profiles.json envelope. */
export function validateAuditProfileCatalog(value, path = 'profiles') {
  record(value, path, ['schemaVersion', 'profiles']);
  if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const profiles = list(value.profiles, `${path}.profiles`, (profile, profilePath) => {
    record(profile, profilePath, ['id', 'title', 'parameters']); id(profile.id, `${profilePath}.id`); text(profile.title, `${profilePath}.title`, 256);
    record(profile.parameters, `${profilePath}.parameters`, Object.keys(profile.parameters || {}), []);
    for (const [key, entry] of Object.entries(profile.parameters)) { id(key, `${profilePath}.parameters.${key}`); boundedEjson(entry, `${profilePath}.parameters.${key}`); }
    return profile;
  }, 16, true);
  unique(profiles.map((profile) => profile.id), `${path}.profiles`);
  return normalized(value);
}

/** Validates the data-only CapabilityDefinitionV2 catalog envelope. */
export function validateCapabilityCatalog(value, path = 'capabilities') {
  record(value, path, ['schemaVersion', 'contractId', 'reviewedAt', 'capabilities']);
  if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  id(value.contractId, `${path}.contractId`); text(value.reviewedAt, `${path}.reviewedAt`, 32);
  const capabilities = list(value.capabilities, `${path}.capabilities`, (entry, entryPath) => {
    record(entry, entryPath, ['id', 'expectation', 'requiredCases', 'applicability', 'source', 'rationale']);
    id(entry.id, `${entryPath}.id`); oneOf(entry.expectation, `${entryPath}.expectation`, ['supported', 'fallback_required', 'not_supported', 'out_of_scope']);
    unique(list(entry.requiredCases, `${entryPath}.requiredCases`, (caseId, casePath) => id(caseId, casePath), 128), `${entryPath}.requiredCases`);
    list(entry.applicability, `${entryPath}.applicability`, (scope, scopePath) => {
      record(scope, scopePath, ['topologies', 'transports', 'observerOrders']);
      list(scope.topologies, `${scopePath}.topologies`, (item, itemPath) => oneOf(item, itemPath, ['replica_set', 'sharded_cluster', 'standalone']), 3, true);
      list(scope.transports, `${scopePath}.transports`, (item, itemPath) => oneOf(item, itemPath, ['sockjs', 'sockjs-polling', 'uws']), 3, true);
      list(scope.observerOrders, `${scopePath}.observerOrders`, (order, orderPath) => list(order, orderPath, (item, itemPath) => oneOf(item, itemPath, ['changeStreams', 'oplog', 'polling']), 3, true), 8, true);
    }, 32);
    text(entry.source, `${entryPath}.source`, 512); text(entry.rationale, `${entryPath}.rationale`, 2048);
    if (['supported', 'fallback_required'].includes(entry.expectation) && (entry.requiredCases.length === 0 || entry.applicability.length === 0)) fail(entryPath, 'must declare required cases and applicability'); return entry;
  }, 512, true);
  unique(capabilities.map((capability) => capability.id), `${path}.capabilities`);
  return normalized(value);
}

/** Validates a NegativeControlDefinitionV1 without accepting asserted outcomes. */
export function validateNegativeControlDefinition(value, path = 'negativeControl') {
  record(value, path, ['schemaVersion', 'id', 'targetOracleFamily', 'mutation', 'expectedReason']); if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1'); id(value.id, `${path}.id`); oneOf(value.targetOracleFamily, `${path}.targetOracleFamily`, DECLARATIVE_AUDIT_ORACLE_FAMILIES); record(value.mutation, `${path}.mutation`, ['kind']); oneOf(value.mutation.kind, `${path}.mutation.kind`, ['drop_event', 'duplicate_event', 'reorder_revision', 'alter_payload_byte', 'retain_removed_field', 'substitute_observer', 'suppress_fallback_record', 'substitute_session', 'duplicate_idempotent_effect', 'omit_fault_witness', 'omit_release_identity', 'set_workload_exit_nonzero', 'remove_required_case', 'fail_restoration']); id(value.expectedReason, `${path}.expectedReason`); return normalized(value);
}

/** Validates the closed negative-controls.json envelope. */
export function validateNegativeControlCatalog(value, path = 'negativeControls') {
  record(value, path, ['schemaVersion', 'controls']);
  if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1');
  const controls = list(value.controls, `${path}.controls`, validateNegativeControlDefinition, 128, true);
  unique(controls.map((control) => control.id), `${path}.controls`);
  return normalized(value);
}

/** Validates deterministic CompiledCasePlanV1 identity and its closed execution body. */
export function validateCompiledCasePlan(value, path = 'compiledPlan') {
  record(value, path, ['schemaVersion', 'contractId', 'contractDigest', 'caseDefinitionDigest', 'profileId', 'coordinate', 'resolvedParameters', 'steps', 'budget', 'digest']); if (value.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must equal 1'); id(value.contractId, `${path}.contractId`); for (const key of ['contractDigest', 'caseDefinitionDigest', 'digest']) { text(value[key], `${path}.${key}`, 64); if (!DIGEST.test(value[key])) fail(`${path}.${key}`, 'must be a SHA-256 digest'); } id(value.profileId, `${path}.profileId`); record(value.coordinate, `${path}.coordinate`, ['caseId', 'transport', 'topology', 'observerOrder', 'seed', 'faultId'], ['caseId', 'transport', 'topology', 'observerOrder', 'seed']); id(value.coordinate.caseId, `${path}.coordinate.caseId`); oneOf(value.coordinate.transport, `${path}.coordinate.transport`, ['sockjs', 'sockjs-polling', 'uws']); oneOf(value.coordinate.topology, `${path}.coordinate.topology`, ['replica_set', 'sharded_cluster', 'standalone']); list(value.coordinate.observerOrder, `${path}.coordinate.observerOrder`, (v, p) => oneOf(v, p, ['changeStreams', 'oplog', 'polling']), 3, true); integer(value.coordinate.seed, `${path}.coordinate.seed`, 0, 0xffffffff); if (value.coordinate.faultId !== undefined) id(value.coordinate.faultId, `${path}.coordinate.faultId`); record(value.resolvedParameters, `${path}.resolvedParameters`, Object.keys(value.resolvedParameters || {}), []); for (const [key, entry] of Object.entries(value.resolvedParameters)) { id(key, `${path}.resolvedParameters.${key}`); boundedEjson(entry, `${path}.resolvedParameters.${key}`); } list(value.steps, `${path}.steps`, step, GLOBAL_LIMITS.maximumSteps, true); record(value.budget, `${path}.budget`, [...Object.keys(GLOBAL_LIMITS), 'maximumRetries']); for (const [key, maximum] of Object.entries(GLOBAL_LIMITS)) integer(value.budget[key], `${path}.budget.${key}`, 1, maximum); oneOf(value.budget.maximumRetries, `${path}.budget.maximumRetries`, [0, 1]); return normalized(value);
}

/** Validates the declarative V3 result attestation fields before aggregation. */
export function validateAuditCaseResultV3Attestations(value, path = 'result') {
  const keys = ['schemaVersion', 'contractId', 'contractDigest', 'caseDefinitionDigest', 'compiledPlanDigest', 'interpreterVersion', 'resolvedParameters', 'stepLedgerDigest', 'evidenceLedgerDigests']; record(value, path, keys); if (value.schemaVersion !== 3) fail(`${path}.schemaVersion`, 'must equal 3'); id(value.contractId, `${path}.contractId`); id(value.interpreterVersion, `${path}.interpreterVersion`); for (const key of ['contractDigest', 'caseDefinitionDigest', 'compiledPlanDigest', 'stepLedgerDigest']) { text(value[key], `${path}.${key}`, 64); if (!DIGEST.test(value[key])) fail(`${path}.${key}`, 'must be a SHA-256 digest'); } record(value.resolvedParameters, `${path}.resolvedParameters`, Object.keys(value.resolvedParameters || {}), []); for (const [key, entry] of Object.entries(value.resolvedParameters)) { id(key, `${path}.resolvedParameters.${key}`); boundedEjson(entry, `${path}.resolvedParameters.${key}`); } record(value.evidenceLedgerDigests, `${path}.evidenceLedgerDigests`, DECLARATIVE_AUDIT_PRODUCERS, []); if (Object.keys(value.evidenceLedgerDigests).length === 0) fail(`${path}.evidenceLedgerDigests`, 'must not be empty'); for (const [producer, valueDigest] of Object.entries(value.evidenceLedgerDigests)) { oneOf(producer, `${path}.evidenceLedgerDigests.${producer}`, DECLARATIVE_AUDIT_PRODUCERS); text(valueDigest, `${path}.evidenceLedgerDigests.${producer}`, 64); if (!DIGEST.test(valueDigest)) fail(`${path}.evidenceLedgerDigests.${producer}`, 'must be a SHA-256 digest'); } return normalized(value);
}


/** Canonical public name for declarative AuditCaseResultV3 attestations. */
export const validateDeclarativeAuditResult = validateAuditCaseResultV3Attestations;
