import crypto from 'node:crypto';
import { contractDigest } from '../contracts/digest.js';
import { validateAuditCaseResult } from '../contracts/release-audit.js';

export const BOUNDED_CRUD_CASES = Object.freeze({
  'event.insert': 'insert',
  'event.update.set': 'update.set',
  'event.update.unset': 'update.unset',
  'event.update.increment': 'update.increment',
  'event.update.array': 'update.array',
  'event.replace': 'replace',
  'event.delete': 'delete',
});

function oracle({ oracleId, producer, evidence, assertions, passed, failure }) {
  return {
    oracleId,
    producer,
    digest: contractDigest(evidence),
    assertions,
    passed,
    failures: passed ? [] : [failure],
  };
}

/** Converts a bounded CRUD audit result into one strict release case artifact. */
export function buildBoundedCrudCaseResult({
  coordinate,
  release,
  benchmarkResult,
  attemptId = crypto.randomUUID(),
}) {
  const operationId = BOUNDED_CRUD_CASES[coordinate.caseId];
  if (!operationId) throw new TypeError(`No bounded CRUD adapter for ${coordinate.caseId}`);
  const audit = benchmarkResult?.metrics?.change_stream_audit;
  const evidence = audit?.release_evidence;
  const capability = audit?.capabilities?.find(({ id }) => id === operationId);
  if (!audit || !evidence?.mongo_identity) {
    throw new TypeError('Bounded CRUD result is missing release evidence');
  }
  const subscriberDigests = evidence.subscriber_final_state_digests || [];
  const mongoPassed = evidence.mongo_final_state_digest === evidence.expected_final_state_digest;
  const ddpPassed = subscriberDigests.length === audit.subscribers
    && subscriberDigests.every((entry) => entry === evidence.mongo_final_state_digest);
  const driverMetric = benchmarkResult.metrics.driver_fallbacks;
  const observerPassed = benchmarkResult.runtime?.observer_driver_actual === 'changeStreams'
    && driverMetric?.total_cursors > 0
    && driverMetric.no_fallback === driverMetric.total_cursors;
  const transportPassed = benchmarkResult.runtime?.transport === coordinate.transport;
  const capabilityPassed = capability?.audit_status === 'passed';
  const passed = audit.status === 'passed'
    && capabilityPassed
    && mongoPassed
    && ddpPassed
    && observerPassed
    && transportPassed;
  const reasons = [
    ...(!capabilityPassed ? ['capability_transition_failed'] : []),
    ...(!mongoPassed ? ['mongodb_snapshot_mismatch'] : []),
    ...(!ddpPassed ? ['ddp_snapshot_mismatch'] : []),
    ...(!observerPassed ? ['observer_identity_mismatch'] : []),
    ...(!transportPassed ? ['transport_identity_mismatch'] : []),
  ];

  return validateAuditCaseResult({
    schemaVersion: 2,
    coordinate,
    attemptId,
    status: passed ? 'passed' : 'failed',
    release,
    mongo: evidence.mongo_identity,
    observerEvidence: [{
      cursorId: `bounded-crud-${coordinate.transport}`,
      requestedOrder: coordinate.observerOrder,
      actualDriver: benchmarkResult.runtime.observer_driver_actual,
    }],
    oracles: [
      oracle({
        oracleId: 'mongodb-final-snapshot',
        producer: 'mongodb',
        evidence: {
          expected: evidence.expected_final_state_digest,
          actual: evidence.mongo_final_state_digest,
        },
        assertions: 1,
        passed: mongoPassed,
        failure: 'mongodb_snapshot_mismatch',
      }),
      oracle({
        oracleId: 'ddp-final-snapshots',
        producer: 'ddp_client',
        evidence: subscriberDigests,
        assertions: audit.subscribers,
        passed: ddpPassed,
        failure: 'ddp_snapshot_mismatch',
      }),
      oracle({
        oracleId: 'meteor-observer-selection',
        producer: 'meteor_probe',
        evidence: {
          actual: benchmarkResult.runtime.observer_driver_actual,
          fallback: driverMetric,
        },
        assertions: driverMetric?.total_cursors || 0,
        passed: observerPassed,
        failure: 'observer_identity_mismatch',
      }),
    ],
    diagnostics: {
      propagation: {
        p50Ms: audit.propagation_p50,
        p95Ms: audit.propagation_p95,
        p99Ms: audit.propagation_p99,
      },
      volumes: {
        observedEvents: audit.observed_events,
        generatedBytes: audit.generated_bytes,
      },
    },
    reasons,
  });
}
