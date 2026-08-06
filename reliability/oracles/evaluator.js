import { isDeepStrictEqual } from 'node:util';

import { snapshotDigest } from './snapshot.js';

function readExpected(reference, execution) {
  switch (reference.kind) {
    case 'literal': return reference.value;
    case 'coordinate': return execution.evidence.coordinate[reference.field];
    case 'step': return execution.evidence.outputs[reference.stepId]?.[reference.output];
    default: throw new Error(`oracle expected reference ${reference.kind} is not evaluable after execution`);
  }
}

function readObserved(reference, execution) {
  return execution.evidence.outputs[reference.stepId]?.[reference.ledger];
}

function hasBoundProvenance(reference, execution) {
  return execution.evidence.provenance?.[reference.stepId]?.[reference.ledger] === reference.producer;
}

function hasSealedQuietWindow(execution, producer) {
  return Object.values(execution.evidence.outputs).some((output) => (
    output?.sealed === true
    && Array.isArray(output.producers)
    && output.producers.includes(producer)
    && output.cutoff && typeof output.cutoff === 'object'
    && output.quietWindow && typeof output.quietWindow === 'object'
    && Number.isInteger(output.quietWindow.startSequence)
    && Number.isInteger(output.quietWindow.endSequence)
    && output.quietWindow.endSequence >= output.quietWindow.startSequence
  ));
}

const equality = ({ expected, observed }) => isDeepStrictEqual(observed, expected);

/** Closed oracle catalog. Each family compares independently produced evidence. */
export const DECLARATIVE_ORACLE_HANDLERS = Object.freeze({
  snapshot_exact: ({ expected, observed }) => (
    Array.isArray(expected)
    && Array.isArray(observed)
    && snapshotDigest(expected) === snapshotDigest(observed)
  ),
  event_present: ({ expected, observed }) => Array.isArray(observed) && observed.some((entry) => isDeepStrictEqual(entry, expected)),
  event_absent: ({ expected, observed, oracle, execution }) => (
    Array.isArray(observed)
    && hasSealedQuietWindow(execution, oracle.observed.producer)
    && !observed.some((entry) => isDeepStrictEqual(entry, expected))
  ),
  revision_monotonic: ({ observed }) => Array.isArray(observed) && observed.every((value, index) => index === 0 || value > observed[index - 1]),
  field_absent: ({ expected, observed }) => observed && typeof observed === 'object' && !Object.hasOwn(observed, expected),
  observer_identity: equality,
  fallback_identity: equality,
  transport_identity: equality,
  session_identity: equality,
  fault_witness: equality,
  cleanup_complete: equality,
  release_identity: equality,
  workload_process: equality,
  required_coordinate: equality,
});

/** Evaluates every declared oracle and fails closed for missing evidence. */
export function evaluateDeclarativeOracles({ definition, execution, handlers = DECLARATIVE_ORACLE_HANDLERS }) {
  const results = definition.oracles.map((oracle) => {
    const handler = handlers[oracle.family];
    if (typeof handler !== 'function') {
      return Object.freeze({ id: oracle.id, family: oracle.family, passed: false, reason: 'oracle_handler_missing', gate: oracle.gate });
    }
    let passed = false;
    let reason = oracle.failureReason;
    try {
      const expected = readExpected(oracle.expected, execution);
      const observed = readObserved(oracle.observed, execution);
      if (expected === undefined || observed === undefined) reason = 'required_evidence_missing';
      else if (!hasBoundProvenance(oracle.observed, execution)) reason = 'evidence_provenance_mismatch';
      else passed = handler({ expected, observed, oracle, execution }) === true;
    } catch {
      reason = 'oracle_evaluation_error';
    }
    return Object.freeze({ id: oracle.id, family: oracle.family, passed, reason: passed ? null : reason, gate: oracle.gate });
  });
  const hardFailures = results.filter(({ gate, passed }) => gate === 'hard' && !passed);
  return Object.freeze({
    status: execution.status === 'incomplete' || hardFailures.some(({ reason }) => reason === 'required_evidence_missing')
      ? 'incomplete'
      : execution.status === 'failed' || hardFailures.length > 0 ? 'failed' : 'passed',
    results: Object.freeze(results),
  });
}
