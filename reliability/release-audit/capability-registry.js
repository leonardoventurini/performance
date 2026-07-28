import { contractDigest } from '../contracts/digest.js';

export const RELEASE_CAPABILITY_CONTRACT_ID = 'meteor-3.5-release-conformance-v1';
export const RELEASE_CAPABILITY_REVIEWED_AT = '2026-07-27';

const METEOR_CHANGE_STREAMS_SOURCE =
  'https://docs.meteor.com/performance/change-streams-observer-driver';
const METEOR_DDP_SOURCE = 'https://docs.meteor.com/api/meteor.html#reconnection';
const METEOR_TRANSPORT_SOURCE =
  'https://docs.meteor.com/cli/environment-variables#ddp-transport';
const MONGO_CHANGE_STREAMS_SOURCE =
  'https://www.mongodb.com/docs/manual/administration/change-streams-production-recommendations/';
const SPEC_SOURCE = 'specs/2026-07-27-meteor-3.5-reliability-conformance-audit.md';

export const DEFAULT_OBSERVER_ORDER = Object.freeze(['changeStreams', 'oplog', 'polling']);
export const EXPLICIT_OPLOG_ORDER = Object.freeze(['oplog', 'changeStreams', 'polling']);
export const DIRECT_FALLBACK_ORDER = Object.freeze(['changeStreams', 'polling']);

const REPLICA_REFERENCE = Object.freeze([{
  topologies: ['replica_set'],
  transports: ['sockjs'],
  observerOrders: [DEFAULT_OBSERVER_ORDER],
}]);
const BOTH_TRANSPORTS = Object.freeze([{
  topologies: ['replica_set'],
  transports: ['sockjs', 'uws'],
  observerOrders: [DEFAULT_OBSERVER_ORDER],
}]);

function definition({
  id,
  expectation = 'supported',
  requiredCases = [id],
  applicability = REPLICA_REFERENCE,
  source,
  rationale,
}) {
  return Object.freeze({
    id,
    expectation,
    requiredCases: Object.freeze([...requiredCases]),
    applicability: Object.freeze(applicability.map((entry) => Object.freeze({
      topologies: Object.freeze([...entry.topologies]),
      transports: Object.freeze([...entry.transports]),
      observerOrders: Object.freeze(entry.observerOrders.map((order) => Object.freeze([...order]))),
    }))),
    source,
    rationale,
  });
}

const OBSERVER_CAPABILITY_IDS = [
  'observer.default_order.change_streams_first',
  'observer.explicit_order.change_streams_first',
  'observer.unordered_cursor.selected',
  'snapshot.empty',
  'snapshot.non_empty',
  'event.insert',
  'event.update.set',
  'event.update.unset',
  'event.update.increment',
  'event.update.array',
  'event.replace',
  'event.delete',
  'selector.remains_matching',
  'selector.enters_result',
  'selector.leaves_result',
  'selector.irrelevant_update_suppressed',
  'projection.field_added',
  'projection.field_changed',
  'projection.field_removed',
  'projection.nested_field_changed',
  'projection.object_id_preserved',
  'publication.multiple_projections_merge',
  'observer.identical_queries_share_multiplexer',
  'observer.distinct_queries_isolated',
  'observer.stop_releases_handle',
  'publication.ready_snapshot_consistent',
  'write_fence.normal_read_your_writes',
  'write_fence.catchup_timeout_eventual_convergence',
];

const DATA_CAPABILITY_IDS = [
  'data.ascii_and_empty_strings',
  'data.unicode_composed_decomposed',
  'data.right_to_left_text',
  'data.emoji_surrogate_boundaries',
  'data.ejson_scalars',
  'data.dates',
  'data.object_ids',
  'data.binary',
  'data.object_shapes',
  'data.array_shapes',
  'data.compressible_payload',
  'data.seeded_incompressible_payload',
  'data.near_bson_ceiling',
  'data.field_removal_no_stale_residue',
  'data.replacement_no_stale_residue',
  'data.concurrent_distinct_fields',
  'data.hot_key',
  'data.identical_projected_state',
];

const TRANSPORT_CAPABILITY_IDS = [
  'transport.connection_negotiation',
  'transport.publication_readiness',
  'transport.event_delivery',
  'transport.frame_message_byte_evidence',
  'transport.ejson_round_trip',
  'transport.payload_512_kib',
  'transport.payload_near_ceiling',
  'transport.raw_socket_fragmentation',
  'transport.slow_consumer_convergence',
  'transport.abrupt_socket_loss',
  'transport.concurrent_subscriber_fanout',
  'transport.bounded_reconnect_storm',
  'transport.clean_client_shutdown',
  'transport.clean_server_shutdown',
];

const SESSION_CAPABILITY_IDS = [
  'session.resume.within_grace_period',
  'session.resume.subscription_preserved',
  'session.resume.inflight_method_replayed',
  'session.resume.auth_context_preserved',
  'session.resume.grace_expired',
  'session.resume.queue_boundary',
  'session.resume.hot_code_push',
  'session.resume.sticky_instance',
  'session.resume.non_sticky_instance',
  'session.resume.concurrent_storm',
];

const RECOVERY_CAPABILITY_IDS = [
  'recovery.change_stream_unexpected_close',
  'recovery.change_stream_recoverable_error',
  'recovery.change_stream_repeated_restart',
  'recovery.mongodb_primary_step_down',
  'recovery.replica_set_election',
  'recovery.temporary_meteor_mongo_interruption',
  'recovery.writes_continue',
  'recovery.ddp_client_disconnected',
  'recovery.startup_snapshot_concurrent_writes',
  'recovery.watch_setup_concurrent_writes',
  'recovery.stream_restart_concurrent_writes',
  'recovery.catchup_timeout_eventual_convergence',
];

const OUT_OF_SCOPE_CAPABILITIES = [
  ['mongodb.collection_rename_drop_invalidate',
    'Collection lifecycle and invalidate events are outside the declared Meteor publication surface.'],
  ['mongodb.database_drop',
    'Database-drop behavior is outside the declared Meteor publication surface.'],
  ['mongodb.expanded_events',
    'Expanded Change Stream events are not exposed by the declared Meteor publication surface.'],
  ['mongodb.change_stream_pre_images',
    'Change Stream pre-images are not exposed by the declared Meteor publication surface.'],
];

const fallbackDefinitions = [
  definition({
    id: 'fallback.ordered_observer',
    expectation: 'fallback_required',
    applicability: REPLICA_REFERENCE,
    source: METEOR_CHANGE_STREAMS_SOURCE,
    rationale: 'Ordered observers must select polling and preserve content integrity.',
  }),
  ...['skip', 'limit', 'unsupported_selector'].map((suffix) => definition({
    id: `fallback.${suffix}`,
    expectation: 'fallback_required',
    applicability: REPLICA_REFERENCE,
    source: METEOR_CHANGE_STREAMS_SOURCE,
    rationale: `The ${suffix} query shape must select polling and preserve content integrity.`,
  })),
  definition({
    id: 'fallback.change_stream_unavailable',
    expectation: 'fallback_required',
    applicability: [
      {
        topologies: ['replica_set'],
        transports: ['sockjs'],
        observerOrders: [DEFAULT_OBSERVER_ORDER],
      },
      {
        topologies: ['standalone'],
        transports: ['sockjs'],
        observerOrders: [DEFAULT_OBSERVER_ORDER],
      },
    ],
    source: METEOR_CHANGE_STREAMS_SOURCE,
    rationale: 'Unavailable Change Streams select oplog on a replica set and polling on standalone.',
  }),
  definition({
    id: 'fallback.configured_order',
    expectation: 'fallback_required',
    applicability: [{
      topologies: ['replica_set'],
      transports: ['sockjs'],
      observerOrders: [EXPLICIT_OPLOG_ORDER],
    }],
    source: METEOR_CHANGE_STREAMS_SOURCE,
    rationale: 'The selected driver must honor the exact configured preference order.',
  }),
];

/**
 * Immutable, source-backed capability registry for the Meteor 3.5 claim.
 *
 * Prose requirements receive stable identifiers here so none can disappear
 * merely because the original specification described them as bullets.
 */
export const RELEASE_CAPABILITY_REGISTRY = Object.freeze([
  ...OBSERVER_CAPABILITY_IDS.map((id) => definition({
    id,
    source: METEOR_CHANGE_STREAMS_SOURCE,
    rationale: 'Required observer or publication semantic in the Meteor 3.5 release claim.',
  })),
  ...fallbackDefinitions,
  ...DATA_CAPABILITY_IDS.map((id) => definition({
    id,
    source: SPEC_SOURCE,
    rationale: 'Required deterministic BSON/EJSON integrity case.',
  })),
  ...TRANSPORT_CAPABILITY_IDS.map((id) => definition({
    id,
    applicability: BOTH_TRANSPORTS,
    source: METEOR_TRANSPORT_SOURCE,
    rationale: 'Required transport-integrity behavior over every claimed DDP transport.',
  })),
  ...SESSION_CAPABILITY_IDS.map((id) => definition({
    id,
    applicability: BOTH_TRANSPORTS,
    source: METEOR_DDP_SOURCE,
    rationale: 'Required DDP session-resumption or fresh-session recovery behavior.',
  })),
  ...RECOVERY_CAPABILITY_IDS.map((id) => definition({
    id,
    source: MONGO_CHANGE_STREAMS_SOURCE,
    rationale: 'Required witnessed Change Stream or topology recovery behavior.',
  })),
  ...OUT_OF_SCOPE_CAPABILITIES.map(([id, rationale]) => definition({
    id,
    expectation: 'out_of_scope',
    requiredCases: [],
    applicability: [],
    source: SPEC_SOURCE,
    rationale,
  })),
]);

export const RELEASE_CAPABILITY_CONTRACT_DIGEST = contractDigest({
  id: RELEASE_CAPABILITY_CONTRACT_ID,
  reviewedAt: RELEASE_CAPABILITY_REVIEWED_AT,
  capabilities: RELEASE_CAPABILITY_REGISTRY,
});

/**
 * Exact observer/fault expectations used by fail-closed aggregation.
 */
export const RELEASE_CASE_CONTRACTS = Object.freeze(Object.fromEntries(
  RELEASE_CAPABILITY_REGISTRY.flatMap((capability) => capability.requiredCases.map((caseId) => {
    let expectedDriver = 'changeStreams';
    let fallbackFrom;
    if (capability.expectation === 'fallback_required') {
      expectedDriver = capability.id === 'fallback.configured_order'
        ? 'oplog'
        : 'polling';
      fallbackFrom = capability.id === 'fallback.configured_order' ? undefined : 'changeStreams';
    }
    return [caseId, Object.freeze({
      caseId,
      expectation: capability.expectation,
      ...(capability.id === 'fallback.change_stream_unavailable'
        ? {
          expectedDriverByTopology: Object.freeze({
            replica_set: 'oplog',
            standalone: 'polling',
          }),
        }
        : { expectedDriver }),
      ...(fallbackFrom ? { fallbackFrom } : {}),
      requiresFault: capability.id.startsWith('recovery.'),
    })];
  })),
));

export const REQUIRED_NEGATIVE_CONTROLS = Object.freeze([
  ['ddp_changed_event_dropped', 'ddp_event_missing'],
  ['logical_event_duplicated', 'logical_event_duplicate'],
  ['revision_reordered', 'revision_not_monotonic'],
  ['payload_byte_altered', 'content_digest_mismatch'],
  ['removed_field_retained', 'stale_field_retained'],
  ['configured_observer_substituted', 'observer_identity_mismatch'],
  ['fallback_record_suppressed', 'fallback_evidence_missing'],
  ['new_session_claimed_resumed', 'session_identity_mismatch'],
  ['idempotent_effect_duplicated', 'idempotency_violation'],
  ['fault_witness_omitted', 'fault_witness_missing'],
  ['release_identity_omitted', 'release_identity_missing'],
  ['nonzero_process_passing_json', 'workload_process_failed'],
  ['required_case_removed', 'required_coordinate_missing'],
  ['restoration_failed', 'recovery_incomplete'],
].map(([controlId, expectedReason]) => Object.freeze({ controlId, expectedReason })));

export const NEGATIVE_CONTROL_CONTRACT_DIGEST = contractDigest(REQUIRED_NEGATIVE_CONTROLS);
