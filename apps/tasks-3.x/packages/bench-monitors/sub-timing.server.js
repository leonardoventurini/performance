// Measures server-side wall-time from sub-message arrival to the moment
// `ready` is sent back to the client, per publication name. Samples
// accumulate in-memory and dump to SUB_TIMING_OUTPUT on shutdown; the
// harness reads the file in stopCollectors, computes percentiles, and
// surfaces them under `metrics.ddp_subscriptions` in the result JSON.
//
// Why hook Subscription.prototype.ready instead of wrapping this.ready()
// inside a per-publish handler wrapper: cursor-returning publishes (the
// shape this app uses — `return TasksCollection.find({})`) NEVER call
// `this.ready()` from user code. Meteor auto-calls it from
// `_publishHandlerResult` after the cursor's initial fetch completes.
// Patching at the prototype level catches the auto-call AND any explicit
// user call (custom publishes that call `this.added/changed/ready`).
//
// Two-step patch: wrap `Meteor.publish` to stamp `sub._benchStart` on
// every new Subscription, then lazy-grab the Subscription prototype off
// the first incoming sub to patch `.ready()` once. The prototype isn't
// exported by Meteor; the off-prototype grab is the only path.

import { Meteor } from 'meteor/meteor';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

const MAX_SAMPLES_PER_PUB = 100_000;
const samples = new Map(); // pubName -> number[]

function recordSample(name, ms) {
  let arr = samples.get(name);
  if (!arr) {
    arr = [];
    samples.set(name, arr);
  }
  if (arr.length < MAX_SAMPLES_PER_PUB) {
    arr.push(ms);
  }
}

let patched = false;
let prototypePatched = false;
let origPublish = null;

export function initSubTiming() {
  if (patched) return;
  patched = true;
  origPublish = Meteor.publish.bind(Meteor);

  Meteor.publish = function (name, handler) {
    return origPublish(name, function (...args) {
      const sub = this;
      if (!prototypePatched) {
        const proto = Object.getPrototypeOf(sub);
        const origReady = proto.ready;
        proto.ready = function () {
          // ready() can fire multiple times in lifecycle edge cases;
          // only count the first (initial-batch latency, what the user perceives).
          if (this._benchStart != null) {
            recordSample(this._name, performance.now() - this._benchStart);
            this._benchStart = null;
          }
          return origReady.call(this);
        };
        prototypePatched = true;
      }
      sub._benchStart = performance.now();
      return handler.apply(this, args);
    });
  };

  const outputPath = process.env.SUB_TIMING_OUTPUT;
  if (!outputPath) return;

  // Synchronous write on shutdown — SIGTERM grace is short and we
  // can't risk losing data to an unflushed async write.
  const dumpOnce = (() => {
    let dumped = false;
    return () => {
      if (dumped) return;
      dumped = true;
      try {
        const dump = {};
        for (const [name, arr] of samples) dump[name] = arr;
        fs.writeFileSync(outputPath, JSON.stringify(dump));
      } catch (err) {
        process.stderr.write(`[sub-timing] dump failed: ${err.message}\n`);
      }
    };
  })();

  process.on('SIGTERM', dumpOnce);
  process.on('SIGINT', dumpOnce);
  process.on('beforeExit', dumpOnce);
}
