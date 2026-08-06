# Declarative audit case authority

Date: 2026-08-06

## Decision

Validated files under `reliability/definitions/` are the sole authoring
authority for change-stream audit capabilities, profiles, cases, and negative
controls. Both `audit` and `release-audit` compile those definitions and
execute them through the same closed interpreter and owned runtime.

The old script workload, operation matrix, audit-evidence finalizer, bounded
CRUD adapter, and benchmark scenario aliases are removed. Adding a case now
requires data-only contracts plus a trusted primitive implementation; a case
cannot inject selectors, updates, code, paths, endpoints, or environment
variables.

## Correctness invariants

- Every compiled plan binds the catalog, definition, coordinate, resolved
  parameters, interpreter, and step/evidence ledgers by SHA-256 digest.
- MongoDB mutations and the expected model are independent implementations.
- Cursor evidence is correlated by run, case, query, ordinal, fingerprint,
  Meteor instance, actual driver, and multiplexer identity.
- Concurrency groups start before their named barrier joins them; declared
  participant counts must match the actual group.
- Recovery gates prove the targeted Meteor driver lifecycle method is pending
  on every instance before the concurrent write proceeds.
- Fault recovery uses dedicated per-instance control-plane DDP connections so
  a paused subscription cannot deadlock its own restoration.
- Evidence sealing requires an event-stable quiet window and runs armed
  transport/fanout/convergence postconditions.
- Every negative control mutates evidence captured by the exact audit and its
  detector derives the observed reason independently from the authored
  expectation.
- Any missing case, producer, attestation, control, or restoration proof is
  incomplete; later attempts cannot erase an earlier failure.
- The bounded CLI persists the canonical dashboard result before returning a
  nonzero exit for failed or incomplete evidence.

## Recovery

Rollback is a code revert, not a runtime migration. Generated results remain
historical evidence. Each executor teardown validates its marker-attested
MongoDB members, Meteor process groups, proxy, run-scoped documents, and
network restoration; incomplete teardown prevents conformance.

## Validation evidence

- Root Node suite passed with 548 tests after the primitive hardening.
- The tasks fixture Meteor suite passed its server tests.
- The dashboard Meteor suite passed all 16 server contract tests.
- A live `event.update.set` case passed with subscriber revisions `0 → 1` and
  detected dropped, duplicated, reordered, and payload-corruption controls.
- A live `recovery.startup_snapshot_concurrent_writes` case passed across both
  Meteor instances with four correlated cursor observations and complete
  topology restoration.
