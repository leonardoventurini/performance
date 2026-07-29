# Dashboard-Owned Audit Execution

## Context

The dashboard previously rendered audit results but could not initiate the
bounded `bench.js audit` workflow. Operators had to switch to a terminal,
remember CLI arguments, and return to the dashboard after manually pushing
evidence.

Starting an audit is materially different from viewing one: the runner resets
and starts the shared task fixture, creates process and collector trees, writes
synthetic database records, and can produce release-conformance evidence. A
dashboard control must therefore preserve the CLI's safety and false-pass
contracts rather than reimplementing the workload in a Meteor method.

## Decision

The Meteor dashboard is the local control plane; the root Node CLI remains the
only audit executor.

The `/audits` route:

- exposes audit controls to every dashboard connection without a separate
  application-level API key;
- accepts only a strict profile, observer driver, server-allowlisted Meteor
  release, unsigned seed, and bounded tag;
- creates one durable execution record protected by a unique sparse global
  lease;
- launches `node bench.js audit` without a shell, in a dedicated POSIX process
  group, from an explicitly configured repository root;
- streams real stdout and stderr into a separate bounded, sequenced,
  time-limited event collection;
- validates the exact server-generated result artifact, canonical result
  envelope, scenario, app, tag, release, requested driver, actual driver, and
  authoritative audit status before importing evidence into `Runs`; and
- imports valid passed, failed, or incomplete evidence only for naturally
  completed executions. Cancelled and timed-out artifacts remain on disk and
  are not inserted as ordinary dashboard runs.

The dashboard server fails closed when the repository, Node 24 toolchain,
writeable result directory, or POSIX process-group behavior is unavailable.
`just dashboard` supplies the repository root for local execution.

The dashboard deployment boundary controls access to methods and publications.
The repository path, database URL, output path, process ID, and raw environment
are never published or persisted in client-visible records.

Cancellation sends `SIGTERM` to the complete process group, waits a bounded
grace interval, and sends `SIGKILL` if the group remains. A dashboard restart
marks an active execution interrupted but retains its lease and process ID.
The lease is released only after a recovery action proves the old process group
no longer exists.

## Rejected alternatives

- Reimplement the audit inside the dashboard Meteor process:
  this would fork lifecycle, collector, result, and safety behavior from the
  canonical CLI and make evidence dependent on the dashboard runtime.
- Accept arbitrary CLI arguments or environment variables from the browser:
  this would expose remote MongoDB authorization, paths, ports, settings, and
  shell-adjacent inputs across the trust boundary.
- Run audits directly in a hosted dashboard that contains only
  `apps/dashboard`:
  the deployed bundle lacks the complete harness, fixture, writable evidence
  tree, stable supervisor, and local topology assumptions. Capability is
  reported unavailable instead.
- Use an in-memory “busy” flag:
  it would not survive restarts and could race concurrent method calls. The
  MongoDB unique lease is the concurrency authority.
- Store logs in an array on the execution document:
  long output could approach MongoDB's document limit and rewrite an
  increasingly large document. Sequenced events are bounded independently.
- Release the lease automatically after a dashboard restart:
  a detached Meteor or collector process could still be mutating the shared
  fixture. Recovery must prove process-group disappearance.
- Import a result produced during cancellation:
  downstream readers could mistake a partial or race-completed artifact for an
  ordinary completed audit. The artifact remains available for manual
  forensics without entering `Runs`.

## Consequences

- Local operators can start, observe, cancel, and open evidence without leaving
  the dashboard.
- Anyone who can reach an audit-capable dashboard can operate the audit
  controls, so it must remain local or use trusted network/platform access
  controls.
- A hosted dashboard remains a valid evidence viewer even when execution is
  unavailable.
- Only one dashboard audit can own the shared fixture at a time.
- Server restarts may require an explicit cleanup-verification action before
  another audit can start; this is intentional fail-closed behavior.
- Oplog execution remains unavailable unless the server privately configures
  `MONGO_OPLOG_URL`.
- The current control plane covers the implemented smoke/extreme bounded audit,
  not the future full `release-audit` coordinator.

## Verification evidence

- Root suite: 438 tests passed.
- Dashboard server suite: 16 tests passed, including request isolation, result
  correlation, actual-observer negative control, sensitive path redaction,
  symlink rejection, keyless method/publication access,
  concurrent lease reservation, and interrupted process-group recovery.
- Live browser smoke audit: Meteor 3.5.1-beta.0 completed with passed evidence,
  real sequenced output, and a working run-detail link.
- Live browser cancellation: the execution became cancelled, the process group
  exited, ports 3000 and 3001 were released, no child remained, and no cancelled
  result was imported.
- Browser review covered desktop and narrow layouts, light and dark themes,
  running, passed, cancelled, and executor unavailable states.
- Tailwind regeneration and consistency, JavaScript syntax, structural
  no-shell search, Just parsing, and whitespace validation passed.
