import { contractDigest } from '../contracts/digest.js';
import { validateNegativeControlResult } from '../contracts/release-audit.js';
import { DECLARATIVE_ORACLE_HANDLERS } from '../oracles/evaluator.js';
import {
  caseEvidenceStatus,
  logicalCoordinateStatus,
  recoveryEvidenceStatus,
  releaseIdentityStatus,
} from '../release-audit/aggregate.js';
import { RELEASE_CASE_CONTRACTS } from '../release-audit/capability-registry.js';

const PRODUCTION_GATES = Object.freeze({
  caseEvidenceStatus,
  logicalCoordinateStatus,
  recoveryEvidenceStatus,
  releaseIdentityStatus,
});

interface NegativeControl {
  readonly id: string;
  readonly expectedReason: string;
  readonly mutation: Readonly<{ kind: string }>;
}

interface DdpEvent {
  readonly sequence?: number;
  readonly message: Readonly<{
    msg?: string;
    fields?: Readonly<{ revision?: number }>;
    [key: string]: unknown;
  }>;
}

interface RuntimeRecord {
  readonly definition: Readonly<{
    id: string;
    oracles: readonly (Readonly<Record<string, unknown>> & Readonly<{
      id: string;
      family: string;
      expected: Readonly<Record<string, unknown>> & Readonly<{ kind: string; value?: unknown; stepId?: string; output?: string }>;
      observed: Readonly<Record<string, unknown>> & Readonly<{ producer: string; stepId: string; ledger: string }>;
      failureReason: string;
      gate: string;
    }>)[];
  }>;
  readonly execution: Readonly<{
    status: string;
    evidence: Readonly<{
      coordinate: Readonly<Record<string, unknown>>;
      outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      provenance?: Readonly<Record<string, Readonly<Record<string, string | undefined>> | undefined>>;
    }>;
    contextEvidence?: Readonly<{ ddpLedgers?: readonly (readonly Readonly<{ direction: string; sequence?: number; message: DdpEvent['message'] }>[])[] }>;
  }>;
  readonly result: Readonly<Record<string, unknown>> & Readonly<{
    status: string;
    observerEvidence: readonly (Readonly<Record<string, unknown>> & Readonly<{ fallbackFrom?: string }>)[];
    faultWitness?: unknown;
    release?: unknown;
  }>;
}

interface RecoveryEvidence {
  readonly runDocumentsRemoved: boolean;
  readonly topologyRestored: boolean;
  readonly profilerRestored: boolean;
  readonly networkRestored: boolean;
}

interface GateResult { readonly status?: string; readonly reasons?: readonly string[] }
interface ProductionGates {
  caseEvidenceStatus(result: unknown, contract: unknown): GateResult;
  logicalCoordinateStatus(attempts: readonly unknown[], contract: unknown): GateResult;
  recoveryEvidenceStatus(recovery: unknown): GateResult;
  releaseIdentityStatus(candidate: unknown, expected: unknown): GateResult;
}

interface MutationOutcome {
  readonly detected?: boolean;
  readonly actualReason?: string;
  readonly reason?: string;
  readonly evidence?: unknown;
}

function evaluateMutation(
  family: string,
  expected: unknown,
  observed: unknown,
  record: RuntimeRecord,
): boolean {
  const oracle = record.definition.oracles.find((entry) => entry.family === family);
  const handler = DECLARATIVE_ORACLE_HANDLERS[family];
  if (!oracle || !handler) return false;
  return handler({ expected, observed, oracle, execution: record.execution });
}

function incomingEvents(record: RuntimeRecord): DdpEvent[] {
  return record.execution.contextEvidence?.ddpLedgers?.flatMap((ledger) => ledger
    .filter(({ direction, message }) => direction === 'in'
      && typeof message.msg === 'string' && ['added', 'changed', 'removed'].includes(message.msg))
    .map(({ sequence, message }) => ({ ...(sequence === undefined ? {} : { sequence }), message }))) || [];
}

function recordFor(records: readonly RuntimeRecord[], predicate: (record: RuntimeRecord) => boolean): RuntimeRecord | undefined {
  return records.find((record) => record.result.status === 'passed' && predicate(record));
}

function oracleRecord(records: readonly RuntimeRecord[], family: string): RuntimeRecord | undefined {
  return recordFor(records, ({ definition }) => definition.oracles.some((oracle) => oracle.family === family));
}

function snapshotPair(record: RuntimeRecord): Readonly<{ expected: unknown; observed: unknown }> | null {
  const oracle = record.definition.oracles.find(({ family }) => family === 'snapshot_exact');
  if (!oracle) return null;
  return {
    expected: oracle.expected.stepId === undefined || oracle.expected.output === undefined
      ? undefined
      : record.execution.evidence.outputs[oracle.expected.stepId]?.[oracle.expected.output],
    observed: record.execution.evidence.outputs[oracle.observed.stepId]?.[oracle.observed.ledger],
  };
}

function alteredSnapshot(records: readonly RuntimeRecord[], kind: string): MutationOutcome | null {
  const record = oracleRecord(records, 'snapshot_exact');
  const pair = record && snapshotPair(record);
  if (!record || !Array.isArray(pair?.observed) || pair.observed.length === 0) return null;
  const observed = structuredClone(pair.observed);
  if (kind === 'alter_payload_byte') {
    const payload = String(observed[0].payload || '');
    observed[0].payload = `${payload.slice(0, -1)}${payload.endsWith('x') ? 'y' : 'x'}`;
  } else {
    observed.push(structuredClone(observed[0]));
  }
  return {
    detected: !evaluateMutation('snapshot_exact', pair.expected, observed, record),
    evidence: { caseId: record.definition.id, expected: pair.expected, observed },
  };
}

function eventMutation(records: readonly RuntimeRecord[], kind: string): MutationOutcome | null {
  const record = recordFor(records, (candidate) => incomingEvents(candidate).length > 0);
  if (!record) return null;
  const baseline = incomingEvents(record);
  const target = baseline.at(-1);
  if (!target) return null;
  const mutated = kind === 'drop_event'
    ? baseline.filter((entry) => entry !== target)
    : [...baseline, structuredClone(target)];
  const targetCount = (entries: readonly DdpEvent[]): number => entries.filter(({ message }) => (
    contractDigest(message) === contractDigest(target.message)
  )).length;
  return {
    detected: kind === 'drop_event' ? targetCount(mutated) < targetCount(baseline) : targetCount(mutated) > targetCount(baseline),
    evidence: { caseId: record.definition.id, baseline, mutated },
  };
}

function reorderedRevision(records: readonly RuntimeRecord[]): MutationOutcome | null {
  const record = recordFor(records, (candidate) => incomingEvents(candidate)
    .filter(({ message }) => Number.isSafeInteger(message.fields?.revision)).length >= 2);
  if (!record) return null;
  const revisions = incomingEvents(record)
    .map(({ message }) => message.fields?.revision)
    .filter((revision): revision is number => Number.isSafeInteger(revision));
  const mutated = [...revisions].reverse();
  return {
    detected: !evaluateMutation('revision_monotonic', undefined, mutated, record),
    evidence: { caseId: record.definition.id, revisions, mutated },
  };
}

function retainedField(records: readonly RuntimeRecord[]): MutationOutcome | null {
  const record = recordFor(records, ({ definition }) => definition.id === 'data.field_removal_no_stale_residue');
  const pair = record && snapshotPair(record);
  const document = Array.isArray(pair?.observed) ? pair.observed[0] : undefined;
  if (!record || !document || Object.hasOwn(document, 'ephemeral')) return null;
  const mutated = { ...document, ephemeral: 'retained-by-negative-control' };
  return {
    detected: !evaluateMutation('field_absent', 'ephemeral', mutated, record),
    evidence: { caseId: record.definition.id, observed: document, mutated },
  };
}

function substitutedOracle(records: readonly RuntimeRecord[], family: string, ledger: string, replacement: unknown): MutationOutcome | null {
  const record = oracleRecord(records, family);
  if (!record) return null;
  const oracle = record.definition.oracles.find((entry) => entry.family === family);
  if (!oracle) return null;
  const expected = oracle.expected.kind === 'literal'
    ? oracle.expected.value
    : oracle.expected.stepId === undefined || oracle.expected.output === undefined
      ? undefined
      : record.execution.evidence.outputs[oracle.expected.stepId]?.[oracle.expected.output];
  return {
    detected: !evaluateMutation(family, expected, replacement, record),
    evidence: { caseId: record.definition.id, ledger, expected, replacement },
  };
}

function rejectedBy(gateResult: GateResult, evidence: unknown): MutationOutcome {
  const actualReason = gateResult?.reasons?.[0];
  return {
    detected: gateResult?.status !== 'passed' && typeof actualReason === 'string',
    ...(actualReason === undefined ? {} : { actualReason }),
    evidence,
  };
}

function artifactMutation(records: readonly RuntimeRecord[], kind: string, gates: ProductionGates): MutationOutcome | null {
  if (kind === 'suppress_fallback_record') {
    const record = recordFor(records, ({ result }) => result.observerEvidence.some(({ fallbackFrom }) => fallbackFrom));
    if (!record) return null;
    const mutated = { ...structuredClone(record.result), observerEvidence: [] };
    return rejectedBy(
      gates.caseEvidenceStatus(mutated, RELEASE_CASE_CONTRACTS[record.definition.id]),
      { caseId: record.definition.id, observerEvidence: [] },
    );
  }
  if (kind === 'omit_fault_witness') {
    const record = recordFor(records, ({ result }) => result.faultWitness !== undefined);
    if (!record) return null;
    const mutated = Object.fromEntries(
      Object.entries(structuredClone(record.result)).filter(([key]) => key !== 'faultWitness'),
    );
    return rejectedBy(
      gates.caseEvidenceStatus(mutated, RELEASE_CASE_CONTRACTS[record.definition.id]),
      { caseId: record.definition.id, faultWitness: null },
    );
  }
  if (kind === 'omit_release_identity') {
    const record = records[0];
    if (!record) return null;
    return rejectedBy(
      gates.releaseIdentityStatus(undefined, record.result.release),
      { caseId: record.definition.id, release: null },
    );
  }
  return null;
}

function executeMutation(control: NegativeControl, context: Readonly<{
  records: readonly RuntimeRecord[];
  recovery?: RecoveryEvidence | null;
  gates: ProductionGates;
}>): MutationOutcome | null {
  const { records, recovery, gates } = context;
  switch (control.mutation.kind) {
    case 'drop_event': return { ...eventMutation(records, 'drop_event'), reason: 'ddp_event_missing' };
    case 'duplicate_event': return { ...eventMutation(records, 'duplicate_event'), reason: 'logical_event_duplicate' };
    case 'reorder_revision': return { ...reorderedRevision(records), reason: 'revision_not_monotonic' };
    case 'alter_payload_byte': return { ...alteredSnapshot(records, 'alter_payload_byte'), reason: 'content_digest_mismatch' };
    case 'retain_removed_field': return { ...retainedField(records), reason: 'stale_field_retained' };
    case 'substitute_observer': return { ...substitutedOracle(records, 'observer_identity', 'observer_selection', 'polling'), reason: 'observer_identity_mismatch' };
    case 'suppress_fallback_record': return artifactMutation(records, control.mutation.kind, gates);
    case 'substitute_session': return { ...substitutedOracle(records, 'session_identity', 'session_identity', 'fresh'), reason: 'session_identity_mismatch' };
    case 'duplicate_idempotent_effect': return { ...alteredSnapshot(records, 'duplicate_idempotent_effect'), reason: 'idempotency_violation' };
    case 'omit_fault_witness': return artifactMutation(records, control.mutation.kind, gates);
    case 'omit_release_identity': return artifactMutation(records, control.mutation.kind, gates);
    case 'remove_required_case': {
      const record = records[0];
      if (!record) return null;
      return rejectedBy(
        gates.logicalCoordinateStatus([], RELEASE_CASE_CONTRACTS[record.definition.id]),
        { caseId: record.definition.id, before: 1, after: 0 },
      );
    }
    case 'fail_restoration': {
      if (!recovery) return null;
      const mutatedState = {
        runDocumentsRemoved: recovery.runDocumentsRemoved,
        topologyRestored: false,
        profilerRestored: recovery.profilerRestored,
        networkRestored: recovery.networkRestored,
      };
      const mutated = { ...mutatedState, digest: contractDigest(mutatedState) };
      return rejectedBy(gates.recoveryEvidenceStatus(mutated), mutated);
    }
    default: return null;
  }
}

/** Runs every catalog negative control against evidence from this exact audit. */
export function runDeclarativeNegativeControls({
  controls, records, recovery, gates = PRODUCTION_GATES,
}: Readonly<{
  controls: readonly NegativeControl[];
  records: readonly RuntimeRecord[];
  recovery?: RecoveryEvidence | null;
  gates?: Partial<ProductionGates>;
}>) {
  const resolvedGates: ProductionGates = { ...PRODUCTION_GATES, ...gates };
  return Object.freeze(controls.map((control) => {
    const outcome = executeMutation(control, {
      records,
      gates: resolvedGates,
      ...(recovery === undefined ? {} : { recovery }),
    });
    const detected = outcome?.detected === true;
    return validateNegativeControlResult({
      controlId: control.id,
      expectedReason: control.expectedReason,
      actualReason: detected ? (outcome.actualReason || outcome.reason) : 'negative_control_not_detected',
      detected,
      evidenceDigest: contractDigest({
        controlId: control.id,
        mutation: control.mutation,
        source: outcome?.evidence || null,
      }),
    });
  }));
}
