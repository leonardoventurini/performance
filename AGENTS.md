# Repository guidance

## Purpose and architecture

This repository is a Meteor benchmark framework. The canonical path is the
Node 24 ESM CLI in `bench.js`; the shell scripts under `scripts/` are legacy
operations tools and are not called by the CLI, npm, or GitHub Actions.

The runtime flow is:

1. `bench.js` parses CLI arguments and dispatches through `cli/`.
2. `cli/run.js` resolves the Meteor source, validates the scenario and app,
   selects a driver, and persists the result.
3. `drivers/` own workload-specific execution for Artillery, scripts, cold
   start, bundle size, and build profiling.
4. `runner/` owns Meteor process lifecycle, collectors, metric aggregation,
   runtime metadata extraction, and result construction.
5. `collectors/` gather process/GC, MongoDB, and in-app instrumentation
   metrics.
6. `reporters/` persist the canonical JSON result and compare it against
   configured regression thresholds.

The `audit` subcommand is a correctness path, not a performance scenario. It
uses the same process, collector, and result envelope, but
`metrics.change_stream_audit.status` is authoritative and any non-passing
status must produce a nonzero CLI exit after the evidence file is persisted.
`reliability/definitions/` is the sole case, profile, capability, and
negative-control authoring authority. `reliability/declarative/` validates and
compiles it; `reliability/runtime/` interprets only closed trusted primitives
against an owned replica set, two Meteor instances, and the audit proxy. The
task fixture exposes only the run-scoped `reliability.documents` publication
and ownership-attested audit methods for this flow.

Preserve the result contract consumed by tests and the dashboard:
`timestamp`, `tag`, `meteor`, `runtime`, `scenario`, `app`, `wall_clock_ms`,
and `metrics`. Metric names and nested paths are public contracts; update the
producer, fixtures, contract tests, comparator, and dashboard together.

Repository areas:

- `apps/tasks-3.x` is the only benchmark target. It is a Meteor 3.5.1-beta.0
  React
  fixture with app-local packages under `packages/`.
- `apps/tasks-3.x/packages/tasks-common` owns the task workload and UI.
- `apps/tasks-3.x/packages/bench-monitors` instruments DDP, observers,
  propagation, compression, and driver fallbacks. Read its README before
  changing instrumentation.
- `apps/dashboard` is a separate Meteor 3.4 Blaze application. It stores runs
  and baselines in MongoDB and renders Runs, Compare, Trends, Detail, and
  Scenario pages with Chart.js and Tailwind CSS.
- `bench.config.js` is the scenario, app, threshold, port, dashboard, and
  results-path authority.
- `.github/workflows/` runs nightly, PR, transport, and observer/transport
  matrix benchmarks against external Meteor branches.
- `results/` is ignored generated output. Each run writes the requested output
  and an additional history record under `results/history/`.

Read `README.md`, `bench.config.js`, and `scripts/SCRIPTS.md` before changing
benchmark behavior. `RUNTIME.md` and portions of `README.md` still describe
legacy or removed paths; prefer executable code and `scripts/SCRIPTS.md` when
they disagree.

## Toolchain and installation

- Use Node 24 or newer and npm 10 or newer. Volta pins Node 24.0.0.
- Use npm; every JavaScript workspace has a committed `package-lock.json`.
- Use the root `justfile` as the discoverable command surface. Run
  `just --list` to inspect recipes; the underlying npm, Meteor, Playwright,
  Tailwind, and benchmark commands remain authoritative.
- Install root dependencies with `npm ci`.
- Install a Meteor app's dependencies with `meteor npm ci` inside that app so
  its npm and Node toolchain match the active Meteor release.
- The benchmark app's Meteor packages are app-local. Do not restore the old
  top-level `packages/` or `METEOR_PACKAGE_DIRS` wiring.
- A real benchmark also requires a Meteor CLI or checkout and, depending on
  the scenario, Chromium, Artillery, MongoDB, and standard Unix process tools.
- Keep `.envrc` absent. Never introduce or commit machine-specific absolute
  paths.

Safe root verification:

```sh
just check
```

The equivalent direct commands are:

```sh
npm ci
npm test
node bench.js list
npx playwright test --list
for file in scripts/*.sh; do bash -n "$file"; done
for file in scripts/helpers/*.js; do node --check "$file"; done
```

`node bench.js list` resolves and inspects the configured Meteor source. The
root Playwright configuration only discovers or runs tests; it does not start
an application server. `just check-all` adds both Meteor application suites
and requires the Meteor CLI.

App-local verification:

```sh
(cd apps/tasks-3.x && meteor npm ci && meteor npm test)
(cd apps/dashboard && meteor npm ci && meteor npm test)
```

`test-app` in either app is a watch/full-app command, not a one-shot gate.

## CLI contracts

Use `node bench.js list` to see the authoritative app and scenario names.

Run a benchmark:

```sh
node bench.js run \
  --scenario <scenario> \
  --app tasks-3.x \
  --tag <label> \
  --output results/<name>.json
```

- The defaults are `reactive-light`, `tasks-3.x`, and the resolved Meteor
  version as the tag.
- `--env KEY=VALUE` is repeatable and passes values to the Meteor process.
- `--meteor-version <release>` and `--meteor-checkout <path>` are mutually
  exclusive after flag, environment, and config resolution.
- `--runs` applies to the cold-start driver.
- `hot-reload` is listed but is not implemented; it currently prints a
  message and exits successfully. Do not treat that exit as benchmark proof.
- Runtime drivers reset the Meteor app, wiping `.meteor/local`, before
  execution. They use `BENCH_PORT` or port 3000 and assume local MongoDB at the
  next port unless `BENCH_MONGO_URL` is set.
- Bundle and build-profile drivers create and remove temporary output under
  `/tmp`.
- Artillery and script drivers catch some workload timeouts or nonzero exits
  and may still persist a result. A successful CLI exit or written JSON file
  does not prove a valid run; inspect workload output and reject any run with
  an Artillery or script error, timeout, incomplete scenario, or missing
  expected metric.

Run a change-stream conformance audit:

```sh
node bench.js audit \
  --profile smoke \
  --observer-driver changeStreams \
  --meteor-version <release>
```

- `smoke` is the bounded default; `extreme` requires explicit selection.
- The audit writes only to `reliabilityDocuments` and scopes every mutation
  and cleanup by unique `runId` and `caseExecutionId` values.
- Audit topology is executor-owned and loopback-only. Operator MongoDB URLs
  are never audit targets.
- The requested observer must match both the startup probe and per-cursor
  fallback evidence.
- Supported operation capabilities require serialized delivery evidence.
  Burst event counts are diagnostic because DDP may coalesce intermediate
  current states; exact final state and content digests remain mandatory.
- Unsupported, fallback-only, and unexercised capabilities must remain
  explicit in the capability matrix and must never be described as passing.
- DDP message/frame evidence is mandatory for a passing transport audit.

Offline result operations:

```sh
node bench.js compare --baseline <baseline.json> --target <target.json>
node bench.js bundle-delta --limit 5 --format markdown
```

`compare` exits nonzero when configured failure thresholds are crossed. Do not
append `|| true` in local validation where regressions must block completion.
`bundle-delta` reads bundle-size records from `results/history`.

Dashboard mutations:

```sh
node bench.js push --result <result.json> --url <websocket-url>
node bench.js baseline --scenario <scenario> --run-id <id> --url <websocket-url>
node bench.js clear --confirm --url <websocket-url>
```

These commands change external state and require explicit authorization and an
exact resolved endpoint. `clear` irreversibly removes every dashboard run.
Never use `BENCH_CLEAR_CONFIRM=1` to bypass a deliberate target check.

## Benchmark correctness

- Change one independent variable at a time. Keep scenario, app revision,
  machine/container class, MongoDB topology, load configuration, collector
  set, and runtime inputs identical across a comparison.
- Use repeated runs and retain raw result JSON. A single sample is not enough
  for a performance conclusion.
- Preserve scenario loads and regression thresholds unless the experiment
  contract intentionally changes. Never weaken a safeguard merely to pass.
- Record the Meteor version and SHA, benchmark repository SHA, scenario, tag,
  runtime inputs, host characteristics, run count, and aggregation method with
  published conclusions.
- `runtime.observer_driver` and `runtime.transport` record requested startup
  configuration. They do not prove the driver selected for every cursor.
- Pass runtime variants through repeated `--env` flags. Important inputs
  include `METEOR_REACTIVITY_ORDER`, `DDP_TRANSPORT`, `DISABLE_SOCKJS`,
  `METEOR_SETTINGS`, `MONGO_OPLOG_URL`, and `SERVER_NODE_OPTIONS`.
- Browser workloads share `tests/test-helpers.js`. `REMOTE_URL` defaults to
  `http://localhost:3000`, and `TASK_COUNT` defaults to 20. Preserve accessible
  labels, selectors, session isolation, and task sequencing when changing the
  fixture UI.
- DDP and fanout scenarios are not browser substitutes; keep coverage at the
  protocol and user-journey layers when shared behavior changes.
- Absence of a collector result is distinct from a zero measurement. Preserve
  this convention in aggregators and dashboard rendering.
- The Mongo slow-query collector enables database profiling and restores it
  during orderly shutdown. A hard kill can leave profiling enabled. Resolve
  `BENCH_MONGO_URL` and `BENCH_MONGO_DB` before using an external database,
  and verify the profiler state after an interrupted run.

## Meteor source and environment

Meteor source precedence is explicit flag, environment, then config:

- Checkout: `--meteor-checkout`, `METEOR_CHECKOUT_PATH`, then
  `bench.config.js`.
- Published release: `--meteor-version`, `METEOR_RELEASE`, then config.
- When the configured checkout lacks a Meteor binary, resolution falls back to
  the system Meteor installation.

Other operator inputs include `BENCH_PORT`, `BENCH_MONGO_URL`,
`BENCH_MONGO_DB`, `MONGO_SLOWMS`, `BENCH_DASHBOARD_URL`, `BENCH_API_KEY`,
`REMOTE_URL`, and `TASK_COUNT`. Collector output-path variables are internal
coordination contracts between the runner and `bench-monitors`; keep their
creation, consumption, and cleanup symmetric.

Never commit API keys, MongoDB URLs, Galaxy credentials, private settings, or
result data containing sensitive runtime values.
`apps/dashboard/settings.json` is a tracked development-only default containing
the public dev key; do not replace it with production credentials. Production
must inject a real `Meteor.settings.benchApiKey` through private settings.

## Dashboard development

Run the dashboard on port 4000 to match the CLI's default DDP endpoint:

```sh
just dashboard
```

`just dashboard` sets `BENCH_REPOSITORY_ROOT` to the current repository so the
`/audits` control plane can launch the canonical root CLI.
Starting the Meteor app directly leaves audit execution unavailable unless the
server receives that variable explicitly. Dashboard audit requests are a
strict subset of CLI inputs: never add browser-controlled environment maps,
MongoDB URLs, paths, checkout locations, output locations, or raw arguments.
Keep audit execution single-flight, backgrounded, process-group cancellable,
and fail closed unless the correlated canonical result passes validation.
Audit controls intentionally require no application-level API key. Anyone who
can reach an audit-capable dashboard can start or cancel its single active
audit, so keep that dashboard on a trusted local or otherwise access-controlled
network. Never persist or publish child process IDs, repository paths, or
credentialed database URLs.

Tailwind source lives in `_tw/main.tailwind.css`; `client/main.css` is tracked
generated output:

```sh
(cd apps/dashboard && meteor npm run tw)
```

After template, class, token, or Tailwind changes, regenerate the CSS and
commit both source and output. Verify default, loading, empty, error, populated,
long-content, light/dark theme, keyboard, responsive, and reduced-motion
behavior where relevant. Preserve HTML escaping in detail panels and
server-only writes to `Runs` and `Baselines`.

Do not describe Galaxy dashboard deployment as verified without fixing and
testing its contract: `apps/dashboard/galaxy.json` calls
`meteor npm run build`, but the dashboard package currently declares no
`build` script. Its `/health` configuration also has no explicit route in the
application.

## Tests and change matrix

- Root CLI, driver, runner, collector, reporter, schema, or source-resolution
  changes: add focused `node:test` coverage and run `npm test`.
- Result schema or metric changes: update fixtures, metric-key contract tests,
  comparison behavior, dashboard consumers, and relevant monitor tests in one
  change.
- Shared workload or task UI changes: run root tests, both Playwright
  scenarios against a running app, and the task app's Meteor tests.
- Dashboard API changes: run dashboard Meteor tests and verify audit-control
  access behavior, publication limits, direct-write denial, and date/key
  normalization.
- Dashboard UI or Tailwind changes: regenerate CSS and perform browser
  verification across representative viewports and themes.
- Shell changes: syntax-check each edited file individually and perform only a
  non-destructive safe-path exercise.
- Workflow changes: preserve environment indirection for untrusted dispatch
  inputs, validate YAML and expressions, and never expose secrets in shell
  interpolation or logs.

Fix failures in touched scope. Do not delete, skip, loosen, or blindly update
tests, fixtures, thresholds, or snapshots to make a check pass.

## Legacy and destructive operations

The scripts under `scripts/` are legacy. Consult `scripts/SCRIPTS.md` before
using them.

- `monitor.sh` and `deploy.sh` still reference the deleted `apm-agent` package
  when `ENABLE_APM` is set.
- `monitor-bundler.sh` is superseded by the modern bundle-size driver and
  Meteor profiling.
- `monitor-remote.sh` loads `.env.prod`, deletes every collection in the
  configured remote MongoDB, manipulates Galaxy containers, and generates
  remote load.
- `deploy.sh` targets a hard-coded Galaxy hostname and changes local app state.

Never run remote monitoring, dashboard mutations, deployment, scheduled
workflows, or full benchmarks as routine validation. Resolve and state the
exact app, Meteor source, database, endpoint, credentials source, scenario,
and expected artifacts before an authorized run.

## Git discipline

- Preserve `.envrc` as deleted.
- Keep generated `results/`, logs, Playwright output, `.meteor/local`,
  `.galaxy/`, private settings, credentials, and machine-specific files
  uncommitted.
- Inspect `git status --short` before staging. Stage only task-owned paths and
  preserve unrelated work.
- Use semantic signed commits. Do not bypass hooks or push unless explicitly
  instructed.
