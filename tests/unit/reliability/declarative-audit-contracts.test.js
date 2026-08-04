import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateAuditCaseResultV3Attestations,
  validateCaseDefinition,
  validateNegativeControlDefinition,
  validateValueRef,
} from '../../../reliability/contracts/declarative-audit.js';

const literal = (value) => ({ kind: 'literal', value });

function validCase() {
  return {
    schemaVersion: 1,
    id: 'event.update.unset',
    title: 'Unset removes a field',
    source: 'https://example.test/source',
    rationale: 'Removed fields must not survive publication convergence.',
    applicability: [{
      topologies: ['replica_set'], transports: ['sockjs'],
      observerOrders: [['changeStreams', 'oplog', 'polling']],
    }],
    parameters: {
      subscribers: { type: 'integer', default: 1, minimum: 1, maximum: 12 },
    },
    fixture: {
      collection: 'reliabilityDocuments', publication: 'reliability.documents',
      generator: 'synthetic-document-v1',
      subscribers: { kind: 'parameter', name: 'subscribers' },
      documents: literal(1), payloadBytes: literal(128),
    },
    preconditions: [{ kind: 'actual_observer_available', driver: 'changeStreams' }],
    steps: [
      { id: 'subscribe', kind: 'subscribe', query: { kind: 'unordered' }, clients: { kind: 'fixture', field: 'subscriberIds' }, onFailure: 'incomplete_case' },
      {
        id: 'insert', kind: 'mongo_write', operation: 'insert_one',
        selector: { kind: 'fixture_document', index: 0 },
        mutation: { kind: 'fixture_document', index: 0 },
        expectedTransition: { kind: 'insert' }, onFailure: 'fail_case',
      },
      {
        id: 'unset', kind: 'mongo_write', operation: 'update_one',
        selector: { kind: 'fixture_document', index: 0 },
        mutation: { kind: 'unset', path: ['ephemeral'] },
        expectedTransition: { kind: 'remove_field', path: ['ephemeral'] },
        onFailure: 'fail_case',
      },
      { id: 'converge', kind: 'wait', predicate: 'all_subscribers_converged', inputs: {}, onFailure: 'fail_case' },
      { id: 'seal', kind: 'seal_evidence', onFailure: 'incomplete_case' },
    ],
    evidence: {
      requiredProducers: ['mongodb', 'ddp_client', 'meteor_probe'],
      observer: { kind: 'selected', driver: { kind: 'coordinate', field: 'observerOrder' } },
      transportIdentity: 'required', fault: null,
      ledgers: ['mongodb_snapshot', 'ddp_snapshot', 'observer_selection'],
    },
    oracles: [{
      id: 'ddp-field-absent', family: 'field_absent', producer: 'ddp_client',
      expected: { kind: 'step', stepId: 'unset', output: 'expectedState' },
      observed: { producer: 'ddp_client', stepId: 'converge', ledger: 'snapshot' },
      failureReason: 'stale_field_retained', gate: 'hard',
    }],
    diagnostics: [{ kind: 'propagation_latency', fromStep: 'unset' }],
    cleanup: { kind: 'run_scoped', verifyEmpty: true },
    budget: {
      maximumSteps: 8, maximumDocuments: 1, maximumSubscribers: 12,
      maximumPayloadBytes: 524_288, maximumEvidenceEntries: 10_000,
      stepTimeoutMs: 30_000, caseTimeoutMs: 120_000, maximumRetries: 0,
    },
    sharing: 'isolated',
  };
}

test('declarative audit contract accepts and deeply freezes a bounded case', () => {
  const result = validateCaseDefinition(validCase());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.steps), true);
});

test('declarative audit contract rejects unknown and self-asserted fields', () => {
  assert.throws(() => validateCaseDefinition({ ...validCase(), status: 'passed' }), /case\.status is unknown/);
  const definition = validCase();
  definition.oracles[0].passed = true;
  assert.throws(() => validateCaseDefinition(definition), /oracles\[0\]\.passed is unknown/);
});

test('declarative audit contract rejects unsafe selectors and mutations', () => {
  const unsafeSelector = validCase();
  unsafeSelector.steps[1].selector = { kind: '$where', value: literal('true') };
  assert.throws(() => validateCaseDefinition(unsafeSelector), /not an allowlisted selector|unknown/);
  const unsafeMutation = validCase();
  unsafeMutation.steps[2].mutation = { kind: 'set', path: ['runId'], value: literal('forged') };
  assert.throws(() => validateCaseDefinition(unsafeMutation), /interpreter-owned/);
});

test('declarative audit contract rejects unbounded definitions', () => {
  const definition = validCase();
  definition.budget.maximumPayloadBytes = 16_777_217;
  assert.throws(() => validateCaseDefinition(definition), /maximumPayloadBytes must be an integer/);
  definition.budget.maximumPayloadBytes = 1;
  definition.parameters.subscribers.maximum = Number.MAX_SAFE_INTEGER;
  definition.parameters.subscribers.default = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateCaseDefinition(definition), /maximumSubscribers|parameters/);
});

test('declarative audit contract rejects invalid reference shapes and forward references', () => {
  assert.throws(() => validateValueRef({ kind: 'step', stepId: 'insert' }), /output is required/);
  const definition = validCase();
  definition.steps[1].mutation = { kind: 'step', stepId: 'unset', output: 'expectedState' };
  assert.throws(() => validateCaseDefinition(definition), /must reference an earlier step/);
});

test('declarative negative controls cannot self-assert detection', () => {
  assert.throws(() => validateNegativeControlDefinition({
    schemaVersion: 1, id: 'drop-event', targetOracleFamily: 'event_present',
    mutation: { kind: 'drop_event' }, expectedReason: 'event_missing', detected: true,
  }), /detected is unknown/);
});

test('declarative audit V3 attestations require closed SHA-256 identities', () => {
  const digest = 'a'.repeat(64);
  const result = validateAuditCaseResultV3Attestations({
    schemaVersion: 3, contractId: 'change-stream-v1', contractDigest: digest,
    caseDefinitionDigest: digest, compiledPlanDigest: digest,
    interpreterVersion: 'interpreter-v1', resolvedParameters: { subscribers: 1 },
    stepLedgerDigest: digest, evidenceLedgerDigests: { mongodb: digest },
  });
  assert.equal(result.contractDigest, digest);
  assert.throws(() => validateAuditCaseResultV3Attestations({ ...result, passed: true }), /passed is unknown/);
});
