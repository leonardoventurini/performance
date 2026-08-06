import { Tinytest } from 'meteor/tinytest';
import {
  buildReliabilityCursorPlans,
  normalizeReliabilityQueryRequest,
  RELIABILITY_QUERY_IDS,
} from './reliability-query-descriptors';

Tinytest.add('tasks-common - preserves the legacy run-scoped query', (test) => {
  const [plan] = buildReliabilityCursorPlans('run-1');
  test.equal(plan, { selector: { runId: 'run-1' }, options: {} });
});

Tinytest.add('tasks-common - forces run and case scope for audit descriptors', (test) => {
  const [plan] = buildReliabilityCursorPlans({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'selector_included',
  });
  test.equal(plan, {
    selector: { runId: 'run-1', caseExecutionId: 'case-1', included: true },
    options: {
      _auditObserverScope: {
        runId: 'run-1',
        caseExecutionId: 'case-1',
        queryId: 'selector_included',
        cursorOrdinal: 0,
        cursorFingerprint: 'cursor-dd875d2e',
      },
    },
  });
});

Tinytest.add('tasks-common - rejects raw query material and unknown descriptors', (test) => {
  test.throws(() => normalizeReliabilityQueryRequest({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'unordered',
    selector: { runId: 'another-run' },
  }), /unknown reliability query fields/);
  test.throws(() => normalizeReliabilityQueryRequest({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'arbitrary_query',
  }), /unknown reliability queryId/);
});

Tinytest.add('tasks-common - closes every declared query descriptor', (test) => {
  for (const queryId of RELIABILITY_QUERY_IDS) {
    const plans = buildReliabilityCursorPlans({ runId: 'run-1', caseExecutionId: 'case-1', queryId });
    test.isTrue(plans.length > 0);
    for (const plan of plans) {
      test.equal(plan.selector.runId, 'run-1');
      test.equal(plan.selector.caseExecutionId, 'case-1');
    }
  }
});

Tinytest.add('tasks-common - returns both server-owned projection cursors', (test) => {
  const plans = buildReliabilityCursorPlans({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'multiple_projections',
  });
  test.equal(plans.length, 2);
  test.equal(plans[0].options.fields, { sequence: 1, projected: 1 });
  test.equal(plans[1].options.fields, { sequence: 1, nested: 1 });
  test.equal(plans[0].options._auditObserverScope.cursorOrdinal, 0);
  test.equal(plans[1].options._auditObserverScope.cursorOrdinal, 1);
  test.isNotUndefined(plans[0].options._auditObserverScope.cursorFingerprint);
  test.isFalse(
    plans[0].options._auditObserverScope.cursorFingerprint
      === plans[1].options._auditObserverScope.cursorFingerprint,
  );
});
