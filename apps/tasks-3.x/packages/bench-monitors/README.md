# bench-monitors

In-app Meteor package that hosts every monkey-patch/hook the benchmark
harness needs to read Meteor's internals. Each monitor patches a Meteor
API (`Meteor.methods`, `Meteor.publish`, `Session.prototype.*`, observe
multiplexers, etc.) to record samples in memory, then dumps to a file
when the process shuts down. The harness reads the file in
[runner/collectors.js](../../../../runner/collectors.js) and surfaces
the aggregated numbers under `metrics.<key>` in the result JSON.

**Activation is env-gated**: each monitor only writes its dump file when
the matching `<COLLECTOR>_OUTPUT` env var is set by the harness. Without
the env var the hook is a no-op — the package is transparent in normal
`meteor run` / `meteor dev` use.

## Why separate from tasks-common

[tasks-common](../tasks-common) holds the app's domain: `TasksCollection`,
methods, pub, React UI. bench-monitors holds harness instrumentation.
Splitting them keeps the app's business logic readable and lets the
monitoring surface grow (future: observer pool, DDP middleware, oplog
backlog, driver fallback) without polluting domain files.

## Current monitors

| File | Init fn | Env var | Metric key |
|---|---|---|---|
| [method-timing.server.js](method-timing.server.js) | `initMethodTiming` | `METHOD_TIMING_OUTPUT` | `ddp_methods` |
| [sub-timing.server.js](sub-timing.server.js) | `initSubTiming` | `SUB_TIMING_OUTPUT` | `ddp_subscriptions` |

Each init is re-exported from
[bench-monitors.server.js](bench-monitors.server.js) and called from
[apps/tasks-3.x/server/main.js](../../server/main.js) inside
`Meteor.startup` **before** any user code that registers Meteor APIs.
The wrap only applies to subsequent registrations, so order matters:

```js
Meteor.startup(async () => {
  initMethodTiming();    // patches Meteor.methods
  initSubTiming();       // patches Meteor.publish
  // ...
  await registerTaskApi(); // registers methods + pubs — wrapped by the above
});
```

## How a monitor works (pattern)

1. Patch a Meteor registration API (e.g. `Meteor.methods`,
   `Meteor.publish`) to install a wrapper around every handler the user
   subsequently registers.
2. Wrapper records `performance.now()` at entry and pushes a sample to
   an in-memory `Map<name, number[]>` at exit (or on the relevant DDP
   lifecycle event — `ready`, `sendAdded`, etc.).
3. Cap samples at `MAX_SAMPLES_PER_*` (currently 100k) so a pathological
   workload can't OOM the app.
4. Gate file output on `process.env.<COLLECTOR>_OUTPUT`. If unset,
   skip the SIGTERM handler entirely — no shutdown overhead, no file.
5. When set, install `SIGTERM` / `SIGINT` / `beforeExit` handlers that
   synchronously `fs.writeFileSync` the samples Map (one-shot — `dumped`
   flag prevents double-write).

[method-timing.server.js](method-timing.server.js) is the canonical
reference.

## How to add a new monitor

Mechanical steps — each task in `.claude/metrics-tasks/` follows this:

1. **New file in this package**: `apps/tasks-3.x/packages/bench-monitors/<thing>.server.js`
   - Export `init<Thing>()`.
   - Patch the relevant Meteor API.
   - Use the SIGTERM dump pattern above, gated on `<THING>_OUTPUT`.

2. **Re-export from
   [bench-monitors.server.js](bench-monitors.server.js)**:
   ```js
   import { initThing } from './thing.server';
   export { initMethodTiming, initSubTiming, initThing };
   ```

3. **Call from
   [apps/tasks-3.x/server/main.js](../../server/main.js)**:
   ```js
   import { ..., initThing } from 'meteor/bench-monitors';
   Meteor.startup(async () => {
     // ...
     initThing();
     await registerTaskApi();
   });
   ```

4. **Wire harness side**
   ([runner/collectors.js](../../../../runner/collectors.js) +
   [runner/meteor-process.js](../../../../runner/meteor-process.js)):
   - `prepareThingOutput(tag)` — returns a `results/thing-<tag>-<ts>.json` path.
   - Pass `thingPath` through `startMeteorApp` (sets `THING_OUTPUT` env var)
     and through `startCollectors`/`stopCollectors`.
   - `aggregateThing(samples)` — turns the raw `Map` dump into the
     `metrics.<key>` shape. Returns `null` when no samples (absence
     convention — caller omits the key entirely).
   - In `stopCollectors`, read the dump file, call the aggregator, push
     the result, `unlinkSync` the file.

5. **Wire drivers** ([drivers/artillery.js](../../../../drivers/artillery.js) +
   [drivers/script.js](../../../../drivers/script.js)): call
   `prepareThingOutput` and pass `thingPath` through `startMeteorApp` +
   `startCollectors`.

6. **Tests**:
   - `tests/unit/<thing>-percentiles.test.js` for the aggregator
     (mirror [tests/unit/method-timing-percentiles.test.js](../../../../tests/unit/method-timing-percentiles.test.js)).
   - One-line extension to
     [tests/unit/metric-keys-contract.test.js](../../../../tests/unit/metric-keys-contract.test.js) `ALLOWED_METRIC_KEYS`.

## Conventions

All bench-monitors output follows the cross-cutting rules in
`.claude/metrics-tasks/README.md`:

- **Percentile suffix is BARE** (`p50`, `p95`, `p99`) — never `p50_ms`.
  Matches the shipped `event_loop_delay` contract. Unit is implicit ms.
- **Non-percentile latency scalars** keep `_ms` (`avg_ms`, `max_ms`).
- **Absence**: omit the key when there are no samples; emit `0` when the
  collector ran and the count is genuinely zero; `null` for ratios with
  undefined denominators.
- **Stable identifiers**: per-entity maps key by real names
  (`fetchTasks`, `insertTask`), never positional (`pub_0`).

## File layout

```
bench-monitors/
├── package.js                       Meteor package manifest
├── bench-monitors.server.js         server main: re-exports each init fn
├── method-timing.server.js          ddp_methods (task 01)
├── sub-timing.server.js             ddp_subscriptions (task 02)
└── README.md                        this file
```
