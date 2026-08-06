import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';

import { extractAuditScope, validateAuditMonitorRequest } from './audit-observer-contract';

const MAX_AUDIT_OBSERVATIONS = 10_000;
const DRIVER_NAMES = Object.freeze({
  ChangeStreamObserveDriver: 'changeStreams',
  OplogObserveDriver: 'oplog',
  PollingObserveDriver: 'polling',
});

const observations = [];
const multiplexerIdentities = new WeakMap();
let sequence = 0;
let multiplexerSequence = 0;
let patched = false;

function multiplexerIdentity(multiplexer) {
  if (!multiplexer || typeof multiplexer !== 'object') return 'unavailable';
  const existing = multiplexerIdentities.get(multiplexer);
  if (existing) return existing;
  const identity = `${process.env.AUDIT_INSTANCE_ID}:multiplexer:${++multiplexerSequence}`;
  multiplexerIdentities.set(multiplexer, identity);
  return identity;
}

/** Records per-cursor actual observer identity with run/case correlation. */
export function initAuditObserverTracker() {
  if (patched || !process.env.AUDIT_RUN_ID || !process.env.AUDIT_OWNERSHIP_TOKEN) return;
  if (!process.env.AUDIT_INSTANCE_ID) {
    throw new Error('audit observer tracking requires AUDIT_INSTANCE_ID');
  }
  patched = true;
  const mongo = MongoInternals?.defaultRemoteCollectionDriver?.()?.mongo;
  if (!mongo || typeof mongo._observeChanges !== 'function') {
    throw new Error('audit observer tracking requires mongo._observeChanges');
  }
  const original = mongo._observeChanges.bind(mongo);
  mongo._observeChanges = async function (...args) {
    const handle = await original(...args);
    const scope = extractAuditScope(args[0]);
    if (scope?.runId === process.env.AUDIT_RUN_ID) {
      const className = handle?._multiplexer?._observeDriver?.constructor?.name;
      observations.push(Object.freeze({
        sequence: ++sequence,
        monotonicNs: process.hrtime.bigint().toString(),
        instanceId: process.env.AUDIT_INSTANCE_ID,
        runId: scope.runId,
        caseExecutionId: scope.caseExecutionId,
        queryId: scope.queryId,
        cursorOrdinal: scope.cursorOrdinal,
        cursorFingerprint: scope.cursorFingerprint,
        actualDriver: DRIVER_NAMES[className] || `unknown:${className || 'undefined'}`,
        multiplexerIdentity: multiplexerIdentity(handle?._multiplexer),
      }));
      if (observations.length > MAX_AUDIT_OBSERVATIONS) observations.shift();
    }
    return handle;
  };
  Meteor.methods({
    'audit.monitorSnapshot'(request) {
      const filter = validateAuditMonitorRequest(request, {
        runId: process.env.AUDIT_RUN_ID,
        ownershipToken: process.env.AUDIT_OWNERSHIP_TOKEN,
      });
      return observations.filter(({ runId, caseExecutionId }) => (
        runId === filter.runId
        && (filter.caseExecutionId === null || caseExecutionId === filter.caseExecutionId)
      ));
    },
  });
}
