# Release conformance authority

## Context

The bounded `audit` command proves a small CRUD and convergence contract. It
cannot establish the broader Meteor release claim covering observer fallback,
transport variants, session resumption, topology recovery, and fault handling.
A release label must therefore come from a separate authority that fails
closed when any declared coordinate or independent evidence source is absent.

## Decision

`release-audit` is the only command allowed to produce the release states
`conformant`, `non_conformant`, and `incomplete`.

The release authority consists of:

- strict runtime schemas for release, MongoDB, case, oracle, recovery,
  negative-control, progress, and manifest evidence;
- one versioned capability registry and deterministic coordinate resolver;
- immutable case attempts whose failures and incomplete outcomes cannot be
  erased by retries;
- exact release, fixture, package, harness, execution-environment, MongoDB,
  topology, observer, and transport identity requirements;
- capability-specific independent evidence producers;
- crash-consistent progress journals and root-contained atomic artifacts;
- canonical aggregation that reserves `conformant` for complete evidence;
- offline validation that revalidates every case, recomputes the aggregate,
  and reconciles the sealed progress journal.

The existing bounded CRUD workload is adapted into release evidence only for
the seven operations it independently proves. Every other declared capability
remains `incomplete` until its real case adapter and required oracle producers
exist. Missing adapters are not represented as passing or unsupported.

## Consequences

- The current release coordinator is useful as a complete gap detector but
  cannot yet emit `conformant`; this is intentional and safer than promoting
  the bounded audit.
- Adding a case requires implementing its real workload and every producer
  named by the case contract. A self-asserted passing oracle is insufficient.
- Fault cases require a fault-controller oracle cryptographically linked to
  activation and restoration witnesses.
- An unknown, dirty, mismatched, or unavailable identity cannot participate in
  a conformant aggregate.
- Dashboard execution must call this coordinator directly before the
  dashboard may describe a run as a release audit. The legacy bounded audit
  remains clearly labeled as bounded.
- Audit controls have no application-level API key. Audit-capable dashboard
  deployments must therefore use trusted network or platform access controls.

## Rejected alternatives

- Extending the schema-v1 bounded metric with a `conformant` label was
  rejected because unexercised capabilities would remain a false pass.
- Treating diagnostic latency, resource use, event counts, configured
  observer values, or release labels as correctness evidence was rejected.
- Allowing retries to overwrite failed or incomplete attempts was rejected
  because it would erase reliability evidence.
- Trusting manifest fields without recomputing the decision was rejected
  because a self-consistent forged artifact could otherwise appear valid.
