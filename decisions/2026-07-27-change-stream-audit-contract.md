# Change-Stream Audit Contract

## Decision

Treat change-stream validation as a conformance audit rather than a benchmark.
The audit reuses the benchmark harness for process lifecycle, telemetry,
result persistence, and dashboard ingestion, but correctness evidence is the
only pass/fail authority. Latency and resource metrics are diagnostics.

The CLI is the execution entry point:

```text
node bench.js audit --profile <smoke|extreme>
                    --observer-driver <changeStreams|oplog>
```

The dashboard remains an evidence viewer.

## Rationale

A fast run can still lose, duplicate, reorder, coalesce, or corrupt reactive
state. Performance thresholds cannot establish feature support. A conformance
audit must state the exact feature set, exercise every supported item through a
lossless phase, validate transport and final state, and report anything not
proved as unsupported, fallback-only, or not exercised.

Direct MongoDB writes are required because they exercise the complete
MongoDB-to-observer-to-publication-to-DDP path. Meteor method writes alone can
include local notification behavior that is not representative of an external
writer.

## Contract

- Audit data uses the dedicated `reliabilityDocuments` collection.
- Every publication, write filter, read, and cleanup is scoped by a unique
  `runId`.
- Supported document operations are insert, `$set`, `$unset`, `$inc`, array
  mutation, replacement, and deletion.
- Each supported operation is applied first to a serialized conformance
  document. Every subscriber must receive and verify that state before the
  next operation begins.
- The remaining documents are mutated in bursts. DDP may coalesce
  intermediate current states, so burst event counts are diagnostic and exact
  final convergence is mandatory.
- Subscribers independently re-hash payload and structured fields. Final
  canonical document digests detect missing, stale, or unexpected fields.
- A passing audit requires the requested observer driver, no per-cursor
  fallback, complete DDP message/frame evidence, no duplicate or regressing
  events, no foreign-run data, and exact convergence for every subscriber.
- Result status is stored at `metrics.change_stream_audit.status`. A
  non-passing status is persisted for diagnosis and then produces a nonzero
  CLI exit.
- The capability registry records the Meteor contract source and review date.
  Unsupported and unexercised capabilities never imply conformance.

## Capability boundaries

Meteor change streams support unordered live-query observers whose selectors
can be compiled by `Minimongo.Matcher`. Ordered observers and unsupported
selectors are expected to use the next configured observer driver.

Collection DDL events, expanded events, and change-stream pre-images are
recorded as unsupported by the Meteor publication contract. The audit does not
perform destructive rename, drop, or drop-database operations to manufacture
those events.

## Safety

- The default MongoDB target must be loopback.
- A non-loopback target requires `--allow-remote-mongo`.
- MongoDB connection strings are never printed by the safety guard.
- Generated documents are checked against a conservative BSON size ceiling.
- Cleanup deletes only the current `runId`; the collection is never dropped.
- `smoke` is the bounded default. `extreme` requires explicit selection.

## Verification limits

Unit and static checks establish generator determinism, operation construction,
metric derivation, CLI mapping, schema compatibility, and dashboard build
integrity. They do not establish that a particular Meteor/MongoDB topology
passes the audit. That evidence exists only after running the CLI against the
specified Meteor source and database topology and retaining its result file.

The tracked fixture release is Meteor 3.5.1-beta.0, which includes the 3.5
Change Streams, pluggable DDP transport, and session-resumption line. The
actual driver, per-cursor fallback, transport, and content evidence remain
authoritative; the release label alone never establishes conformance.
