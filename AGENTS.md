# Repository guidance

## Purpose and layout

This repository compares Meteor 2 and Meteor 3 runtime and bundler performance.
Preserve comparability between the two applications; a faster result is not
useful when the workloads, dependencies, packages, data, or instrumentation
differ.

- `apps/tasks-2.x` is pinned by `.meteor/release` to Meteor 2.16.
- `apps/tasks-3.x` is pinned by `.meteor/release` to Meteor 3.0.2.
- `packages/tasks-common` owns the shared collection, methods, publication,
  React UI, and optional event-loop instrumentation used by both apps.
- `packages/apm-agent` is added temporarily when `ENABLE_APM` is set.
- `tests/test-helpers.js` is the shared Playwright workload. The files under
  `tests/` expose it as Playwright tests, while `artillery/*.yml` invoke the
  same functions as load scenarios.
- `scripts/monitor.sh` runs local runtime benchmarks and records application,
  MongoDB, and Artillery output under ignored `logs/`.
- `scripts/monitor-remote.sh` runs destructive remote benchmarks against
  Galaxy and MongoDB.
- `scripts/monitor-bundler.sh` profiles cold start, cached start, client and
  server rebuilds, builds, and optional bundle size.
- `benchmarks/` contains checked-in historical evidence. Treat its logs as
  immutable experiment artifacts unless a task explicitly replaces a named
  benchmark.

Read `README.md`, `RUNTIME.md`, and `BUNDLER.md` before changing benchmark
behavior.

## Environment and package management

- Use a Unix-like environment, Node 20, and npm 10 or newer. The root Volta
  pin is Node 20.16.0.
- Local monitoring also relies on the Meteor CLI, Chromium for Playwright,
  `curl`, and standard Unix process tools. Remote monitoring additionally
  requires `jq`, MongoDB access through `npx m`, and valid Galaxy credentials.
- Use `npm ci` at the repository root for Playwright, Artillery, and helper
  dependencies. Each app has its own `package-lock.json`; use `npm ci` inside
  the affected app when its npm dependencies are needed.
- Use the Meteor release pinned in each app. Set
  `METEOR_CHECKOUT_PATH=<checkout>` only when intentionally benchmarking a
  local Meteor checkout.
- Run repository scripts from the repository root. They derive paths from
  `PWD`.
- Never commit `.env`, `.env.prod`, generated `logs/`, Playwright reports,
  `.meteor/local`, credentials, Galaxy tokens, MongoDB URLs, or Monti secrets.
  `.env.prod` may be unignored in a dirty worktree, so verify it is absent
  from `git status` and staged changes before every commit.
- Shared local Meteor packages are made visible through
  `METEOR_PACKAGE_DIRS`. Use `./packages` from the repository root or
  `../../packages` from either app directory, and preserve this wiring in new
  commands.

## Benchmark invariants

- Make behavior changes in `packages/tasks-common` whenever both app versions
  should receive them. Keep the app entrypoints equivalent and limit
  version-specific code to demonstrated Meteor compatibility differences.
- Keep reactive and non-reactive scenarios semantically equivalent: each
  session removes its tasks, adds numbered tasks sequentially, observes each
  expected UI transition, removes them sequentially, and cleans up.
- Preserve session isolation. Workload assertions depend on the rendered
  `<sessionId> New Task <n>` text and the accessible labels and button names in
  the shared UI.
- Do not change arrival rate, duration, `slowMo`, task count, browser,
  instrumentation, APM state, database state, or container size for only one
  side of a comparison. If a workload changes, record the exact configuration
  with the resulting benchmark.
- Run comparison samples on the same host class and under comparable load.
  Use repeated runs for performance claims; do not present one noisy run as a
  regression or improvement.
- Keep correctness gates in Artillery (`ensure`) intact. A timeout or scenario
  error invalidates the run; do not relax thresholds merely to obtain logs.
- Treat `METEOR_BUNDLE_SIZE`, `METEOR_BUNDLE_SIZE_ONLY`,
  `METEOR_BUNDLE_BUILD`, `METEOR_IDLE_TIMEOUT`, entrypoint overrides, and
  `METEOR_LOG_DIR` as experiment inputs. Record non-default values with
  results.
- `ENABLE_APM` and `MONITOR_EXTRAS` add measurable overhead. Use the same state
  on both compared apps and call it out in conclusions.

## Safe commands

Install and perform static validation:

```sh
npm ci
for file in scripts/*.sh; do bash -n "$file"; done
for file in scripts/helpers/*.js; do node --check "$file"; done
npx playwright test --list
```

Run one app server from its directory in one terminal:

```sh
(cd apps/tasks-2.x && npm ci && METEOR_PACKAGE_DIRS=../../packages npm start)
(cd apps/tasks-3.x && npm ci && METEOR_PACKAGE_DIRS=../../packages npm start)
```

Run Playwright from the repository root in another terminal:

```sh
REMOTE_URL=http://localhost:3000 npx playwright test
```

Run app-local Meteor tests from the affected app:

```sh
npm test
```

Run local benchmarks from the repository root:

```sh
./scripts/monitor.sh tasks-2.x reactive-stress.yml <context>
./scripts/monitor.sh tasks-3.x reactive-stress.yml <context>
./scripts/monitor-bundler.sh tasks-2.x <context>
./scripts/monitor-bundler.sh tasks-3.x <context>
```

Local runtime monitoring deletes the selected app's `.meteor/local`, starts
Meteor on port 3000, launches background processes, and writes ignored logs.
Do not run two local monitors concurrently on the same port or app directory.
Bundler profiling resets the selected Meteor app, may kill the process using
its selected port, edits entrypoint files temporarily, and creates build output
under `/tmp`. Normal completion restores temporary edits, but an interruption
during a rebuild can leave an appended line behind. After any interruption,
inspect the worktree and running processes before correcting residue or
retrying.

## Remote and destructive operations

Do not run `scripts/monitor-remote.sh` or `scripts/deploy.sh` as validation.
They require explicit user authorization and real credentials.

- `monitor-remote.sh` loads `.env.prod`, deletes every collection in the
  selected remote MongoDB database, and may stop or start Galaxy containers
  before generating load.
- `deploy.sh` removes `.meteor/local`, may add the local `apm-agent` package,
  and deploys to the hard-coded Meteor performance hostname.
- Resolve and state the exact app, remote URL, database, Galaxy application,
  workload, and log context before either operation.
- After an interrupted deployment or monitored run, verify that temporary
  package changes were removed and no child processes remain.

## Change and test expectations

- Add or update tests for behavior changes. Shared workload or UI changes need
  both reactive and non-reactive coverage; script helper changes need focused
  Node tests where practical; shell orchestration changes need at least
  `bash -n` plus a safe-path integration exercise.
- Run the narrowest relevant checks first, then both app versions whenever a
  shared package, workload, dependency, or benchmark script changes.
- Playwright assumes an already-running app; the root configuration does not
  start a web server. Set `REMOTE_URL` when the target is not
  `http://localhost:3000`.
- The current `apps/tasks-2.x/tests/main.js` expects `task-2.x`, while its
  `package.json` declares `tasks-2.x`. Treat that specific assertion as a
  known baseline failure until fixed; do not mask new failures or weaken the
  assertion.
- `TASK_COUNT` controls tasks per Playwright scenario. Keep it identical across
  comparisons.
- Review generated logs for timeouts and errors, not just command exit status.
  Keep invalid runs out of `benchmarks/`.
- If benchmark evidence is committed, include a README beside it describing
  Meteor commits/releases, host or container characteristics, workload files,
  environment toggles, run count, aggregation method, and conclusions.
- Preserve unrelated work. Stage only task-owned files, and use semantic
  commit messages that explain the benchmark or correctness reason.
