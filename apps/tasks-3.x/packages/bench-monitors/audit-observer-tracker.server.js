import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';

import { extractAuditScope, validateAuditEchoRequest, validateAuditFaultRequest, validateAuditMonitorRequest } from './audit-observer-contract';

const MAX_AUDIT_OBSERVATIONS = 10_000;
const DRIVER_NAMES = Object.freeze({
  ChangeStreamObserveDriver: 'changeStreams',
  OplogObserveDriver: 'oplog',
  PollingObserveDriver: 'polling',
});

const observations = [];
const multiplexerIdentities = new WeakMap();
const driversByCase = new Map();
const activeFaults = new Map();
let sequence = 0;
let multiplexerSequence = 0;
let patched = false;
const INTERNAL_FAULT_CONTROLLERS = Object.freeze([
  'change_stream_recoverable_error',
  'change_stream_repeated_restart',
  'change_stream_unexpected_close',
  'stream_restart',
  'startup_snapshot_pause',
  'watch_setup_pause',
  'writes_continue_during_recovery',
]);

function driverMatchesCase(driver, caseExecutionId) {
  return driver?._cursorDescription?.selector?.caseExecutionId === caseExecutionId
    || extractAuditScope(driver?._cursorDescription)?.caseExecutionId === caseExecutionId;
}

function installDriverGate(drivers, caseExecutionId, method) {
  const prototypes = [...new Set(drivers.map((driver) => Object.getPrototypeOf(driver)))];
  let release;
  let engaged = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const restorations = prototypes.map((prototype) => {
    const original = prototype[method];
    if (typeof original !== 'function') throw new Error(`audit fault requires ${method}`);
    const wrapped = async function (...args) {
      if (driverMatchesCase(this, caseExecutionId)) {
        engaged = true;
        await gate;
      }
      return original.apply(this, args);
    };
    prototype[method] = wrapped;
    return () => {
      if (prototype[method] === wrapped) prototype[method] = original;
    };
  });
  return Object.freeze({
    engaged: () => engaged,
    release() {
      for (const restore of restorations) restore();
      release();
    },
  });
}

function caseDrivers(caseExecutionId) {
  const drivers = driversByCase.get(caseExecutionId);
  if (!drivers || drivers.size === 0) throw new Error('audit fault has no correlated observer driver');
  return [...drivers];
}

async function waitForStreams(caseExecutionId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const streams = caseDrivers(caseExecutionId).map((driver) => driver?._sharedStream);
    if (streams.every((stream) => stream?._changeStream && !stream._restarting)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('audit change stream did not recover');
}

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
      const drivers = driversByCase.get(scope.caseExecutionId) || new Set();
      if (handle?._multiplexer?._observeDriver) drivers.add(handle._multiplexer._observeDriver);
      driversByCase.set(scope.caseExecutionId, drivers);
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
    'audit.echo'(request) {
      return validateAuditEchoRequest(request, {
        runId: process.env.AUDIT_RUN_ID,
        ownershipToken: process.env.AUDIT_OWNERSHIP_TOKEN,
      });
    },
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
    async 'audit.faultControl'(request) {
      const fault = validateAuditFaultRequest(request, {
        runId: process.env.AUDIT_RUN_ID,
        ownershipToken: process.env.AUDIT_OWNERSHIP_TOKEN,
      }, INTERNAL_FAULT_CONTROLLERS);
      const key = `${fault.caseExecutionId}:${fault.faultId}`;
      const drivers = caseDrivers(fault.caseExecutionId);
      const streams = [...new Set(drivers.map((driver) => driver?._sharedStream).filter(Boolean))];
      if (fault.operation === 'status') {
        const active = activeFaults.get(key);
        if (!active || active.controller !== fault.controller) throw new Error('audit fault was not activated by this process');
        return { activated: true, engaged: active.gate?.engaged() === true, controller: fault.controller, faultId: fault.faultId };
      }
      if (fault.operation === 'activate') {
        if (activeFaults.has(key)) throw new Error('audit fault is already active');
        let gate = null;
        if (fault.controller === 'startup_snapshot_pause') {
          gate = installDriverGate(drivers, fault.caseExecutionId, '_sendInitialAdds');
        } else if (fault.controller === 'watch_setup_pause') {
          gate = installDriverGate(drivers, fault.caseExecutionId, '_startWatching');
        } else if (streams.length === 0) {
          throw new Error('audit fault requires an active shared change stream');
        } else if (fault.controller === 'change_stream_unexpected_close') {
          for (const stream of streams) stream._changeStream?.emit('close');
        } else if (fault.controller === 'stream_restart') {
          await Promise.all(streams.map((stream) => stream._restart()));
        } else if (fault.controller === 'change_stream_repeated_restart') {
          await Promise.all(streams.map(async (stream) => { await stream._restart(); await stream._restart(); }));
        } else {
          const error = new Error(`declarative audit fault: ${fault.controller}`);
          error.code = 91;
          for (const stream of streams) stream._changeStream?.emit('error', error);
        }
        activeFaults.set(key, { ...fault, activatedAt: Date.now(), gate });
        return { activated: true, restored: false, controller: fault.controller, faultId: fault.faultId };
      }
      const active = activeFaults.get(key);
      if (!active || active.controller !== fault.controller) throw new Error('audit fault was not activated by this process');
      if (active.gate) active.gate.release();
      else await waitForStreams(fault.caseExecutionId);
      activeFaults.delete(key);
      return { activated: true, restored: true, controller: fault.controller, faultId: fault.faultId };
    },
  });
}
