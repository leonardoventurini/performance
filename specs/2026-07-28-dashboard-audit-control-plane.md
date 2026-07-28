# Dashboard Audit Control Plane

## Goal and scope

Allow an operator to start, observe, and cancel the existing bounded
change-stream audit from the Meteor dashboard without weakening the audit's
correctness or database-safety contracts.

The direct rollout adds:

- an authenticated `/audits` dashboard surface;
- a durable audit execution record with explicit lifecycle states;
- background process execution of the canonical `bench.js audit` command;
- bounded, real-time process output over a Meteor publication;
- ingestion of the canonical result envelope into `Runs`;
- cancellation of the complete spawned process group; and
- honest capability reporting when the dashboard cannot locate the benchmark
  repository or a suitable Node executable.

This is high-risk control-plane work because a false pass or an orphaned
process tree can invalidate evidence or alter the shared local runtime. It
does not implement the broader `release-audit` coordinator described in
the release-conformance specification. It controls the currently implemented
`smoke` and `extreme` change-stream audits. It does not add arbitrary CLI
arguments, arbitrary environment variables, remote MongoDB authorization, or
shell execution.

## Evidence and uncertainty

Repository evidence:

- `cli/audit.js` is the canonical request mapper for the existing audit.
- `cli/run.js` persists the result before returning a non-passing audit error.
- `apps/dashboard/imports/api/runs.js` owns authenticated result ingestion and
  server-only writes.
- the dashboard already uses DDP publications and Blaze reactive collections;
  no polling channel is required.
- the dashboard may be packaged independently with
  `apps/dashboard` as its deployment root, so a hosted instance may not contain
  `bench.js` or the fixture application.

Assumptions:

- local development starts the dashboard from `apps/dashboard`, with the
  repository available two directories above or discoverable through an
  explicit `BENCH_REPOSITORY_ROOT`;
- the selected `node` on the server path satisfies the root harness contract;
- `Meteor.settings.benchApiKey` remains the operator authentication secret;
- the audit's MongoDB target remains governed by the existing loopback-only
  default, and the UI never supplies `--allow-remote-mongo`.

Main uncertainty:

- process-group signal behavior differs between POSIX and Windows. The initial
  control plane supports POSIX execution and reports itself unavailable on
  unsupported platforms rather than pretending cancellation is safe.

Stop conditions:

- if the runner cannot prove the repository root contains both `bench.js` and
  the configured fixture, launch is rejected before a record is queued;
- if a child cannot be started without a shell or without a cancellable process
  group, the execution is marked failed;
- if the output result cannot be read, parsed, and associated with the exact
  execution, the execution is failed and no dashboard `Runs` record is
  fabricated;
- if cancellation cannot terminate the process group, the execution remains
  visibly failed with an operator-actionable error.

## Contracts and decisions

### Request contract

`AuditLaunchRequest` contains only:

- `profile`: `smoke | extreme`;
- `observerDriver`: `changeStreams | oplog`;
- `meteorVersion`: a published-release identifier selected from a
  server-configured allowlist;
- `seed`: an optional unsigned integer serialized as decimal text; and
- `tag`: an optional bounded label containing letters, digits, `.`, `_`, `/`,
  `:` and `-`.

The server reconstructs argv from validated fields. It never accepts raw argv,
environment maps, output paths, repository paths, MongoDB URLs, or shell text
from the client.

### Execution state

`AuditExecutionStatus` is one of:

- `queued`;
- `running`;
- `passed`;
- `failed`;
- `cancelling`;
- `cancelled`;
- `interrupted`.

Terminal states are monotonic. A server startup marks stale `queued`,
`running`, or `cancelling` records as `interrupted`; it does not claim that an
unknown process completed or was cancelled. An execution that had a process
group retains the unique lease until an authenticated recovery action verifies
that the group no longer exists. The dashboard cannot start another audit
while this recovery lease remains.

Each record includes the validated request, timestamps, bounded event counts,
exit metadata, the imported `runId` when evidence is valid, and a stable error
code and actionable message when unsuccessful. Process identifiers and
filesystem paths are server-only and are not published.

Process output is stored in a separate append-only event collection keyed by
`(executionId, sequence)`, with unique ordering, per-line and per-execution
limits, and time-based retention. This avoids growing one execution document
toward MongoDB's document limit.

### Process and result integrity

- Spawn uses argv form with `shell: false`.
- The child starts in its own POSIX process group.
- The output path is generated by the server beneath `results/dashboard/`.
- A launch nonce appears in both the execution record and output filename.
- A zero process exit is necessary but not sufficient for `passed`.
- The result must parse as JSON, retain the canonical envelope, use the
  expected audit scenario, and contain
  `metrics.change_stream_audit.status === "passed"`.
- A valid non-passing result is still imported as audit evidence, while the
  execution is marked `failed`.
- Logs are real child output, sequenced, timestamped, stored separately, and
  bounded by entry count and entry length. No guessed percentage or synthetic
  stage is shown.

### Concurrency and cancellation

Only one non-terminal audit execution may exist per dashboard server. A unique
sparse lease index reserves this invariant atomically before spawning.

Cancellation is authenticated and idempotent:

1. atomically move `queued` or `running` to `cancelling`;
2. signal the negative process-group ID with `SIGTERM`;
3. after a bounded grace interval, use `SIGKILL` only if the tracked group
   still exists;
4. record `cancelled` only after the child closes;
5. preserve any canonical result produced before shutdown on disk, but do not
   import a cancelled or timed-out result as an ordinary dashboard run.

### Dashboard behavior

The browser first exchanges the existing API key for an in-memory authorization
bound to its current DDP connection. The key remains only in the page's memory.
Start, cancel, execution metadata, and event publications require that live
connection authorization; reconnects must reauthorize. Failed authorization is
rate-limited per connection. Locking the controls revokes the server-side
authorization and stops its protected publications. Authorization expiry also
stops existing protected publications.

The `/audits` page shows:

- precise availability and authentication requirements;
- visible labels for every field;
- profile and observer-driver explanations;
- a single `Start audit` action with disabled and busy states;
- the active execution's exact inputs, status, elapsed time, and real output;
- a `Cancel audit` action only for cancellable states;
- a recovery action for interrupted executions that refuses to release the
  global lease while the old process group still exists;
- actionable error text;
- a link to the imported run when evidence exists; and
- recent audit executions for restart/recovery context.

Status is communicated by text and not color alone. Output uses a bounded,
wrapping region rather than forcing horizontal page overflow. Focus, keyboard,
responsive, light/dark, reduced-motion, empty, running, success, failure,
unavailable, and interrupted states are part of verification.

## Risks and recovery

- Unauthorized resource exhaustion:
  require the configured API key for launch and cancellation, allow one active
  run, and accept only bounded enums and strings. Rotate the key and stop the
  dashboard server if abuse is suspected.
- Shell or argument injection:
  never use a shell and reconstruct argv from server-side validation. Reject
  values outside the allowlist.
- Orphaned Meteor, collector, or Mongo processes:
  run in an isolated process group and cancel the group. On dashboard restart,
  mark state interrupted and show the manual process-cleanup command; never
  infer termination from a stale database record.
- False audit pass:
  require a zero exit, a canonical matching result, and the authoritative audit
  metric status. Import valid failed evidence without converting it to pass.
- Result confusion across simultaneous requests:
  enforce single-flight execution and use a server-generated execution ID and
  output path.
- Secret disclosure:
  never persist or publish the API key, environment, MongoDB URL, filesystem
  root, raw settings, or child PID.
- Hosted dashboard without runner source:
  return `unavailable` with a concrete explanation. Viewing historical results
  remains functional.

Rollback is code-level: revert the control-plane commit. Existing `Runs` and
audit execution records remain ordinary MongoDB documents and historical
result viewing remains intact. Before rollback, cancel an active audit and
verify its process group has exited.

## Verification gauntlet

Hard gates:

- Request isolation: invalid profile, driver, seed, version, tag, raw argument,
  or remote-database input cannot reach spawn.
  Oracle: pure validation tests plus an injected-spawn negative control.
- Single-flight: two concurrent starts cannot create two running children.
  Oracle: server integration test with a controlled child adapter.
- Result integrity: zero exit with missing, malformed, mismatched, or
  non-passing evidence never becomes `passed`.
  Oracle: execution finalizer unit tests, including a mutation that changes the
  authoritative metric to `failed`.
- Authentication: missing or incorrect connection authorization cannot start,
  cancel, or subscribe to execution data.
  Oracle: Meteor method and publication tests.
- Non-blocking execution: the start method returns an execution ID before the
  child completes and progress remains publishable.
  Oracle: server integration test with a held child process.
- Cancellation: termination targets the tracked process group and terminal
  state changes only on close.
  Oracle: adapter-level test and a local safe-process exercise.
- UI state contract: form, unavailable, running, failed, passed, interrupted,
  and cancellation states render without inaccessible or ambiguous controls.
  Oracle: Meteor template tests and browser verification.

Diagnostic checks:

- root `npm test`;
- dashboard `meteor npm test`;
- dashboard Tailwind regeneration and consistency;
- browser checks at narrow and desktop viewports in light and dark themes;
- `git diff --check` and final path-limited diff review.

Failure of any hard gate blocks completion. A failed local live audit is valid
product evidence only when the control plane correctly imports it and marks
the execution failed; it does not establish Meteor conformance.

## Execution checklist

- [ ] Define validation and lifecycle primitives in a testable server module;
  verify with focused Meteor tests and negative inputs.
- [ ] Add the server collection, publications, authenticated methods,
  single-flight reservation, startup recovery, background spawn, bounded log
  streaming, cancellation, and result ingestion; verify lifecycle integration.
- [ ] Add the `/audits` route, navigation, form, reactive execution panel, and
  recent history; verify accessibility and every lifecycle state.
- [ ] Add Just and repository guidance for launching the dashboard control
  plane without introducing machine-specific paths.
- [ ] Regenerate dashboard CSS and run root, dashboard, structural, syntax,
  and browser checks.
- [ ] Obtain an independent review of process safety and false-pass prevention,
  integrate findings, and commit the direct rollout.

## Verification and rollout

The feature is enabled whenever the dashboard can discover a valid local
benchmark repository and is running on a supported platform. There is no
feature flag. Capability discovery makes unsupported deployment topology
visible without breaking historical result viewing.

Local rollout:

```sh
just dashboard
```

Open `http://localhost:4000/audits`, provide the configured development API
key, choose the bounded audit inputs, and start the audit. The page must receive
the execution record immediately, show real child output while the process is
active, and link to the imported evidence after completion.

Before a production deployment can execute audits, its runtime image must
include the complete benchmark repository, a compatible Node and Meteor
toolchain, MongoDB topology access, POSIX process-group support, and private
`benchApiKey` settings. Without those prerequisites the page remains a
read-only audit history with an explicit unavailable reason.
