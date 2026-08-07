import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { AsyncLocalStorage } from 'node:async_hooks';

import { deriveObservedFallback, extractAuditScope, validateAuditEchoRequest, validateAuditFaultRequest, validateAuditMonitorRequest } from './audit-observer-contract';
import { privateMongo } from './_private-types';
import type { ObserveDriver, ObserveHandle } from './_private-types';

type AuditScope = NonNullable<ReturnType<typeof extractAuditScope>>;
interface SharedStream {
  _changeStream?: { emit(event: string, value?: unknown): void };
  _restarting?: boolean;
  _restart(): Promise<void>;
}
interface AuditDriver extends ObserveDriver { readonly _sharedStream?: SharedStream }
interface DriverGate { engaged(): boolean; release(): void }
interface ActiveFault { controller: string; gate: DriverGate | null; activatedAt: number }
interface SelectionAttempt { driver: 'changeStreams' | 'oplog' | 'polling'; available: boolean; reason?: string }
interface SelectionContext { scope: AuditScope | null; selection?: { configuredOrder: SelectionAttempt['driver'][]; attempts: SelectionAttempt[] } }
interface Observation extends AuditScope {
  sequence: number; monotonicNs: string; instanceId: string; actualDriver: string;
  multiplexerIdentity: string; fallbackFrom?: string; fallbackReason?: string;
}

const MAX_AUDIT_OBSERVATIONS = 10_000;
const DRIVER_NAMES = Object.freeze({
  ChangeStreamObserveDriver: 'changeStreams',
  OplogObserveDriver: 'oplog',
  PollingObserveDriver: 'polling',
});

const observations: Observation[] = [];
const multiplexerIdentities = new WeakMap<object, string>();
const fallbackProvenanceByMultiplexer = new WeakMap<object, { fallbackFrom: string; fallbackReason: string }>();
const driversByCase = new Map<string, Set<AuditDriver>>();
const activeFaults = new Map<string, ActiveFault>();
const selectionContexts = new AsyncLocalStorage<SelectionContext>();
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

function driverMatchesCase(driver: AuditDriver, caseExecutionId: string): boolean {
  return extractAuditScope(driver._cursorDescription)?.caseExecutionId === caseExecutionId;
}

function installDriverGate(drivers: readonly AuditDriver[], caseExecutionId: string, method: string): DriverGate {
  const prototypes = [...new Set(drivers.map((driver) => Object.getPrototypeOf(driver)))];
  let releaseGate: () => void = () => undefined;
  let engaged = false;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const restorations = prototypes.map((prototype) => {
    const methods = prototype as Record<string, unknown>;
    const original = methods[method];
    if (typeof original !== 'function') throw new Error(`audit fault requires ${method}`);
    const wrapped = async function (this: AuditDriver, ...args: unknown[]) {
      if (driverMatchesCase(this, caseExecutionId)) {
        engaged = true;
        await gate;
      }
      return original.apply(this, args);
    };
    methods[method] = wrapped;
    return () => {
      if (methods[method] === wrapped) methods[method] = original;
    };
  });
  return Object.freeze({
    engaged: () => engaged,
    release() {
      for (const restore of restorations) restore();
      releaseGate();
    },
  });
}

function caseDrivers(caseExecutionId: string): AuditDriver[] {
  const drivers = driversByCase.get(caseExecutionId);
  if (!drivers || drivers.size === 0) throw new Error('audit fault has no correlated observer driver');
  return [...drivers];
}

async function waitForStreams(caseExecutionId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const streams = caseDrivers(caseExecutionId).map((driver) => driver?._sharedStream);
    if (streams.every((stream) => stream?._changeStream && !stream._restarting)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('audit change stream did not recover');
}

function multiplexerIdentity(multiplexer: object | null | undefined): string {
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
  const runId = process.env.AUDIT_RUN_ID;
  const ownershipToken = process.env.AUDIT_OWNERSHIP_TOKEN;
  const instanceId = process.env.AUDIT_INSTANCE_ID;
  patched = true;
  const mongo = privateMongo(MongoInternals?.defaultRemoteCollectionDriver?.()?.mongo);
  if (!mongo) {
    throw new Error('audit observer tracking requires mongo._observeChanges');
  }
  const original = mongo._observeChanges.bind(mongo);
  const selectRuntime = mongo as typeof mongo & {
    _selectReactivityDriver?: (configuredOrder: SelectionAttempt['driver'][], checks: Record<string, () => Promise<{ available: boolean; reason?: string }>>) => Promise<unknown>;
  };
  const originalSelect = selectRuntime._selectReactivityDriver?.bind(selectRuntime);
  if (typeof originalSelect !== 'function') {
    throw new Error('audit observer tracking requires mongo._selectReactivityDriver');
  }
  selectRuntime._selectReactivityDriver = async function (configuredOrder, driverChecks) {
    const context = selectionContexts.getStore();
    if (!context) return originalSelect(configuredOrder, driverChecks);
    const attempts: SelectionAttempt[] = [];
    const observedChecks = Object.fromEntries(Object.entries(driverChecks).map(([driverName, check]) => [
      driverName,
      async (): Promise<{ available: boolean; reason?: string }> => {
        const result = driverName === 'changeStreams'
          && context.scope?.queryId === 'change_stream_unavailable'
          ? { available: false, reason: 'closed audit primitive forced Change Stream unavailability' }
          : await check();
        attempts.push(Object.freeze({
          driver: driverName as SelectionAttempt['driver'],
          available: result?.available === true,
          ...(typeof result?.reason === 'string' && result.reason.length > 0 ? { reason: result.reason } : {}),
        }));
        return result;
      },
    ]));
    const result = await originalSelect(configuredOrder, observedChecks);
    context.selection = { configuredOrder: [...configuredOrder], attempts: [...attempts] };
    return result;
  };
  mongo._observeChanges = async function (...args: unknown[]): Promise<ObserveHandle> {
    const scope = extractAuditScope(args[0]);
    const context: SelectionContext = { scope };
    const correlatedScope = scope?.runId === runId ? scope : null;
    const handle = correlatedScope
      ? await selectionContexts.run(context, () => original(...args))
      : await original(...args);
    if (correlatedScope) {
      const drivers = driversByCase.get(correlatedScope.caseExecutionId) ?? new Set<AuditDriver>();
      if (handle?._multiplexer?._observeDriver) drivers.add(handle._multiplexer._observeDriver as AuditDriver);
      driversByCase.set(correlatedScope.caseExecutionId, drivers);
      const multiplexer = handle?._multiplexer;
      const className = multiplexer?._observeDriver?.constructor?.name;
      const actualDriver = typeof className === 'string' && className in DRIVER_NAMES
        ? DRIVER_NAMES[className as keyof typeof DRIVER_NAMES]
        : `unknown:${className || 'undefined'}`;
      const observedFallback = deriveObservedFallback(context.selection, actualDriver);
      if (observedFallback && multiplexer) {
        fallbackProvenanceByMultiplexer.set(multiplexer, observedFallback);
      }
      const fallback = observedFallback || (multiplexer ? fallbackProvenanceByMultiplexer.get(multiplexer) : undefined);
      observations.push(Object.freeze({
        sequence: ++sequence,
        monotonicNs: process.hrtime.bigint().toString(),
        instanceId,
        runId: correlatedScope.runId,
        caseExecutionId: correlatedScope.caseExecutionId,
        queryId: correlatedScope.queryId,
        cursorOrdinal: correlatedScope.cursorOrdinal,
        cursorFingerprint: correlatedScope.cursorFingerprint,
        actualDriver,
        ...(fallback || {}),
        multiplexerIdentity: multiplexerIdentity(multiplexer),
      }));
      if (observations.length > MAX_AUDIT_OBSERVATIONS) observations.shift();
    }
    return handle;
  };
  Meteor.methods({
    'audit.echo'(request) {
      return validateAuditEchoRequest(request, {
        runId,
        ownershipToken,
      });
    },
    'audit.monitorSnapshot'(request) {
      const filter = validateAuditMonitorRequest(request, {
        runId,
        ownershipToken,
      });
      return observations.filter(({ runId, caseExecutionId }) => (
        runId === filter.runId
        && (filter.caseExecutionId === null || caseExecutionId === filter.caseExecutionId)
      ));
    },
    async 'audit.faultControl'(request) {
      const fault = validateAuditFaultRequest(request, {
        runId,
        ownershipToken,
      }, INTERNAL_FAULT_CONTROLLERS);
      const key = `${fault.caseExecutionId}:${fault.faultId}`;
      const drivers = caseDrivers(fault.caseExecutionId);
      const streams = [...new Set(drivers.map((driver) => driver._sharedStream).filter((stream): stream is SharedStream => Boolean(stream)))];
      if (fault.operation === 'status') {
        const active = activeFaults.get(key);
        if (!active || active.controller !== fault.controller) throw new Error('audit fault was not activated by this process');
        return { activated: true, engaged: active.gate?.engaged() === true, controller: fault.controller, faultId: fault.faultId };
      }
      if (fault.operation === 'activate') {
        if (activeFaults.has(key)) throw new Error('audit fault is already active');
        let gate: DriverGate | null = null;
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
          const error = Object.assign(new Error(`declarative audit fault: ${fault.controller}`), { code: 91 });
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
