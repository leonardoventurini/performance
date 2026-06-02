// Wraps Meteor.methods registration so every method handler logs
// wall-time per invocation. Samples accumulate in-memory, dumped to
// the file path from process.env.METHOD_TIMING_OUTPUT on shutdown.
// The harness reads the file in stopCollectors, computes percentiles,
// and surfaces them under `metrics.ddp_methods` in the result JSON.
//
// Patches Meteor.methods BEFORE any user code registers methods.
// Per the spec revision (REVISIONS.md task 01), wrapping the
// registration API is robust to async methods (Meteor 3.x) and
// catches registrations regardless of when they happen during
// startup.
//
// Sample storage caps at MAX_SAMPLES_PER_METHOD to bound memory
// (3000 calls * 8 bytes = 24KB nominal; cap protects pathological
// workloads from runaway growth).

import { Meteor } from 'meteor/meteor';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

const MAX_SAMPLES_PER_METHOD = 100_000;
const samples = new Map(); // methodName -> number[]

function recordSample(name, ms) {
  let arr = samples.get(name);
  if (!arr) {
    arr = [];
    samples.set(name, arr);
  }
  if (arr.length < MAX_SAMPLES_PER_METHOD) {
    arr.push(ms);
  }
}

let patched = false;
let origMethods = null;

export function initMethodTiming() {
  if (patched) return;
  patched = true;
  origMethods = Meteor.methods.bind(Meteor);

  Meteor.methods = function (handlers) {
    const wrapped = {};
    for (const [name, fn] of Object.entries(handlers)) {
      wrapped[name] = async function (...args) {
        const start = performance.now();
        try {
          return await fn.apply(this, args);
        } finally {
          recordSample(name, performance.now() - start);
        }
      };
    }
    return origMethods(wrapped);
  };

  const outputPath = process.env.METHOD_TIMING_OUTPUT;
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
        process.stderr.write(`[method-timing] dump failed: ${err.message}\n`);
      }
    };
  })();

  process.on('SIGTERM', dumpOnce);
  process.on('SIGINT', dumpOnce);
  process.on('beforeExit', dumpOnce);
}
