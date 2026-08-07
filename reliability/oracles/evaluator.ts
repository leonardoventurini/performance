import { isDeepStrictEqual } from 'node:util';

import { snapshotDigest } from './snapshot.js';
type UnknownRecord = Record<string, unknown>;
interface ValueReference extends UnknownRecord { readonly kind: string; readonly value?: unknown; readonly field?: string; readonly stepId?: string; readonly output?: string }
interface ObservedReference extends UnknownRecord { readonly producer: string; readonly stepId: string; readonly ledger: string }
interface OracleDefinition extends UnknownRecord { readonly id: string; readonly family: string; readonly expected: ValueReference; readonly observed: ObservedReference; readonly failureReason: string; readonly gate: string }
interface CaseDefinition { readonly oracles: readonly OracleDefinition[] }
interface Evidence { readonly coordinate: UnknownRecord; readonly outputs: Readonly<Record<string, UnknownRecord | undefined>>; readonly provenance?: Readonly<Record<string, Readonly<Record<string, string | undefined>> | undefined>> }
interface Execution { readonly status: string; readonly evidence: Evidence }
interface OracleArguments { readonly expected: unknown; readonly observed: unknown; readonly oracle: OracleDefinition; readonly execution: Execution }
type OracleHandler = (arguments_: OracleArguments) => boolean;
type OracleHandlers = Readonly<Record<string, OracleHandler | undefined>>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readExpected(reference: ValueReference, execution: Execution): unknown {
  switch (reference.kind) {
    case 'literal': return reference.value;
    case 'coordinate': return reference.field === undefined ? undefined : execution.evidence.coordinate[reference.field];
    case 'step': return reference.stepId === undefined || reference.output === undefined ? undefined : execution.evidence.outputs[reference.stepId]?.[reference.output];
    default: throw new Error(`oracle expected reference ${reference.kind} is not evaluable after execution`);
  }
}

function readObserved(reference: ObservedReference, execution: Execution): unknown {
  return execution.evidence.outputs[reference.stepId]?.[reference.ledger];
}

function hasBoundProvenance(reference: ObservedReference, execution: Execution): boolean {
  return execution.evidence.provenance?.[reference.stepId]?.[reference.ledger] === reference.producer;
}

function isSealedOutput(output: UnknownRecord | undefined, producer: string): boolean {
  if (output?.sealed !== true || !Array.isArray(output.producers) || !output.producers.includes(producer)) return false;
  const cutoff = output.cutoff;
  const quietWindow = output.quietWindow;
  return Boolean(cutoff && typeof cutoff === 'object'
    && quietWindow && typeof quietWindow === 'object'
    && 'startSequence' in quietWindow && typeof quietWindow.startSequence === 'number' && Number.isInteger(quietWindow.startSequence)
    && 'endSequence' in quietWindow && typeof quietWindow.endSequence === 'number' && Number.isInteger(quietWindow.endSequence)
    && quietWindow.endSequence >= quietWindow.startSequence
    && 'eventStable' in quietWindow && quietWindow.eventStable === true);
}

function hasSealedQuietWindow(execution: Execution, producer: string): boolean {
  return Object.values(execution.evidence.outputs).some((output) => (
    isSealedOutput(output, producer)
  ));
}

const equality: OracleHandler = ({ expected, observed }) => isDeepStrictEqual(observed, expected);

function fallbackIdentity({ expected, observed, execution }: OracleArguments): boolean {
  if (!isRecord(expected) || expected.kind !== 'fallback' || !isRecord(observed) || observed.kind !== 'fallback') return false;
  const expectedTarget = typeof expected.to === 'string'
    ? expected.to
    : isRecord(expected.to) && typeof execution.evidence.coordinate.topology === 'string'
      ? expected.to[execution.evidence.coordinate.topology]
      : undefined;
  return observed.from === expected.from
    && observed.to === expectedTarget
    && (!expected.reasonRequired || observed.reasonRequired === true);
}

/** Closed oracle catalog. Each family compares independently produced evidence. */
export const DECLARATIVE_ORACLE_HANDLERS: OracleHandlers = Object.freeze({
  snapshot_exact: ({ expected, observed }) => (
    Array.isArray(expected)
    && Array.isArray(observed)
    && expected.every(isRecord)
    && observed.every(isRecord)
    && snapshotDigest(expected) === snapshotDigest(observed)
  ),
  event_present: ({ expected, observed }) => Array.isArray(observed) && observed.some((entry) => isDeepStrictEqual(entry, expected)),
  event_absent: ({ expected, observed, oracle, execution }) => (
    Array.isArray(observed)
    && hasSealedQuietWindow(execution, oracle.observed.producer)
    && !observed.some((entry) => isDeepStrictEqual(entry, expected))
  ),
  revision_monotonic: ({ observed }) => Array.isArray(observed) && observed.every((value, index) => typeof value === 'number' && (index === 0 || (typeof observed[index - 1] === 'number' && value > observed[index - 1]))),
  field_absent: ({ expected, observed }) => typeof expected === 'string' && isRecord(observed) && !Object.hasOwn(observed, expected),
  observer_identity: equality,
  fallback_identity: fallbackIdentity,
  transport_identity: equality,
  session_identity: equality,
  fault_witness: equality,
  cleanup_complete: equality,
  release_identity: equality,
  required_coordinate: equality,
});

/** Evaluates every declared oracle and fails closed for missing evidence. */
export function evaluateDeclarativeOracles({ definition, execution, handlers = DECLARATIVE_ORACLE_HANDLERS }: { definition: CaseDefinition; execution: Execution; handlers?: OracleHandlers }): Readonly<{ status: string; results: readonly Readonly<{ id: string; family: string; passed: boolean; reason: string | null; gate: string }>[] }> {
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
