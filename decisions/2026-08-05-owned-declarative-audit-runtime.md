# Owned Declarative Audit Runtime

## Decision

The change-stream conformance audit will execute validated case documents only
through a closed, versioned interpreter. Distributed fault cases will run on a
repository-owned loopback topology consisting of a disposable three-member
MongoDB replica set, two isolated Meteor tool workspaces, and a terminating
HTTP/WebSocket audit proxy.

The harness must attest a target before mutating it. Replica-set process
identity is bound to an ownership marker containing the audit identity, owner
process, random token, ports, process IDs, and exact argv digests. Meteor
process faults and proxy connection faults can address only objects held by
their creating runtime. Remote MongoDB servers, arbitrary processes, and
arbitrary network endpoints are never valid fault targets.

## Why

Session resumption, non-sticky routing, primary elections, temporary database
interruptions, slow consumers, and frame fragmentation cannot be proved by a
single Meteor process connected to an operator-managed database. Simulating
their evidence would create a false conformance path. Owning the topology makes
fault activation, restoration, routing, and cleanup independently observable
without broadening the audit's external mutation boundary.

Running two Meteor tool processes in the same application tree is unsafe
because they share `.meteor/local`. Each instance therefore receives an owned
temporary copy that excludes mutable Meteor state and shares only the source
app's dependency directory. Both instances use the same owned replica set and
are reachable only through the audit proxy.

## Runtime invariants

- Definitions contain data only; no callbacks, commands, paths, environment
  maps, imports, or executable expressions are accepted.
- Every compiled step must resolve to a trusted registered primitive before
  the first side effect.
- Missing adapters, evidence, oracle handlers, or cleanup proof fail closed.
- Per-step and per-case deadlines are enforced by the interpreter even when a
  primitive fails to observe its abort signal.
- Cleanup runs after every execution outcome and unwinds environment resources
  in proxy, Meteor cluster, replica-set order.
- Evidence is bound to the contract, case definition, compiled plan,
  interpreter version, run, and exact coordinate by content digests.
- Per-cursor observer evidence carries `runId`, `caseExecutionId`, and Meteor
  instance identity and is readable only with the environment ownership token.
- Persisted evidence never includes ownership tokens, database URLs,
  repository paths, or process IDs.

## Recovery and abort conditions

Partial environment startup immediately unwinds every resource that was
successfully created. MongoDB processes receive a bounded graceful shutdown;
a successfully observed `SIGKILL` fallback counts as cleanup but remains a
diagnostic forced shutdown. Failure to observe process exit is a cleanup
failure.

The declarative executor must not replace the legacy audit command until the
runtime adapters produce all required independent evidence for every compiled
coordinate, every negative control demonstrates oracle sensitivity, and the
full live parity suite passes. Registry coverage alone is not conformance.

## Consequences

The infrastructure has a larger local resource footprint and requires the
selected Meteor tool's bundled `mongod`. In exchange, topology and transport
claims become reproducible, attributable, and safely faultable. New cases may
select only existing trusted primitives; introducing new behavior requires a
reviewed primitive or oracle implementation with sensitivity tests.
