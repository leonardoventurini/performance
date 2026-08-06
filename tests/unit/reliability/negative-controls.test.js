import assert from 'node:assert/strict';
import test from 'node:test';

import { contractDigest } from '../../../reliability/contracts/digest.js';
import { runDeclarativeNegativeControls } from '../../../reliability/runtime/negative-controls.js';
import {
  DECLARATIVE_AUDIT_CONTRACT_DIGEST,
  DECLARATIVE_AUDIT_INTERPRETER_VERSION,
  RELEASE_CAPABILITY_CONTRACT_ID,
  RELEASE_CASE_CONTRACTS,
} from '../../../reliability/release-audit/capability-registry.js';

const SHA = 'a'.repeat(64);

const mutationReasons = Object.freeze({
  drop_event: 'ddp_event_missing',
  duplicate_event: 'logical_event_duplicate',
  reorder_revision: 'revision_not_monotonic',
  alter_payload_byte: 'content_digest_mismatch',
  retain_removed_field: 'stale_field_retained',
  substitute_observer: 'observer_identity_mismatch',
  suppress_fallback_record: 'fallback_evidence_missing',
  substitute_session: 'session_identity_mismatch',
  duplicate_idempotent_effect: 'idempotency_violation',
  omit_fault_witness: 'fault_witness_missing',
  omit_release_identity: 'release_identity_missing',
  remove_required_case: 'required_coordinate_missing',
  fail_restoration: 'recovery_incomplete',
});

function record(definitionId = 'data.field_removal_no_stale_residue') {
  const snapshot = [{ _id: 'doc-1', payload: 'abc', revision: 1 }];
  return {
    definition: {
      id: definitionId,
      oracles: [
        {
          family: 'snapshot_exact',
          expected: { kind: 'step', stepId: 'write', output: 'expectedState' },
          observed: { stepId: 'snapshot', ledger: 'snapshot' },
        },
        {
          family: 'observer_identity',
          expected: { kind: 'literal', value: 'changeStreams' },
          observed: { stepId: 'subscribe', ledger: 'observer_selection' },
        },
        {
          family: 'session_identity',
          expected: { kind: 'step', stepId: 'lifecycle', output: 'expectedSessionIdentity' },
          observed: { stepId: 'lifecycle', ledger: 'session_identity' },
        },
      ],
    },
    execution: {
      evidence: {
        outputs: {
          write: { expectedState: snapshot },
          snapshot: { snapshot },
          subscribe: { observer_selection: 'changeStreams' },
          lifecycle: { expectedSessionIdentity: 'resumed', session_identity: 'resumed' },
        },
      },
      contextEvidence: {
        ddpLedgers: [[
          { sequence: 1, direction: 'in', message: { msg: 'added', id: 'doc-1', fields: { revision: 0 } } },
          { sequence: 2, direction: 'in', message: { msg: 'changed', id: 'doc-1', fields: { revision: 1 } } },
        ]],
      },
    },
    result: {
      schemaVersion: 3,
      contractId: RELEASE_CAPABILITY_CONTRACT_ID,
      contractDigest: DECLARATIVE_AUDIT_CONTRACT_DIGEST,
      caseDefinitionDigest: RELEASE_CASE_CONTRACTS[definitionId].definitionDigest,
      interpreterVersion: DECLARATIVE_AUDIT_INTERPRETER_VERSION,
      status: 'passed',
      coordinate: {
        caseId: definitionId,
        transport: 'sockjs',
        observerOrder: ['changeStreams', 'polling'],
        topology: 'replica_set',
        seed: 1,
        ...(definitionId.startsWith('recovery.') ? { faultId: definitionId } : {}),
      },
      release: {
        requested: '3.5.1-beta.0', actual: '3.5.1-beta.0',
        sourceRevision: 'release:3.5.1-beta.0', fixtureRelease: 'METEOR@3.5.1-beta.0',
        packageVersionsDigest: SHA, settingsDigest: SHA, harnessRevision: 'b'.repeat(40),
        harnessDirty: false, executionEnvironment: 'node-24-test',
      },
      observerEvidence: [{
        cursorId: 'cursor-1', requestedOrder: ['changeStreams', 'polling'],
        actualDriver: definitionId.startsWith('fallback.') ? 'polling' : 'changeStreams',
        ...(definitionId.startsWith('fallback.') ? {
          fallbackFrom: 'changeStreams', fallbackReason: 'query_not_supported',
        } : {}),
      }],
      oracles: [
        { oracleId: 'mongo', family: 'snapshot_exact', producer: 'mongodb', digest: SHA, assertions: 1, passed: true, failures: [] },
        { oracleId: 'ddp', family: 'snapshot_exact', producer: 'ddp_client', digest: SHA, assertions: 1, passed: true, failures: [] },
        { oracleId: 'transport', family: 'transport_identity', producer: 'meteor_probe', digest: SHA, assertions: 1, passed: true, failures: [] },
        ...(definitionId.startsWith('recovery.') ? [{
          oracleId: 'fault', family: 'fault_witness', producer: 'fault_controller',
          digest: contractDigest({ activationEvidenceDigest: SHA, restorationEvidenceDigest: SHA }),
          assertions: 1, passed: true, failures: [],
        }] : []),
      ],
      ...(definitionId.startsWith('recovery.') ? { faultWitness: {
        faultId: definitionId, kind: 'bounded_fault', activationEvidenceDigest: SHA,
        restorationEvidenceDigest: SHA, restored: true,
      } } : {}),
    },
  };
}

function records() {
  return [record(), record('fallback.skip'), record('recovery.replica_set_election')];
}

test('every negative control detects its mutation against captured audit evidence', () => {
  const controls = Object.entries(mutationReasons).map(([kind, expectedReason]) => ({
    id: `control.${kind}`,
    mutation: { kind },
    expectedReason,
  }));
  const results = runDeclarativeNegativeControls({
    controls,
    records: records(),
    recovery: {
      runDocumentsRemoved: true,
      topologyRestored: true,
      profilerRestored: true,
      networkRestored: true,
    },
  });
  assert.equal(results.length, controls.length);
  assert.ok(
    results.every(({ detected, expectedReason, actualReason }) => (
      detected && actualReason === expectedReason
    )),
    JSON.stringify(results),
  );
});

test('negative controls fail closed when source evidence is absent', () => {
  const [result] = runDeclarativeNegativeControls({
    controls: [{ id: 'control.drop', mutation: { kind: 'drop_event' }, expectedReason: 'ddp_event_missing' }],
    records: [],
    recovery: null,
  });
  assert.equal(result.detected, false);
  assert.equal(result.actualReason, 'negative_control_not_detected');
});

test('detector reasons are independent from authored expected reasons', () => {
  const [result] = runDeclarativeNegativeControls({
    controls: [{ id: 'control.drop', mutation: { kind: 'drop_event' }, expectedReason: 'forged_reason' }],
    records: records(),
    recovery: null,
  });
  assert.equal(result.detected, true);
  assert.equal(result.actualReason, 'ddp_event_missing');
  assert.notEqual(result.actualReason, result.expectedReason);
});

test('artifact controls are undetected when the production gate accepts the mutation', () => {
  const cases = [
    ['suppress_fallback_record', 'fallback_evidence_missing', 'caseEvidenceStatus'],
    ['omit_fault_witness', 'fault_witness_missing', 'caseEvidenceStatus'],
    ['omit_release_identity', 'release_identity_missing', 'releaseIdentityStatus'],
    ['remove_required_case', 'required_coordinate_missing', 'logicalCoordinateStatus'],
    ['fail_restoration', 'recovery_incomplete', 'recoveryEvidenceStatus'],
  ];
  for (const [kind, expectedReason, gateName] of cases) {
    const [result] = runDeclarativeNegativeControls({
      controls: [{ id: `control.${kind}`, mutation: { kind }, expectedReason }],
      records: records(),
      recovery: {
        runDocumentsRemoved: true, topologyRestored: true,
        profilerRestored: true, networkRestored: true,
      },
      gates: { [gateName]: () => ({ status: 'passed', reasons: [] }) },
    });
    assert.equal(result.detected, false, kind);
    assert.equal(result.actualReason, 'negative_control_not_detected', kind);
  }
});
