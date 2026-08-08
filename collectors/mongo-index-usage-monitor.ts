// Mongo index-usage collector. Standalone ESM script spawned by the
// harness like mongo-ops-monitor.js. Connects to the target Mongo,
// snapshots per-index `$indexStats` (accesses.ops + since) for each
// app collection at startup and again on SIGTERM, computes per-index
// ops_in_window deltas, and emits the `metrics.mongo_index_usage` JSON
// to stdout on shutdown.
//
// Usage (the harness wires this):
//   node mongo-index-usage-monitor.js <mongoUri>
//
// On any error during init (Mongo unreachable, auth fails, no
// collections, etc.) we log to stderr and exit 0 with NO stdout —
// stopCollectors treats that as "no result" and omits the
// mongo_index_usage key entirely (absence convention CC-5). Other
// metrics in the run are unaffected.
//
// CC-6: the mongodb driver comes through runner/_io.js (io.MongoClient)
// so it's swappable/mockable without DI in this script's signature.

import { io } from '../runner/_io.js';
import { aggregateIndexUsage } from '../runner/index-usage-aggregator.js';
import { errorMessage } from '../lib/benchmark-types.js';

const uri = process.argv[2];
if (!uri) {
  process.stderr.write('[mongo-index] missing mongoUri argv\n');
  process.exit(0);
}

// Meteor's local dev Mongo serves app data from the `meteor` database
// (tools/runners/run-mongo.js → mongodb://<hosts>/meteor). The harness
// builds a bare URI without the path, so prefer an explicit db from the
// URI and fall back to `meteor` rather than the driver's `test` default.
function dbNameFromUri(mongoUri: string): string {
  try {
    const { pathname } = new URL(mongoUri);
    const name = pathname.replace(/^\//, '').split('/')[0];
    return name || 'meteor';
  } catch {
    return 'meteor';
  }
}

const client = new io.MongoClient(uri);
const db = client.db(dbNameFromUri(uri));
type IndexSnapshot = Record<string, Array<{ name: string; accesses?: { ops?: number; since?: Date }; key?: unknown }>>;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
let startSnap: IndexSnapshot | null = null;
let collectionNames: string[] = [];
let finished = false;

// Non-system, non-internal user collections. Mongo exposes `system.*`
// (e.g. system.views) and we skip those; the spec also flags possible
// Meteor-internal namespaces, so we drop anything that isn't a plain
// alphanumeric-leading name.
async function listUserCollections(): Promise<string[]> {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  return infos
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.') && /^[A-Za-z]/.test(name));
}

// One $indexStats snapshot for every tracked collection, keyed by name:
//   { <coll>: [ { name, accesses: { ops, since }, key }, ... ] }
async function snapshotIndexStats(names: readonly string[]): Promise<IndexSnapshot> {
  const snap: IndexSnapshot = {};
  for (const coll of names) {
    try {
      const rows = await db.collection(coll).aggregate([{ $indexStats: {} }]).toArray();
      snap[coll] = rows.flatMap((row) => {
        const name: unknown = row.name;
        const rawAccesses: unknown = row.accesses;
        const key: unknown = row.key;
        if (typeof name !== 'string') return [];
        const accesses = isRecord(rawAccesses) ? rawAccesses : null;
        const ops = accesses?.ops;
        const since = accesses?.since;
        return [{
          name,
          ...(accesses ? { accesses: {
            ...(typeof ops === 'number' ? { ops } : {}),
            ...(since instanceof Date ? { since } : {}),
          } } : {}),
          key,
        }];
      });
    } catch (err) {
      // A collection can vanish mid-run, or $indexStats can be refused on
      // an exotic collection type — skip it, keep the rest of the run.
      process.stderr.write(`[mongo-index] $indexStats failed for ${coll}: ${errorMessage(err)}\n`);
    }
  }
  return snap;
}

async function finishAndExit(): Promise<void> {
  if (finished) return;
  finished = true;
  try {
    if (!startSnap) {
      process.stderr.write('[mongo-index] never initialized — no baseline\n');
      return;
    }
    const endSnap = await snapshotIndexStats(collectionNames);
    const result = aggregateIndexUsage({ start: startSnap, end: endSnap, collections: collectionNames });
    // aggregateIndexUsage returns null when nothing was found — emit no
    // stdout so the key is omitted (CC-5).
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stderr.write(`[mongo-index] error reading endpoint: ${errorMessage(err)}\n`);
  } finally {
    await client.close().catch(() => {});
    process.exit(0);
  }
}

process.on('SIGTERM', finishAndExit);
process.on('SIGINT', finishAndExit);

try {
  await client.connect();
  collectionNames = await listUserCollections();
  if (collectionNames.length === 0) {
    process.stderr.write('[mongo-index] no user collections found — nothing to track\n');
    await client.close().catch(() => {});
    process.exit(0);
  }
  startSnap = await snapshotIndexStats(collectionNames);
  process.stderr.write(`[mongo-index] baseline captured for ${collectionNames.join(',')}\n`);
} catch (err) {
  process.stderr.write(`[mongo-index] init failed: ${errorMessage(err)}\n`);
  process.exit(0);
}
