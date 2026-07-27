import { isLoopbackMongoUri } from './synthetic-data.js';

const REQUIRED_DDP_EVENT_TYPES = ['added', 'changed', 'removed'];
const MAX_FAILURE_REASONS = 20;

function appendFailure(audit, reason, status = 'failed') {
  audit.status = audit.status === 'incomplete' ? 'incomplete' : status;
  audit.failure_reasons = [
    ...(audit.failure_reasons || []),
    reason,
  ].slice(0, MAX_FAILURE_REASONS);
}

/**
 * Resolves and validates the database target before the audit mutates app state.
 */
export function resolveAuditMongoTarget({
  benchMongoUri,
  meteorMongoUri,
  fallbackMongoUri,
  allowRemote,
}) {
  if (benchMongoUri && meteorMongoUri && benchMongoUri !== meteorMongoUri) {
    throw new Error('Audit BENCH_MONGO_URL and MONGO_URL must identify the same database');
  }
  const mongoUri = benchMongoUri || meteorMongoUri || fallbackMongoUri;
  if (!allowRemote && !isLoopbackMongoUri(mongoUri)) {
    throw new Error('Refusing non-loopback MongoDB target without --allow-remote-mongo');
  }
  const databaseName = mongoUri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/)?.[1];
  if (!databaseName) {
    throw new Error('Change-stream audit requires an explicit MongoDB database name');
  }
  return mongoUri;
}

/**
 * Binds workload assertions to independently observed Meteor and DDP evidence.
 */
export function finalizeAuditEvidence({
  audit,
  meteor,
  runtime,
  metrics,
  scriptFailed,
}) {
  audit.audited_meteor = meteor;
  audit.transport = runtime?.transport || null;
  audit.actual_driver = runtime?.observer_driver_actual;

  if (scriptFailed) appendFailure(audit, 'workload_process_failed', 'incomplete');
  if (audit.actual_driver !== audit.requested_driver) {
    appendFailure(audit, 'observer_driver_mismatch');
  }

  const fallbackMetric = metrics.driver_fallbacks;
  if (!fallbackMetric || fallbackMetric.no_fallback !== fallbackMetric.total_cursors) {
    appendFailure(
      audit,
      fallbackMetric ? 'publication_observer_fallback' : 'publication_observer_unverified',
    );
  }

  const hasTransportEvidence = REQUIRED_DDP_EVENT_TYPES.every((type) => (
    Number(metrics.ddp_messages?.by_type?.out?.[type]) > 0
    && Number(metrics.ddp_frame_size?.by_type_bytes?.out?.[type]) > 0
  ));
  if (!hasTransportEvidence || !audit.transport) {
    appendFailure(audit, 'transport_evidence_missing');
  }
  return audit;
}

/**
 * Creates persistable evidence when a strict workload emits no usable summary.
 */
export function createIncompleteAuditMetric({ requestedDriver, scriptFailed }) {
  return {
    schema_version: 1,
    status: 'incomplete',
    requested_driver: requestedDriver,
    failure_reasons: [
      ...(scriptFailed ? ['workload_process_failed'] : []),
      'workload_output_missing',
    ],
  };
}
