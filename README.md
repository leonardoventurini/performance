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

## CLI commands

| Command | Description |
|---------|-------------|
| `bench.js run` | Run a benchmark scenario |
| `bench.js compare` | Compare two result files |
| `bench.js push` | Push results to the Galaxy dashboard |
| `bench.js list` | List available scenarios and apps |

### `run` options

| Flag | Description | Default |
|------|-------------|---------|
| `--scenario` | Scenario to run | `reactive-light` |
| `--tag` | Label for this run (branch name, version) | required |
| `--output` | Output JSON file path | `results/<scenario>-<tag>-<timestamp>.json` |
| `--app` | App directory to benchmark | `tasks-3.x` |

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
bench.js                  CLI entry point
bench.config.js           Thresholds, scenarios, config
collectors/
  process-monitor.js      CPU/RAM collector (pidusage)
  gc-monitor.js           GC collector (perf_hooks)
reporters/
  json-reporter.js        JSON output
  regression-detector.js  Comparison + regression detection
artillery/
  reactive-stress.yml         240 VUs (heavy)
  reactive-stress-light.yml   30 VUs (light)
  non-reactive-stress.yml     240 VUs, methods only
apps/
  tasks-3.x/              Meteor 3 React benchmark app
  dashboard/              Blaze dashboard (Galaxy)
.github/workflows/
  benchmark-pr.yml        PR benchmark workflow
  benchmark-nightly.yml   Nightly benchmark workflow
```

## Requirements

- Node.js >= 20
- Chromium (installed via Playwright)
- A Meteor checkout (for comparing branches)

## Legacy

The original runtime and bundler benchmark docs are still available:
- [Runtime benchmarking](./RUNTIME.md)
- [Bundler benchmarking](./BUNDLER.md)
