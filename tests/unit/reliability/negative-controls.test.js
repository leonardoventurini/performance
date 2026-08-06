import assert from 'node:assert/strict';
import test from 'node:test';

import { runDeclarativeNegativeControls } from '../../../reliability/runtime/negative-controls.js';

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
  set_workload_exit_nonzero: 'workload_process_failed',
  remove_required_case: 'required_coordinate_missing',
  fail_restoration: 'recovery_incomplete',
});

function record() {
  const snapshot = [{ _id: 'doc-1', payload: 'abc', revision: 1 }];
  return {
    definition: {
      id: 'data.field_removal_no_stale_residue',
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
      status: 'passed',
      coordinate: { faultId: 'fault-1' },
      release: { actual: '3.5.1-beta.0' },
      observerEvidence: [{ fallbackFrom: 'changeStreams', actualDriver: 'polling' }],
      faultWitness: { faultId: 'fault-1', restored: true },
    },
  };
}

test('every negative control detects its mutation against captured audit evidence', () => {
  const controls = Object.entries(mutationReasons).map(([kind, expectedReason]) => ({
    id: `control.${kind}`,
    mutation: { kind },
    expectedReason,
  }));
  const results = runDeclarativeNegativeControls({
    controls,
    records: [record()],
    recovery: {
      runDocumentsRemoved: true,
      topologyRestored: true,
      profilerRestored: true,
      networkRestored: true,
    },
    requiredCoordinateCount: 1,
  });
  assert.equal(results.length, controls.length);
  assert.ok(results.every(({ detected, expectedReason, actualReason }) => (
    detected && actualReason === expectedReason
  )));
});

test('negative controls fail closed when source evidence is absent', () => {
  const [result] = runDeclarativeNegativeControls({
    controls: [{ id: 'control.drop', mutation: { kind: 'drop_event' }, expectedReason: 'ddp_event_missing' }],
    records: [],
    recovery: null,
    requiredCoordinateCount: 1,
  });
  assert.equal(result.detected, false);
  assert.equal(result.actualReason, 'negative_control_not_detected');
});

test('detector reasons are independent from authored expected reasons', () => {
  const [result] = runDeclarativeNegativeControls({
    controls: [{ id: 'control.drop', mutation: { kind: 'drop_event' }, expectedReason: 'forged_reason' }],
    records: [record()],
    recovery: null,
    requiredCoordinateCount: 1,
  });
  assert.equal(result.detected, true);
  assert.equal(result.actualReason, 'ddp_event_missing');
  assert.notEqual(result.actualReason, result.expectedReason);
});
