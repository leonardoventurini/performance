import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReliabilityCursorPlans,
  normalizeReliabilityQueryRequest,
  RELIABILITY_QUERY_IDS,
} from '../../../apps/tasks-3.x/packages/tasks-common/reliability-query-descriptors.js';

test('legacy subscriptions remain scoped to the requested run', () => {
  assert.deepEqual(buildReliabilityCursorPlans('run-1'), [
    { selector: { runId: 'run-1' }, options: {} },
  ]);
});

test('declarative subscriptions force run and case scope', () => {
  const [plan] = buildReliabilityCursorPlans({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'selector_included',
  });
  assert.deepEqual(plan.selector, {
    runId: 'run-1',
    caseExecutionId: 'case-1',
    included: true,
  });
  assert.deepEqual(plan.options._auditObserverScope, {
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'selector_included',
    cursorOrdinal: 0,
    cursorFingerprint: 'cursor-dd875d2e',
  });
});

test('subscriptions cannot inject selectors or MongoDB options', () => {
  assert.throws(() => normalizeReliabilityQueryRequest({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'unordered',
    selector: { runId: 'another-run' },
  }), /unknown reliability query fields/);
  assert.throws(() => normalizeReliabilityQueryRequest({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'arbitrary_query',
  }), /unknown reliability queryId/);
});

test('every query descriptor preserves the mandatory audit scope', () => {
  for (const queryId of RELIABILITY_QUERY_IDS) {
    const plans = buildReliabilityCursorPlans({
      runId: 'run-1',
      caseExecutionId: 'case-1',
      queryId,
    });
    assert.ok(plans.length > 0);
    for (const plan of plans) {
      assert.equal(plan.selector.runId, 'run-1');
      assert.equal(plan.selector.caseExecutionId, 'case-1');
    }
  }
});

test('multiple projection descriptors return both server-owned cursors', () => {
  const plans = buildReliabilityCursorPlans({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'multiple_projections',
  });
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].options.fields, { sequence: 1, projected: 1 });
  assert.deepEqual(plans[1].options.fields, { sequence: 1, nested: 1 });
});
