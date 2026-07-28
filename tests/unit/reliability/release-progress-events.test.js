import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createProgressEvent,
  validateProgressEvent,
} from '../../../reliability/release-audit/progress-events.js';

describe('release audit progress events', () => {
  test('creates a bounded event bound to one audit', () => {
    const event = createProgressEvent({
      auditId: 'audit-1',
      sequence: 1,
      startedAt: 1_000,
      now: 1_025,
      kind: 'audit_started',
      state: 'planned',
      payload: { contractId: 'contract-1', totalLogicalCases: 4 },
    });
    assert.equal(event.elapsedMs, 25);
    assert.equal(validateProgressEvent(event, 'audit-1').sequence, 1);
  });

  test('rejects cross-audit, unknown, secret-shaped, and oversized records', () => {
    const event = {
      auditId: 'audit-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      elapsedMs: 0,
      kind: 'audit_started',
      state: 'planned',
      payload: {},
    };
    assert.throws(() => validateProgressEvent(event, 'audit-2'), /does not match/u);
    assert.throws(() => validateProgressEvent({ ...event, extra: true }), /unknown/u);
    assert.throws(() => validateProgressEvent({
      ...event,
      payload: { detail: 'x'.repeat(3_000) },
    }), /exceeds/u);
  });

  test('requires case identity only for case events', () => {
    const base = {
      auditId: 'audit-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      elapsedMs: 0,
      kind: 'case_started',
      state: 'preflighted',
      payload: {},
    };
    assert.throws(() => validateProgressEvent(base, 'audit-1'), /coordinate/u);
    assert.throws(() => validateProgressEvent({
      ...base,
      kind: 'audit_started',
      state: 'planned',
      coordinate: {},
      attemptId: 'attempt-1',
    }, 'audit-1'), /must not identify/u);
  });
});
