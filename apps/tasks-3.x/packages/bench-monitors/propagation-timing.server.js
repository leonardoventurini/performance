// Measures server-internal write-to-emit latency: time from
// Collection.insertAsync resolving to the moment Meteor's observer
// machinery emits the corresponding `added`/`changed` DDP message
// for EACH subscribed client. The metric most directly attributable
// to observer driver choice (changeStreams vs oplog vs polling) —
// a 100 ms propagation regression invisible in CPU/RAM shows up here.
//
// Surfaces as `metrics.live_update_propagation` (flat aggregate — not
// per-publication, not per-doc).
//
// Why a server-side Map keyed by docId, NOT __benchPushedAt in the doc:
//   1. In-doc field pollutes Mongo schema permanently.
//   2. Initial-batch contamination: when a new subscriber connects,
//      Meteor's observer sends sendAdded for ALL existing docs in the
//      cursor. With __benchPushedAt in those docs, we'd record their
//      ancient timestamps as "propagation" — they aren't.
// The Map + 10 s TTL solves both: only freshly-written docs are
// tracked, the map auto-prunes, and re-deliveries past the TTL are
// silently ignored.
//
// Two hooks:
//   - Mongo.Collection.prototype.insertAsync → record (docId, now)
//     post-await. One prototype patch covers every Collection instance,
//     current and future. No app code change required.
//   - Session.prototype.sendAdded + sendChanged → if docId in map,
//     record (now - mapValue) as a propagation sample. Grabbed
//     lazily off the first incoming connection (class isn't exported).
//
// Gated on PROPAGATION_TIMING_OUTPUT — without the env var, init is a
// no-op and Mongo writes are never wrapped (no per-insert overhead).
//
// Caveats (documented in package README):
//   - Only insert→emit propagation is measured; update-driven changed
//     events are observed but the update path isn't yet wrapped (no
//     map entry written), so changed events for non-tracked docs are
//     silent no-ops. Future task can wrap updateAsync.
//   - Polling driver propagation is dominated by poll interval (10 s
//     default), so the numbers will look very different per driver.

import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
import { installDumpOnShutdown } from './_dump-on-shutdown';

const MAX_SAMPLES = 100_000;
const ATTRIBUTION_TTL_MS = 10_000;
const CLEANUP_INTERVAL_MS = 5_000;

const insertTimestamps = new Map(); // docId(string) -> insertTime(ms)
const samples = []; // flat array of propagation latency ms

function recordInsert(id) {
  if (id == null) return;
  insertTimestamps.set(String(id), Date.now());
}

function recordPropagation(id) {
  if (id == null) return;
  if (samples.length >= MAX_SAMPLES) return;
  const key = String(id);
  const start = insertTimestamps.get(key);
  if (start == null) return;
  const elapsed = Date.now() - start;
  if (elapsed > ATTRIBUTION_TTL_MS) {
    // Stale — past the attribution window. Drop the entry and skip
    // (could be a late re-delivery to a new subscriber).
    insertTimestamps.delete(key);
    return;
  }
  samples.push(elapsed);
}

let patched = false;
let prototypePatched = false;
let cleanupTimer = null;

export function initPropagationTiming() {
  if (patched) return;
  const outputPath = process.env.PROPAGATION_TIMING_OUTPUT;
  if (!outputPath) return;
  patched = true;

  // Wrap Mongo.Collection.prototype.insertAsync — captures every
  // insert into any Collection instance.
  const protoInsert = Mongo.Collection.prototype.insertAsync;
  Mongo.Collection.prototype.insertAsync = async function (...args) {
    const id = await protoInsert.apply(this, args);
    recordInsert(id);
    return id;
  };

  // Patch Session.prototype.sendAdded / sendChanged once, off the first
  // incoming connection's session. Session class isn't exported.
  Meteor.onConnection((conn) => {
    if (prototypePatched) return;
    const session = conn._session;
    if (!session) return;
    const proto = Object.getPrototypeOf(session);
    const origSendAdded = proto.sendAdded;
    proto.sendAdded = function (collection, id, fields) {
      recordPropagation(id);
      return origSendAdded.call(this, collection, id, fields);
    };
    const origSendChanged = proto.sendChanged;
    proto.sendChanged = function (collection, id, fields) {
      recordPropagation(id);
      return origSendChanged.call(this, collection, id, fields);
    };
    prototypePatched = true;
  });

  // Periodic prune so long benchmarks don't grow the timestamps map
  // unbounded. unref() so the timer doesn't prevent process exit.
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - ATTRIBUTION_TTL_MS;
    for (const [key, ts] of insertTimestamps) {
      if (ts < cutoff) insertTimestamps.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  installDumpOnShutdown(outputPath, () => samples, 'propagation-timing');
}
