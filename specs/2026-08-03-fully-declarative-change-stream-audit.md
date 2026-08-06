# Fully Declarative Change-Stream Audit Cases

## Status

Implemented in the direct rollout on `feat/reliability`. Root and application
contract suites plus representative live event and recovery coordinates are
verified; the final full live smoke execution remains a release-evidence gate,
not a prerequisite for loading or compiling the catalog.

This specification refines the execution architecture in
`2026-07-27-meteor-3.5-reliability-conformance-audit.md`. It does not weaken
that document's release claim, evidence requirements, negative controls, or
fail-closed result states.

## Goal and scope

Make every executable change-stream audit case a validated data contract. A
case definition must declare its applicability, bounded inputs, fixture,
ordered actions, convergence checkpoints, evidence requirements, oracles,
diagnostics, deadlines, faults, and cleanup without embedding JavaScript
callbacks or relying on identifier naming conventions.

After this rollout, adding a case that can be expressed with existing
primitives and oracle families requires only:

1. one declarative case document;
2. capability-to-case references; and
3. contract and behavioral fixtures proving the new definition.

Adding a genuinely new operation, evidence producer, oracle family, or fault
controller still requires a trusted implementation and tests. Treating
arbitrary new behavior as data-only would either be false or create an unsafe
embedded programming language.

The direct rollout includes:

- the bounded `audit` command and the release-level `release-audit` command;
- all supported and fallback-required capabilities in the release capability
  registry;
- declarative smoke and extreme profiles;
- declarative negative controls;
- a compiler, deterministic plan, interpreter, evidence producers, and result
  assembler;
- removal of the imperative workload sequence, mutation rotation, bounded CRUD
  adapter, prefix-derived case policy, and silent executor support filtering;
- preservation of the canonical benchmark result envelope and
  `metrics.change_stream_audit` public paths.

This specification does not make benchmark scenarios outside the
change-stream audit declarative, add arbitrary shell execution, allow browsers
to provide paths or environment maps, expand the remote-database trust
boundary, or change the source-backed capability claim.

## Definition of fully declarative

A case is fully declarative when the normalized case document is the complete
authority for what the harness executes and evaluates. The document selects
only versioned, allowlisted primitives and oracle families. It cannot contain
functions, executable expressions, dynamic imports, raw commands, arbitrary
paths, raw environment maps, unbounded interpolation, or self-asserted
evidence.

The trusted runtime remains imperative by necessity, but its behavior is a
closed interpreter:

```text
capability catalog + case catalog + profiles + negative controls
                              |
                              v
                   validate and canonicalize
                              |
                              v
                     compile exact plans
                              |
                              v
       provision -> interpret -> observe -> evaluate -> clean up
                              |
                              v
                  immutable case artifacts
                              |
                              v
                    fail-closed aggregation
```

No execution path may dispatch on a case identifier prefix or special-case a
case identifier. Identifiers are stable identities only; declared types and
contracts carry semantics.

## Evidence and current gaps

The repository already has a declarative capability catalog and applicability
matrix, but execution is only partially declarative:

- `reliability/release-audit/capability-registry.js` declares capability IDs,
  required cases, applicability, and expectations, but derives case evidence
  rules from prefixes such as `recovery.`, `transport.`, and `session.`.
- `reliability/release-audit/matrix.js` expands capability applicability into
  coordinates without proving that an executable definition exists.
- `cli/release-audit.js` owns an imperative seven-case whitelist and silently
  declines unsupported coordinates through `executeCase.supports`.
- `reliability/release-audit/coordinator.js` skips declined coordinates; only
  later aggregation reveals them as missing.
- `tests/reliability-change-streams.js` hardcodes subscription setup, write
  order, waits, model transitions, convergence, and cleanup.
- `reliability/operation-matrix.js` cycles update behavior by revision number,
  so the named operation is not itself an independently executable case.
- `reliability/cases/bounded-crud.js` projects seven logical case artifacts
  from a shared transport-wide run and common final snapshots, weakening
  isolation and attribution.
- `reliability/release-audit/aggregate.js` evaluates explicit evidence but has
  no attestation of the case-definition or interpreter semantics that produced
  it.

The main uncertainty is whether a general transition model can express
selector, projection, session, and recovery behavior without sharing the same
bug between workload generation and expected truth. The design addresses this
by separating the deterministic expected-state model from MongoDB and DDP
canonicalizers, requiring producer-independent evidence, and mutation-testing
every oracle family.

## Risk and assurance

Risk is high because a false pass could support an invalid distributed-data
integrity or release-readiness claim. Compile errors, unknown primitives,
missing definitions, invalid references, unavailable coordinates, absent
evidence, and unverified cleanup therefore produce `incomplete` or abort
before side effects; they never produce `passed`.

The rollout is a replacement, not a compatibility mode. There is no runtime
feature flag and no parallel legacy executor after completion. The existing
imperative audit remains the comparison oracle during implementation, then is
deleted only after live parity and sensitivity checks pass in the same
rollout.

## Contract graph

The audit contract is one closed, versioned graph:

- `CapabilityDefinitionV2` says what behavior is claimed and which cases prove
  it.
- `CaseDefinitionV1` says exactly how one logical case is executed and what
  evidence proves it.
- `AuditProfileV1` supplies bounded workload parameters.
- `NegativeControlDefinitionV1` says how sealed evidence is mutated and which
  oracle failure must detect it.
- `PrimitiveCatalogVersion`, `OracleCatalogVersion`, and
  `InterpreterVersion` bind data semantics to trusted code.
- `AuditContractManifestV2` canonicalizes and digests the complete graph.

Every persisted case result records the exact contract and compiled-plan
digests. The release manifest digest covers capability definitions, case
definitions, profiles, negative controls, primitive semantics, oracle
semantics, and interpreter version.

## Typed definitions

The examples below define the durable shape. Implementation may remain Node
24 ESM JavaScript, but it must expose matching JSDoc types and strict runtime
validators that reject unknown fields at every data and persistence boundary.

```ts
type SchemaVersion = 1;
type CaseId = string;
type StepId = string;
type OracleId = string;
type Producer =
  | "expected_model"
  | "mongodb"
  | "ddp_client"
  | "meteor_probe"
  | "fault_controller";

interface CaseDefinitionV1 {
  readonly schemaVersion: SchemaVersion;
  readonly id: CaseId;
  readonly title: string;
  readonly source: string;
  readonly rationale: string;
  readonly applicability: readonly CaseApplicability[];
  readonly parameters: Readonly<Record<string, ParameterDefinition>>;
  readonly fixture: FixtureDefinition;
  readonly preconditions: readonly PreconditionDefinition[];
  readonly steps: readonly StepDefinition[];
  readonly evidence: EvidenceContract;
  readonly oracles: readonly OracleDefinition[];
  readonly diagnostics: readonly DiagnosticDefinition[];
  readonly cleanup: CleanupDefinition;
  readonly budget: ResourceBudget;
  readonly sharing: "isolated";
}

type ParameterDefinition =
  | {
      readonly type: "integer";
      readonly default: number;
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly type: "enum";
      readonly default: string;
      readonly values: readonly string[];
    }
  | {
      readonly type: "boolean";
      readonly default: boolean;
    };

interface FixtureDefinition {
  readonly collection: "reliabilityDocuments";
  readonly publication: "reliability.documents";
  readonly generator: "synthetic-document-v1";
  readonly subscribers: ValueRef;
  readonly documents: ValueRef;
  readonly payloadBytes: ValueRef;
}

interface EvidenceContract {
  readonly requiredProducers: readonly Producer[];
  readonly observer: ObserverExpectation;
  readonly transportIdentity: "required" | "diagnostic";
  readonly fault: FaultExpectation | null;
  readonly ledgers: readonly EvidenceLedgerKind[];
}

type ObserverExpectation =
  | { readonly kind: "selected"; readonly driver: ObserverDriverRef }
  | {
      readonly kind: "fallback";
      readonly from: ObserverDriver;
      readonly to: ObserverDriver | Readonly<Record<MongoTopology, ObserverDriver>>;
      readonly reasonRequired: true;
    };

interface ResourceBudget {
  readonly maximumSteps: number;
  readonly maximumDocuments: number;
  readonly maximumSubscribers: number;
  readonly maximumPayloadBytes: number;
  readonly maximumEvidenceEntries: number;
  readonly stepTimeoutMs: number;
  readonly caseTimeoutMs: number;
  readonly maximumRetries: 0 | 1;
}
```

`sharing` is fixed to `isolated` in version 1. Shared transport-wide runs are
not permitted because they blur evidence attribution. A future schema may add
sharing only after an equivalence proof demonstrates that a failure and every
evidence ledger entry remain attributable to exactly one case.

### Values and references

Definitions use a closed value/reference language:

```ts
type ValueRef =
  | { readonly kind: "literal"; readonly value: BoundedEjson }
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "coordinate"; readonly field: "seed" | "transport" | "topology" }
  | { readonly kind: "run"; readonly field: "runId" }
  | { readonly kind: "fixture"; readonly field: "documents" | "subscriberIds" }
  | { readonly kind: "step"; readonly stepId: StepId; readonly output: string };
```

The compiler resolves references statically. A reference must point backward
to a declared output with an exact compatible type. Cycles, unknown outputs,
implicit coercions, excessive nesting, unsafe EJSON values, and references to
runtime secrets are rejected.

String interpolation is not part of the language. Named generators produce
deterministic strings, payloads, IDs, dates, ObjectIDs, binary values, and
adversarial shapes from the coordinate seed and explicit inputs.

### Steps and primitives

Steps form a strictly ordered list in schema version 1. Unique step IDs make
dependencies and evidence attribution explicit without introducing a general
DAG scheduler.

```ts
type StepDefinition =
  | SubscribeStep
  | MongoWriteStep
  | WaitStep
  | BarrierStep
  | ClientLifecycleStep
  | FaultStep
  | SnapshotStep
  | SealEvidenceStep;

interface BaseStep {
  readonly id: StepId;
  readonly timeoutMs?: number;
  readonly onFailure: "fail_case" | "incomplete_case";
}

interface MongoWriteStep extends BaseStep {
  readonly kind: "mongo_write";
  readonly operation:
    | "insert_one"
    | "insert_many"
    | "update_one"
    | "replace_one"
    | "delete_one"
    | "delete_many";
  readonly selector: SafeSelector;
  readonly mutation: SafeMutation | ValueRef;
  readonly expectedTransition: ExpectedTransition;
}

interface WaitStep extends BaseStep {
  readonly kind: "wait";
  readonly predicate:
    | "all_subscribers_ready"
    | "event_ledger_contains"
    | "all_subscribers_converged"
    | "observer_driver_witnessed"
    | "fault_activated"
    | "fault_recovered";
  readonly inputs: Readonly<Record<string, ValueRef>>;
}

interface FaultStep extends BaseStep {
  readonly kind: "fault";
  readonly operation: "activate" | "restore";
  readonly controller: FaultControllerKind;
  readonly faultId: string;
}
```

The initial primitive catalog must cover every supported or
fallback-required case already named by the release capability registry:

- run-scoped fixture creation and cleanup;
- DDP connect, subscribe, stop, disconnect, reconnect, resume, and fresh
  session creation;
- unordered and ordered observer queries, selector variants, projections, and
  distinct/identical query shapes;
- allowlisted Mongo insert, update operators (`$set`, `$unset`, `$inc`, and
  `$push`), replacement, and deletion;
- publication readiness, barriers, deterministic concurrent write schedules,
  exact snapshots, and evidence sealing;
- bounded payload, fanout, slow-consumer, fragmentation, reconnect, shutdown,
  and session schedules;
- allowlisted observer-unavailability, stream-close, recoverable-error,
  primary-step-down, election, network-interruption, and catch-up-timeout fault
  controllers with mandatory restoration.

Selectors and updates are typed ASTs, not raw MongoDB objects. The validator
allows only operators required by declared cases. It rejects `$where`, code,
JavaScript regex execution, server-side expressions, collection changes, and
unknown operators.

The interpreter owns the collection name and forcibly conjoins every read,
write, and cleanup selector with its unforgeable `runId`. Definitions cannot
provide or override database names, collection names, connection strings, or
cleanup scope.

### Expected-state model

Each state-changing primitive names an `ExpectedTransition`; the independent
expected-model reducer applies that transition to a canonical in-memory model.
The reducer consumes the definition and generated fixture, never MongoDB or
DDP observations.

MongoDB and DDP producers independently canonicalize their observed values.
They must not call the expected-model canonicalizer. Shared low-level hashing
may consume already canonical byte sequences, but expected, MongoDB, and DDP
canonicalization implementations and tests remain separate.

For serialized conformance actions, the event ledger is a hard gate. For
burst or concurrent actions where DDP may coalesce intermediate states, exact
final state, content digests, absence of stale fields, and declared ordering
constraints are hard gates; raw event counts remain diagnostic.

### Oracles

Definitions select oracle families and inputs but cannot provide observations,
digests, `passed`, assertion counts, failure reasons, or case status.

```ts
interface OracleDefinition {
  readonly id: OracleId;
  readonly family:
    | "snapshot_exact"
    | "event_present"
    | "event_absent"
    | "revision_monotonic"
    | "field_absent"
    | "observer_identity"
    | "fallback_identity"
    | "transport_identity"
    | "session_identity"
    | "fault_witness"
    | "cleanup_complete";
  readonly producer: Exclude<Producer, "expected_model">;
  readonly expected: ValueRef;
  readonly observed: EvidenceRef;
  readonly failureReason: StableFailureReason;
  readonly gate: "hard" | "diagnostic";
}
```

At least one hard-gate oracle must compare each independent required producer
against expected-model evidence or another independently attested producer.
No single producer can satisfy an ordinary case. Fault cases require an
independent fault-controller oracle. Transport and session cases require
explicit identity oracles. Oracle-family contracts, allowed producer pairs,
and stable failure reasons live in the versioned oracle catalog rather than in
case-ID conditionals inside aggregation.

### Declarative negative controls

Each hard-gate oracle family has at least one declarative sensitivity control:

```ts
interface NegativeControlDefinitionV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly targetOracleFamily: OracleDefinition["family"];
  readonly mutation: SealedEvidenceMutation;
  readonly expectedReason: StableFailureReason;
}
```

Controls mutate a sealed copy of fixture or evidence data and pass it through
the real evaluator and aggregator. Allowed mutations include dropped event,
duplicated event, reordered revision, altered payload byte, retained removed
field, substituted observer, suppressed fallback record, substituted session,
duplicated idempotent effect, omitted fault witness, omitted release identity,
nonzero workload exit, removed required case, and failed restoration.

Definitions cannot select an `actualReason` or mark themselves detected.

## Compiler and runtime architecture

### Catalog loader

Store authored definitions as JSON under:

```text
reliability/definitions/
  contract.json
  profiles.json
  capabilities.json
  cases/*.json
  negative-controls.json
```

JSON keeps definitions data-only and reviewable without adding a parser
dependency. The loader rejects duplicate keys during parsing, unknown fields,
duplicate IDs, invalid UTF-8, oversized files, excessive nesting, and values
outside global safety bounds. It returns deeply frozen normalized values.

`capabilities.json` replaces executable capability-construction logic. Every
supported or fallback-required `requiredCases` entry must resolve to exactly
one case definition. Every case must be referenced by at least one capability.
Applicability must have a non-empty intersection, and a case may not silently
widen the capability claim.

### Compiler

The compiler performs all data-only validation before starting Meteor,
MongoDB, DDP clients, or fault controllers:

1. validate and canonicalize the entire contract graph;
2. verify referential integrity and primitive/oracle implementation coverage;
3. intersect operator scope, capability applicability, case applicability,
   and profile bounds;
4. expand exact case coordinates;
5. resolve parameters and references;
6. insert interpreter-owned run scoping and mandatory cleanup;
7. calculate deterministic expected transitions and declared evidence needs;
8. emit immutable `CompiledCasePlanV1` values and their digests.

Given the same contract digest, coordinate, profile, and seed, compilation must
produce byte-identical plans and expected ledgers except for explicitly marked
runtime attestations such as run ID, attempt ID, and timestamps. Those values
are supplied after compilation and are excluded from the deterministic plan
digest.

Any catalog error aborts before side effects. A runtime/environment
precondition that cannot be satisfied produces a persisted `incomplete` case
artifact with a stable reason. It is never silently skipped.

### Planner and coordinator

The coordinator receives a complete compiled plan, not an `executeCase`
callback with a `supports` predicate. It journals one result for every required
coordinate.

Execution is isolated per logical coordinate. Retries create new immutable
attempts and preserve monotonic failure/incomplete aggregation. The planner
does not cache a transport-wide workload or reuse its final snapshots across
logical cases.

The case state machine remains:

```text
planned -> preflighted -> environment_ready -> clients_ready
        -> workload_running -> converging -> evidence_sealed
        -> cleanup_verified -> passed | failed | incomplete
```

An unsupported primitive, unavailable topology, identity mismatch, failed
precondition, deadline, process crash, missing producer, invalid evidence, or
unverified restoration becomes `incomplete`, unless independently valid
behavioral evidence establishes a declared failure.

### Environment adapter

The environment adapter owns Meteor and MongoDB lifecycle, observer order,
transport selection, non-secret identity attestation, and bounded fault
controllers. Case definitions may choose only declared coordinate values.

Remote MongoDB authorization remains an operator/CLI decision outside the
case language. The browser control plane remains unable to provide MongoDB
URLs, environment maps, filesystem paths, checkouts, outputs, raw commands, or
fault parameters.

### Workload interpreter

The interpreter executes exactly one compiled step at a time, journals start
and completion, applies the expected transition, and records producer evidence
under the step ID. It enforces global and per-case limits even after schema
validation.

Steps are not retried unless the primitive declares idempotency and the case
budget permits one retry. Mongo writes use deterministic IDs and filters so a
retry cannot widen scope. A retry cannot erase a prior failure or incomplete
attempt.

### Evidence producers and assembler

The runtime has distinct adapters for expected model, MongoDB, DDP client,
Meteor probe, and fault controller. Each emits a bounded, typed ledger whose
entries include producer, step ID, sequence, canonical digest, and producer
metadata. Evidence is append-only and sealed before evaluation.

The result assembler evaluates declarative oracles against sealed evidence and
creates `AuditCaseResultV3`. It—not the definition—derives assertion counts,
oracle outcomes, stable reasons, and final status.

```ts
interface AuditCaseResultV3
  extends Omit<AuditCaseResultV2, "schemaVersion"> {
  readonly schemaVersion: 3;
  readonly contractId: string;
  readonly contractDigest: string;
  readonly caseDefinitionDigest: string;
  readonly compiledPlanDigest: string;
  readonly interpreterVersion: string;
  readonly resolvedParameters: Readonly<Record<string, BoundedEjson>>;
  readonly stepLedgerDigest: string;
  readonly evidenceLedgerDigests: Readonly<Record<Producer, string>>;
}
```

The benchmark result retains its existing top-level envelope and public metric
paths. New attestations live beneath `metrics.change_stream_audit.contract` and
`metrics.change_stream_audit.release_evidence`; existing consumers must remain
valid.

### Aggregation

Aggregation loads the exact contract manifest identified by each case result.
It rejects mixed contract, case-definition, plan-semantics, or interpreter
versions. Evidence policy comes from the explicit case evidence contract and
versioned oracle catalog; aggregation does not infer semantics from case IDs.

A release cannot be `conformant` when any required definition is missing, any
coordinate lacks a result, a result attests the wrong definition, a required
producer/oracle is absent, a negative control is undetected, cleanup or fault
restoration is unverified, or the contract graph digest differs.

## Declarative case example

The authored JSON for `$unset` is structurally equivalent to:

```json
{
  "schemaVersion": 1,
  "id": "event.update.unset",
  "title": "Unset removes a published field",
  "source": "https://docs.meteor.com/performance/change-streams-observer-driver",
  "rationale": "A removed field must not survive in Minimongo or a final snapshot.",
  "applicability": [{
    "topologies": ["replica_set"],
    "transports": ["sockjs", "uws"],
    "observerOrders": [["changeStreams", "oplog", "polling"]]
  }],
  "parameters": {},
  "fixture": {
    "collection": "reliabilityDocuments",
    "publication": "reliability.documents",
    "generator": "synthetic-document-v1",
    "subscribers": { "kind": "parameter", "name": "subscribers" },
    "documents": { "kind": "literal", "value": 1 },
    "payloadBytes": { "kind": "parameter", "name": "payloadBytes" }
  },
  "preconditions": [
    { "kind": "actual_observer_available", "driver": "changeStreams" }
  ],
  "steps": [
    { "id": "subscribe", "kind": "subscribe", "onFailure": "incomplete_case" },
    { "id": "insert", "kind": "mongo_write", "operation": "insert_one",
      "selector": { "kind": "fixture_document", "index": 0 },
      "mutation": { "kind": "fixture_document", "index": 0 },
      "expectedTransition": { "kind": "insert" }, "onFailure": "fail_case" },
    { "id": "unset", "kind": "mongo_write", "operation": "update_one",
      "selector": { "kind": "fixture_document", "index": 0 },
      "mutation": { "kind": "unset", "path": ["ephemeral"] },
      "expectedTransition": { "kind": "remove_field", "path": ["ephemeral"] },
      "onFailure": "fail_case" },
    { "id": "converge", "kind": "wait", "predicate": "all_subscribers_converged",
      "inputs": {}, "onFailure": "fail_case" },
    { "id": "seal", "kind": "seal_evidence", "onFailure": "incomplete_case" }
  ],
  "evidence": {
    "requiredProducers": ["mongodb", "ddp_client", "meteor_probe"],
    "observer": { "kind": "selected", "driver": "coordinate.firstObserver" },
    "transportIdentity": "required",
    "fault": null,
    "ledgers": ["mongodb_snapshot", "ddp_snapshot", "observer_selection"]
  },
  "oracles": [
    { "id": "mongo-field-absent", "family": "field_absent", "producer": "mongodb",
      "expected": { "kind": "step", "stepId": "unset", "output": "expectedState" },
      "observed": { "producer": "mongodb", "stepId": "converge", "ledger": "snapshot" },
      "failureReason": "stale_field_retained", "gate": "hard" },
    { "id": "ddp-field-absent", "family": "field_absent", "producer": "ddp_client",
      "expected": { "kind": "step", "stepId": "unset", "output": "expectedState" },
      "observed": { "producer": "ddp_client", "stepId": "converge", "ledger": "snapshot" },
      "failureReason": "stale_field_retained", "gate": "hard" }
  ],
  "diagnostics": [{ "kind": "propagation_latency", "fromStep": "unset" }],
  "cleanup": { "kind": "run_scoped", "verifyEmpty": true },
  "budget": {
    "maximumSteps": 8,
    "maximumDocuments": 1,
    "maximumSubscribers": 12,
    "maximumPayloadBytes": 524288,
    "maximumEvidenceEntries": 10000,
    "stepTimeoutMs": 30000,
    "caseTimeoutMs": 120000,
    "maximumRetries": 0
  },
  "sharing": "isolated"
}
```

The final schema should avoid magic strings such as
`coordinate.firstObserver` by representing them with the typed `ValueRef`
shape. The example uses compact JSON only to show the authoring experience;
the validator and checked-in fixtures are authoritative.

## Safety, abort, and recovery invariants

- Definitions can address only the dedicated reliability collection and
  run-scoped publication.
- The interpreter creates `runId`; every database and publication selector is
  conjoined with it after compilation.
- Global limits cap files, cases, steps, clients, documents, payloads,
  evidence, nesting, deadlines, and retries. A case may narrow but never widen
  them.
- Definitions cannot select a database target, credential, command, process,
  path, environment variable, package, or arbitrary network endpoint.
- Compilation completes before any side effect.
- Faults use an allowlisted controller and exact preflighted topology identity.
  Activation and restoration require independent witnesses.
- Restoration failure aborts subsequent execution on that environment and
  marks the case and release incomplete. The operator receives the exact safe
  restoration command and attested target identity; the harness never claims
  recovery without proof.
- Cleanup is interpreter-owned, always runs after clients and evidence are
  sealed, and verifies the absence of the run-scoped documents.
- Hard termination may leave only run-scoped documents. Recovery identifies
  them by the journaled run ID and never broadens the selector.
- Evidence and case attempts are append-only. A retry or shared artifact cannot
  overwrite, hide, or convert an earlier failure into a pass.
- A definition digest change invalidates prior case evidence for the new
  contract; old artifacts remain readable under their recorded version.

Rollback is code rollback to the immediately preceding signed commit plus
removal of uncommitted generated results. Rollback must not restore the legacy
executor as a second production path. If live parity or sensitivity fails
before the replacement commit, retain the current audit implementation and do
not claim declarative completion.

## Verification gauntlet

Every item below is a hard gate unless labeled diagnostic.

### Contract graph and compiler

- **Violation:** unknown fields, duplicate JSON keys, unsafe operators,
  unbounded values, cycles, invalid references, or unknown primitives are
  accepted. **Oracle:** schema and compiler rejection tests plus generated
  invalid documents. **Command:** run `npm test` with the test-name pattern
  `declarative audit contract|declarative audit compiler`.
- **Violation:** a required case has no definition, a definition is orphaned,
  or applicability does not intersect. **Oracle:** delete/rename mutation of
  catalog fixtures must fail compilation with a stable reason. **Command:**
  the same targeted contract suite.
- **Violation:** compilation is nondeterministic. **Oracle:** independent
  process compilation produces byte-identical normalized catalogs, plans, and
  expected-ledger digests for fixed inputs. **Command:**
  `npm test -- --test-name-pattern='declarative audit determinism'`.
- **Violation:** a catalog primitive lacks an interpreter or an interpreter is
  unreachable. **Oracle:** bidirectional primitive and oracle catalog coverage
  tests. **Command:** `npm test -- --test-name-pattern='declarative audit catalog coverage'`.

### Interpreter and isolation

- **Violation:** a primitive executes a different operation, escapes run
  scope, or updates the expected model incorrectly. **Oracle:** contract tests
  for every primitive against an isolated MongoDB/DDP fixture, including
  injected failure before and after each step. **Command:** root unit tests and
  the task app's Meteor integration suite.
- **Violation:** one case's evidence satisfies another. **Oracle:** swap case
  definition and evidence digests and require aggregation to become
  incomplete; prove transport-wide batching is rejected in schema version 1.
- **Violation:** cleanup or fault restoration is skipped after a failure.
  **Oracle:** fault injection at every state-machine boundary followed by
  run-scoped emptiness and topology/network restoration assertions.
- **Violation:** crash/replay changes plan identity or erases outcomes.
  **Oracle:** journal replay tests preserve plan digest, attempt history, and
  monotonic status.

### Oracle independence and sensitivity

- **Violation:** the expected-model bug is shared with MongoDB or DDP
  canonicalization. **Oracle:** implementation dependency test forbids imports
  between the canonicalizers; cross-fixture tests use externally authored
  canonical byte fixtures.
- **Violation:** an oracle passes corrupted evidence. **Oracle:** declarative
  negative controls exercise snapshot, event, ordering, stale-field, observer,
  fallback, transport, session, fault, identity, process-exit, required-case,
  and restoration families through the real evaluator and aggregator.
- **Violation:** a definition self-asserts success. **Oracle:** schema rejects
  observed values, digests, assertion counts, outcome booleans, actual reasons,
  and status fields in authored definitions.

### Integration and end-to-end parity

- **Violation:** the seven current CRUD behaviors change during migration.
  **Oracle:** before deleting the legacy code, execute old and compiled cases
  against the same supported local topology and compare operation-specific
  MongoDB, DDP, observer, transport, cleanup, and final-status evidence. Shared
  whole-run evidence is not accepted as parity.
- **Violation:** a registered required capability remains unexecutable.
  **Oracle:** compile the complete default matrix and assert every coordinate
  has exactly one plan and one eventual artifact; no `supports` or skip API
  exists.
- **Violation:** public benchmark or dashboard contracts regress. **Oracle:**
  root schema/metric tests, dashboard consumer tests, and an audit result
  fixture comparison preserve the top-level envelope and established metric
  paths.
- **Violation:** observer/transport/topology identity differs from the
  coordinate. **Oracle:** live smoke execution over SockJS and uWS on the
  declared replica-set environment, plus exact observer and transport probes.
- **Violation:** release aggregation can false-pass incomplete evidence.
  **Oracle:** complete negative-control suite, missing-producer tests, mixed
  contract/version tests, and one removed-coordinate mutation all prevent
  `conformant`.

Final repository gates are:

```sh
npm test
node bench.js list
npx playwright test --list
for file in scripts/*.sh; do bash -n "$file"; done
for file in scripts/helpers/*.js; do node --check "$file"; done
(cd apps/tasks-3.x && meteor npm test)
(cd apps/dashboard && meteor npm test)
```

Live audit execution is required for rollout evidence but remains an explicit,
preflighted operation because it starts Meteor and MongoDB workloads. Record
the exact Meteor release, harness SHA, MongoDB identity, topology, transports,
profile, seed, contract digest, and artifact paths.

## Direct-rollout execution checklist

- [x] Define JSDoc types and strict validators for case definitions, profiles,
  negative controls, value references, safe selector/update ASTs, compiled
  plans, ledgers, and result schema v3 in `reliability/contracts/`; verify all
  unknown, unsafe, recursive, and unbounded inputs fail before side effects.
- [x] Add the data-only JSON catalog under `reliability/definitions/`; migrate
  every capability and source/rationale without changing its expectation, and
  require every supported/fallback case to resolve exactly once.
- [x] Implement catalog canonicalization, duplicate-key-safe loading, complete
  graph validation, deterministic compilation, applicability intersection,
  reference resolution, global bounds, run-scope insertion, and plan digests;
  prove fixed inputs compile identically across processes.
- [x] Implement the closed primitive and oracle catalogs with explicit version
  identifiers; add bidirectional coverage tests so declarations and trusted
  implementations cannot drift.
- [x] Split expected-model, MongoDB, DDP-client, Meteor-probe, and
  fault-controller evidence adapters; prohibit canonicalizer imports across
  trust boundaries and verify independent canonical fixtures.
- [x] Implement isolated case interpretation, append-only step/evidence
  ledgers, deadline and idempotency rules, mandatory cleanup, fault restoration,
  and state-machine journaling; inject failure at every step boundary.
- [x] Express all supported observer, CRUD, selector, projection, multiplexer,
  publication, data-shape, transport, session, fallback, and recovery cases as
  definitions using the closed primitives. Implement any missing primitive
  before authoring a definition that references it.
- [x] Convert smoke and extreme profiles to bounded declarative data and make
  both `audit` and `release-audit` compile exact plans from the same catalog;
  preserve existing CLI inputs, remote-target guards, result envelope, and
  dashboard-safe argument subset.
- [x] Replace prefix-derived `RELEASE_CASE_CONTRACTS`, `executeCase.supports`,
  cached transport-wide execution, and `buildBoundedCrudCaseResult` with
  explicit compiled evidence contracts and one artifact per coordinate; make
  every preflight-unavailable coordinate persist as incomplete.
- [x] Convert all required negative controls to declarative sealed-evidence
  mutations evaluated through the real oracle and aggregation path; establish
  sensitivity for every hard-gate oracle family.
- [x] Upgrade case and manifest persistence with contract, definition, plan,
  interpreter, and ledger digests; reject mixed or unattested semantics while
  retaining readers for historical schema-v2 artifacts.
- [x] Run old/new operation-specific parity for the seven bounded CRUD cases,
  then delete `tests/reliability-change-streams.js`,
  `reliability/operation-matrix.js`, `reliability/cases/bounded-crud.js`, and
  the imperative release executor only after the compiled path passes all
  parity and sensitivity gates.
- [x] Update README, repository guidance, CLI help, result fixtures, dashboard
  consumers, contract tests, and the release-conformance spec so declarative
  catalogs are the sole case-authoring authority and unknown/missing cases fail
  closed.
- [ ] Run the full verification gauntlet and authorized live matrix, inspect
  generated artifacts for exact attribution and cleanup, review the final diff,
  and record the shipped architecture in
  `decisions/YYYY-MM-DD-declarative-audit-case-authority.md` before committing
  the integrated replacement.

## Acceptance criteria

The rollout is complete only when:

1. every supported or fallback-required capability resolves to declarative
   case definitions and every required coordinate compiles;
2. adding a case from existing primitives requires no executor, coordinator,
   aggregator, or workload code change;
3. no case behavior or evidence rule depends on an identifier prefix;
4. no callback, dynamic code, raw command, arbitrary path/environment value,
   or self-asserted observation exists in authored definitions;
5. every result attests its contract, definition, plan, interpreter, and
   evidence-ledger digests;
6. unavailable or unsupported execution persists incomplete evidence and is
   never silently skipped;
7. expected truth and independent observations use separate canonicalizers and
   every oracle family detects its declared negative control;
8. cleanup and restoration are verified under success, behavioral failure,
   infrastructure failure, timeout, interrupt, and replay;
9. the canonical benchmark envelope and dashboard-consumed metric paths remain
   compatible;
10. the legacy imperative audit execution path is removed in the same direct
    rollout, leaving one authoritative declarative path.
