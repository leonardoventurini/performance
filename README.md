# Meteor Performance

Automated benchmark framework for detecting performance regressions across Meteor releases.

**Live Dashboard**: [meteor-benchmark.meteorapp.com](https://meteor-benchmark.meteorapp.com)

## What it does

- Benchmarks Meteor apps under load (Artillery + Playwright)
- Collects CPU, RAM, and GC metrics from the Meteor process
- Compares two branches/releases and detects regressions
- Pushes results to a live Blaze dashboard on Galaxy
- Runs automatically via GitHub Actions (PR checks + nightly)

## Quick start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Install app dependencies
cd apps/tasks-3.x && npm install && cd ../..

# Run a benchmark (uses system Meteor)
node bench.js run --scenario reactive-light --tag my-test

# Run against a local Meteor checkout
METEOR_CHECKOUT_PATH=/path/to/meteor/checkout \
  node bench.js run --scenario reactive-light --tag devel

# Compare two results
node bench.js compare --baseline results/a.json --target results/b.json

# List available scenarios
node bench.js list
```

## Comparing branches

```bash
# Checkout baseline
cd /path/to/meteor && git checkout release-3.5
cd /path/to/performance
METEOR_CHECKOUT_PATH=/path/to/meteor \
  node bench.js run --scenario reactive-light --tag release-3.5 --output results/baseline.json

# Checkout target
cd /path/to/meteor && git checkout devel
cd /path/to/performance
METEOR_CHECKOUT_PATH=/path/to/meteor \
  node bench.js run --scenario reactive-light --tag devel --output results/target.json

# Compare
node bench.js compare --baseline results/baseline.json --target results/target.json
```

## Meteor source

The harness can drive either a local Meteor checkout (build from source) or a pinned published release. Both modes produce result JSON with the same shape; only `meteor.version` and `meteor.sha` differ.

| Mode | When to use | CLI flag | Env var | Config field |
|------|-------------|----------|---------|--------------|
| Pinned release | Compare published versions; reproducible CI runs | `--meteor-version <version>` | `METEOR_RELEASE` | `meteorVersion` |
| Local checkout | Benchmark in-progress changes against a meteor branch | `--meteor-checkout <path>` | `METEOR_CHECKOUT_PATH` | `meteorCheckoutPath` |

Precedence is flag > env > config. The two modes are mutually exclusive — passing both fails fast with a message naming the conflicting values.

```bash
# Pinned release
node bench.js run --meteor-version 3.1.2 --scenario reactive-light --tag v3.1.2

# Local checkout
node bench.js run --meteor-checkout /path/to/meteor --scenario reactive-light --tag devel
```

When neither is provided, the harness falls back to the `meteor` binary on `PATH` and records `meteor.version = "system"`, `meteor.sha = "unknown"`.

## CLI commands

| Command | Description |
|---------|-------------|
| `bench.js run` | Run a benchmark scenario |
| `bench.js compare` | Compare two result files |
| `bench.js push` | Push results to the Galaxy dashboard |
| `bench.js baseline` | Mark a previously-pushed run as the baseline for a scenario |
| `bench.js list` | List available scenarios and apps |

### `run` options

| Flag | Description | Default |
|------|-------------|---------|
| `--scenario` | Scenario to run | `reactive-light` |
| `--tag` | Label for this run (branch name, version) | required |
| `--output` | Output JSON file path | `results/<scenario>-<tag>-<timestamp>.json` |
| `--app` | App directory to benchmark | `tasks-3.x` |

### `baseline` options

Pin an already-pushed run as the baseline used by the dashboard's regression comparisons.

| Flag | Description | Default |
|------|-------------|---------|
| `--scenario` | Scenario whose baseline to set | required |
| `--run-id` | Document ID of the run (printed by `bench.js push`) | required |
| `--url` | Dashboard WebSocket URL | `bench.config.js` `dashboardUrl` |
| `--key` | Dashboard API key | `BENCH_API_KEY` env var |

```bash
node bench.js baseline --scenario reactive-light --run-id abc123
```

## Scenarios

| Scenario | VUs | Duration | What it tests |
|----------|-----|----------|---------------|
| `reactive-light` | 30 | ~2 min | Reactive pub/sub CRUD (light load) |
| `reactive-crud` | 240 | ~5 min | Reactive pub/sub CRUD (heavy load) |
| `non-reactive-crud` | 240 | ~5 min | Methods-only CRUD (no reactivity) |

## Metrics collected

| Metric | Source | Description |
|--------|--------|-------------|
| Wall clock | Timer | Total benchmark duration |
| APP CPU avg/max | pidusage | Meteor process CPU usage |
| APP RAM avg/max | pidusage | Meteor process memory |
| DB CPU/RAM | pidusage | MongoDB process resources |
| GC total pause | perf_hooks | Total garbage collection pause time |
| GC max pause | perf_hooks | Longest single GC pause |
| GC count | perf_hooks | Number of GC events |
| GC major | perf_hooks | Full (mark-sweep-compact) GC time |

## CI / GitHub Actions

### PR Benchmark (on demand)

Triggered manually or via `repository_dispatch`. Compares a branch against a baseline:

```bash
gh workflow run benchmark-pr.yml \
  -f branch=devel \
  -f baseline=release-3.5 \
  -f scenario=reactive-light
```

Results are pushed to the dashboard and posted as PR comments (when a PR number is provided).

### Nightly Benchmark (cron)

Runs every night at 3am UTC on `devel` vs the latest release branch. Results accumulate on the dashboard for trend analysis.

## Dashboard

A Blaze app deployed on Galaxy that displays benchmark results:

- **Dashboard** — Recent runs with status badges
- **Compare** — Select two branches/tags and see the diff table
- **Trends** — Line charts showing metric evolution over time

Source: `apps/dashboard/`

## Project structure

```
bench.js                  CLI entry: parseArgs + command switch + help
bench.config.js           Apps, scenarios, regression thresholds, dashboard
meteor-source.js          Resolves --meteor-version / --meteor-checkout / system
cli/
  list.js                 bench.js list
  run.js                  bench.js run (driver dispatch + --env splitter)
  compare.js              bench.js compare
  dashboard.js            bench.js push + baseline (DDP)
drivers/
  artillery.js            artillery-playwright + artillery scenarios
  script.js               node-script scenarios (e.g. fanout)
  cold-start.js           N-run median startup
  bundle-size.js          meteor build + fs-based size measurement
runner/
  meteor-process.js       reset/start/findPid/stop the Meteor app
  wait-for-app.js         fetch + node:timers/promises poll loop
  collectors.js           spawn process/gc monitors, drain, parse
  _io.js                  mockable facade over node:* stdlib + DDP/ws
collectors/
  process-monitor.js      CPU/RAM collector (pidusage)
  gc-monitor.cjs          GC collector (perf_hooks; CJS — --require only)
  event-loop-monitor.js   Event-loop delay collector
reporters/
  json-reporter.js        buildResult + writeResult + appendToHistory
  regression-detector.js  compare + toMarkdown
artillery/
  reactive-stress.yml         240 VUs (heavy)
  reactive-stress-light.yml   30 VUs (light)
  non-reactive-stress.yml     240 VUs, methods only
apps/
  tasks-3.x/              Meteor 3 React benchmark app (+ packages/tasks-common)
  dashboard/              Blaze dashboard (Galaxy)
tests/
  unit/                   node:test unit suite (npm test, <5s, no Meteor)
  reactive.spec.js        Playwright integration
  non-reactive.spec.js    Playwright integration
.github/workflows/
  benchmark-pr.yml        PR benchmark workflow
  benchmark-nightly.yml   Nightly benchmark workflow
  benchmark-transport.yml sockjs vs uws transport matrix
```

## Requirements

- Node.js >= 24
- Chromium (installed via Playwright)
- Either a Meteor checkout (`--meteor-checkout`) or a pinned Meteor release (`--meteor-version`); falls back to the `meteor` binary on `PATH`

## Legacy

The original runtime and bundler benchmark docs are still available:
- [Runtime benchmarking](./RUNTIME.md)
- [Bundler benchmarking](./BUNDLER.md)
