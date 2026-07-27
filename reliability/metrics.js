function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function summarizeReliability({
  profile,
  seed,
  requestedDriver,
  actualDriver,
  completed,
  subscribers,
  documents,
  mutations,
  payloadBytes,
  writes,
  observedEvents,
  duplicateEvents,
  outOfOrderEvents,
  foreignEvents,
  convergedSubscribers,
  timedOutSubscribers,
  finalStateMismatches,
  digestMismatches,
  latencies,
  failureReasons = [],
}) {
  const sorted = [...latencies].sort((left, right) => left - right);
  const average = sorted.length === 0
    ? 0
    : sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const failures = [
    ...failureReasons,
    ...(!completed ? ['workload_incomplete'] : []),
    ...(actualDriver !== requestedDriver ? ['observer_driver_mismatch'] : []),
    ...(convergedSubscribers !== subscribers ? ['subscriber_convergence_failed'] : []),
    ...(finalStateMismatches > 0 ? ['final_state_mismatch'] : []),
    ...(digestMismatches > 0 ? ['payload_digest_mismatch'] : []),
    ...(duplicateEvents > 0 ? ['duplicate_transport_event'] : []),
    ...(outOfOrderEvents > 0 ? [`${outOfOrderEvents} out-of-order events`] : []),
    ...(foreignEvents > 0 ? [`${foreignEvents} foreign-run events`] : []),
    ...(timedOutSubscribers > 0 ? ['subscriber_timeout'] : []),
  ];

  return {
    metric: 'change_stream_audit',
    schema_version: 1,
    profile,
    seed,
    requested_driver: requestedDriver,
    actual_driver: actualDriver,
    subscribers,
    documents,
    mutations_per_document: mutations,
    payload_bytes: payloadBytes,
    generated_bytes: documents * payloadBytes * (mutations + 1),
    writes,
    observed_events: observedEvents,
    duplicate_events: duplicateEvents,
    out_of_order_events: outOfOrderEvents,
    foreign_events: foreignEvents,
    converged_subscribers: convergedSubscribers,
    timed_out_subscribers: timedOutSubscribers,
    final_state_mismatches: finalStateMismatches,
    digest_mismatches: digestMismatches,
    propagation_min_ms: round(sorted[0] ?? 0),
    propagation_avg_ms: round(average),
    propagation_p50: round(percentile(sorted, 50)),
    propagation_p95: round(percentile(sorted, 95)),
    propagation_p99: round(percentile(sorted, 99)),
    propagation_max_ms: round(sorted.at(-1) ?? 0),
    status: completed ? (failures.length === 0 ? 'passed' : 'failed') : 'incomplete',
    failure_reasons: failures.slice(0, 20),
  };
}
