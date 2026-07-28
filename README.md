# Meteor Benchmark Framework

A comprehensive benchmarking suite for Meteor applications. It allows you to run performance tests against different Meteor versions (both released versions and local checkouts) using various scenarios, including load testing with Artillery and browser automation with Playwright.

## Prerequisites

- Node.js >= 24
- npm >= 10
- Volta (optional, but recommended as configured in `package.json`)

## Installation

Clone the repository and install dependencies:

```bash
just install
```

This installs the root harness with system `npm` and installs the task fixture
and dashboard with Meteor's bundled `meteor npm`, all from their committed
lockfiles. When Just is unavailable, use `npm ci` at the repository root and
`meteor npm ci` inside each Meteor application.

## Common commands

The root `justfile` provides discoverable shortcuts for installation, checks,
local applications, Tailwind generation, and benchmark CLI operations:

```bash
just --list
just check
just bench-list
just bench reactive-light --tag local
```

`just check-all` additionally runs both Meteor application suites and requires
the Meteor CLI. Run `just install` before checks so recipes use only
workspace-local binaries. Destructive dashboard mutations and legacy remote
operations remain explicit low-level commands and intentionally have no Just
recipes.

## Usage

The primary entry point is the `bench.js` CLI tool.

### List Scenarios and Apps

List all available benchmarking scenarios and applications:

```bash
node bench.js list
```

### Run a Benchmark

Run a specific scenario against an app:

```bash
node bench.js run --scenario <scenario-name> --app <app-name>
```

**Options:**
- `--scenario <name>`: The scenario to run (e.g., `reactive-crud`, `cold-start`).
- `--app <name>`: The app to benchmark against.
- `--tag <label>`: Add a tag to the benchmark run.
- `--meteor-version <v>`: Run against a pinned published release (e.g., `3.1.2`).
- `--meteor-checkout <path>`: Run against a local Meteor checkout.

### Run a Change-Stream Audit

The reliability flow writes deterministic, oversized adversarial documents
directly to MongoDB and verifies that every DDP subscriber converges on the
same final state:

```bash
just audit
just audit extreme changeStreams
just audit smoke oplog --env MONGO_OPLOG_URL=mongodb://127.0.0.1:3001/local
```

The bounded `smoke` profile and `changeStreams` driver are the defaults.
`extreme` must be selected explicitly. Oplog runs require a working
`MONGO_OPLOG_URL`; the run fails if Meteor falls back to a different observer
driver. Non-loopback MongoDB targets are rejected unless
`--allow-remote-mongo` is passed explicitly.

Synthetic data is generated locally from a seed. No model or network call is
made during the workload, which keeps runs reproducible and avoids including
generated payloads in result files. Results use the normal output/history
contract and appear in the dashboard after `bench.js push`.

### Compare Results

Compare a benchmark result against a baseline to detect regressions:

```bash
node bench.js compare --baseline <baseline.json> --target <target.json>
```

### Push Results to Dashboard

Push benchmark results to the performance dashboard:

```bash
node bench.js push --result <file.json>
```
*Requires `BENCH_API_KEY` env var or `--key` flag for authentication.*

### Set Baseline

Set a specific run as the baseline for a scenario on the dashboard:

```bash
node bench.js baseline --scenario <name> --run-id <id>
```

### Advanced Benchmarks: Changestreams vs Oplog

To compare performance across different data tailing and DDP transport configurations (for example, testing Meteor 3.5's `uws` vs `sockjs` and `changestreams` vs `oplog`), you can use the `--env` parameter.

**1. Changestream + uWebSockets (uws)**
By default, Meteor 3 uses changestreams. To force the use of `uws` instead of `sockjs` (and handle port collision during tests), use:
```bash
echo '{"packages":{"ddp-server":{"uws":{"port":5005}}}}' > settings.json
node bench.js run --scenario ddp-reactive-light --app tasks-3.x --env DISABLE_SOCKJS=1 --env METEOR_SETTINGS="$(cat settings.json)"
```
*(Reference Result on `tasks-3.x` / `3.5-beta.12`: APP CPU avg 12.38%, RAM 240MB; DB CPU 4.71%, RAM 95MB; VU Session ~4.2s)*

**2. Oplog + SockJS**
To fall back to the legacy `sockjs` and force Oplog tailing, use:
```bash
node bench.js run --scenario ddp-reactive-light --app tasks-3.x --env METEOR_REACTIVITY_ORDER='oplog'
```
*(Reference Result on `tasks-3.x` / `3.5-beta.12`: APP CPU avg 10.15%, RAM 215MB; DB CPU 5.23%, RAM 93MB; VU Session ~99ms)*

### Runtime Observability

The `tasks-3.x` app logs two parseable lines on startup that record which observer driver and DDP transport are configured for the run:

```
[runtime-info] observer_driver=<changeStreams|oplog|polling>
[runtime-info] transport=<sockjs|uws|...>
```

The bench harness captures these from the Meteor process stderr and adds them to the result JSON as a top-level field:

```json
{
  "tag": "release-3.5-oplog-uws",
  "meteor": { "version": "release-3.5", "sha": "abc1234" },
  "runtime": { "observer_driver": "oplog", "transport": "uws" },
  "scenario": "reactive-light",
  ...
}
```

This makes cross-configuration comparison on the dashboard explicit — every pushed run carries its own coordinates, so you can stack a `changeStreams × sockjs` run against an `oplog × uws` run without guessing.

The values reflect what was REQUESTED via `METEOR_REACTIVITY_ORDER` / `Meteor.settings.packages.mongo.reactivity` and `DDP_TRANSPORT`. Meteor picks the actual observer driver per-cursor based on availability (changeStreams needs a replica set; oplog needs `MONGO_OPLOG_URL`), so the logged value is "what we asked for", not necessarily "what Meteor used for any specific query".

#### Automated 2×2 matrix run

The `Runtime Matrix Benchmark` workflow (`.github/workflows/benchmark-runtime-matrix.yml`) runs the same scenario across all four `{changeStreams, oplog} × {sockjs, uws}` combinations and pushes each result independently. Trigger via the GitHub Actions UI (`workflow_dispatch`) with a branch + scenario; each combination is tagged as `<branch>-<observer>-<transport>` and shows up on the dashboard with its `runtime` field populated.

## Configuration

The framework is configured via `bench.config.js`. You can define:
- `meteorCheckoutPath`: Default path for local Meteor checkout.
- `defaultApp`: Default app to benchmark.
- `apps`: Available apps.
- `scenarios`: Available scenarios and their configurations.
- `thresholds`: Regression detection thresholds (% increase from baseline) for metrics like CPU, RAM, Response Time, etc.

## Meteor Source Configuration

You can benchmark different Meteor versions by specifying the source. These are mutually exclusive:
1. **Local Checkout:** Set `METEOR_CHECKOUT_PATH` env var, use `--meteor-checkout` flag, or configure `meteorCheckoutPath` in `bench.config.js`.
2. **Pinned Release:** Set `METEOR_RELEASE` env var, use `--meteor-version` flag, or configure `meteorVersion` in `bench.config.js`.

## Project Structure

- `apps/`: Meteor applications used for benchmarking.
- `artillery/`: Artillery configuration files for load testing scenarios.
- `benchmarks/`: Custom benchmark definitions.
- `cli/`: CLI command implementations.
- `collectors/`: Resource metric collection tools (CPU, RAM, Event Loop).
- `drivers/`: Execution drivers (Artillery, Script, CLI).
- `reporters/`: Formatters for benchmark outputs (JSON, Markdown).
- `results/`: Generated benchmark reports and baseline files.
- `runner/`: Core execution logic for benchmarks.
- `tests/`: Testing scripts and test suite.
