# Meteor Change-Stream Conformance Audit

## Problem

The existing scenarios measure throughput and resource use, but they do not
prove that every expected reactive change reaches every subscriber or that all
subscribers converge after an adversarial write sequence. A performance result
can therefore look healthy while hiding missed, duplicated, reordered, or
corrupted live updates.

The dashboard is an evidence viewer, not an execution environment. Audits
should start from the CLI and publish the same result envelope
as other scenarios so they appear in the dashboard without a second ingestion
path.

## Goals

- Provide a dedicated `audit` CLI flow with `smoke` and `extreme`
  profiles.
- Exercise the real Meteor publication path using writes made through the
  MongoDB driver, rather than only through Meteor methods.
- Run against either `changeStreams` or `oplog` observer selection and record
  the configured and actual observer driver already exposed by the harness.
- Generate deterministic, adversarial documents that are much larger and more
  structurally varied than normal task data.
- Audit a declared feature set and distinguish passed, failed, unsupported,
  fallback-expected, and not-exercised capabilities.
- Fail the run when observer selection, transport integrity, serialized
  feature delivery, or final-state correctness is violated.
- Preserve the standard result envelope and add one `change_stream_audit` metric
  family for dashboard rendering.

## Non-goals

- Calling a hosted language model during a benchmark. Network availability,
  model drift, cost, and nondeterministic output would make results
  irreproducible.
- Testing MongoDB documents at or above the 16 MiB BSON limit.
- Mutating the normal task collection.
- Silently permitting destructive cleanup against an arbitrary remote
  database.

## Execution interface

```text
node bench.js audit \
  [--profile smoke|extreme] \
  [--observer-driver changeStreams|oplog] \
  [--seed <integer>] \
  [--allow-remote-mongo]
```

`smoke` is the default and is suitable for validating setup and CI. `extreme`
must be selected explicitly and uses larger documents, more subscribers, and
burstier mutations.

The command resolves to a reliability scenario and uses the normal source,
application, collector, result-writing, and history paths. The observer choice
is passed to Meteor through `METEOR_REACTIVITY_ORDER`. Selecting `oplog` also
requires a valid oplog configuration; the recorded
`runtime.observer_driver_actual` remains the source of truth.

## Capability and workload contract

The audit maintains an explicit capability registry based on Meteor's
change-stream live-query contract. Supported document events are exercised
through insert, `$set`, `$unset`, `$inc`, array mutation, replacement, and
deletion. Ordered observers and selectors that Minimongo cannot compile are
declared as fallback cases. Collection DDL, expanded events, and pre-images are
declared unsupported because Meteor publications do not expose those MongoDB
change-stream features as document-level live-query events.

Each supported operation first runs against a serialized conformance document.
The next operation is not issued until every subscriber proves receipt and
content integrity. The same operation is then applied in bursts to the
remaining documents; intermediate burst states may coalesce, so exact final
convergence is the burst oracle.

Reliability data lives in `reliabilityDocuments` and every document is scoped
by a cryptographically unique `runId`.

Each generated document contains:

- a stable string `_id`;
- `runId`, sequence number, and revision;
- a deterministic payload generated from a seeded pseudo-random stream;
- nested, Unicode, repeated, and high-cardinality fields;
- a payload digest used to verify subscriber state.

The generator is “AI-designed” in the sense that it encodes adversarial data
shapes selected to stress serialization, diffing, and observer delivery. It is
implemented locally and deterministically so identical inputs produce
identical documents and comparable results.

The workload:

1. Creates DDP subscribers and subscribes each to the run-scoped publication.
2. Inserts documents directly through the MongoDB driver in bounded bursts.
3. Applies revisioned updates with changed field shapes and payload sizes.
4. Removes a deterministic subset of documents.
5. Waits for every subscriber to converge on the expected final state.
6. Removes only documents bearing the current `runId`.

## Correctness invariants

- No subscriber observes a revision lower than the last revision it observed
  for the same document.
- Every subscriber reaches the exact expected final set of document IDs,
  revisions, and payload digests before the deadline.
- No document from another run is published to a subscriber.
- Cleanup selectors always include the current `runId`.
- Workload configuration is finite, positive, and bounded below MongoDB's
  document-size limit.
- Burst phases may legally coalesce intermediate DDP states. Per-update event
  counts are diagnostic; exact final convergence is the correctness oracle.
- A reliability result is successful only when final-state and ordering
  correctness counters are zero.
- The recorded actual observer driver must match the requested driver; a
  fallback is a failed reliability run, not a successful run with a warning.

## Metric contract

`metrics.change_stream_audit` contains:

- profile, seed, requested driver, subscriber/document/mutation counts;
- generated payload and BSON byte counts;
- insert, update, and removal counts;
- observed event count;
- out-of-order event count;
- foreign-document event count;
- subscribers converged and subscribers timed out;
- propagation latency min, average, p50, p95, p99, and max;
- a per-feature support and audit-evidence matrix;
- final status and a bounded list of failure reasons.

Raw generated content and unbounded event traces are never stored in result
files.

## Safety and recovery

- The default MongoDB target must be loopback.
- A non-loopback target requires `--allow-remote-mongo`.
- Cleanup is run-scoped and executes in `finally`, including failed runs.
- Profile limits keep individual documents below a conservative BSON ceiling
  and cap total operation count.
- The script has explicit readiness, propagation, and process deadlines.
- Interrupting the process may leave only run-scoped documents in the
  dedicated collection; the next operator can remove them by `runId` without
  touching application data.

## Verification

- Unit tests cover seeded generation, validation, URI safety, event accounting,
  convergence, percentile summaries, CLI option mapping, driver error
  propagation, and the result-key contract.
- Existing root tests and syntax checks must remain green.
- The dashboard build and CSS consistency check must remain green.
- A live smoke run against each observer driver is required when the Meteor CLI
  and the corresponding MongoDB topology are available.
