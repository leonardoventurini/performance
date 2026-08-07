import { assert } from './test-assertions';
import {
  buildReliabilityCursorPlans,
  normalizeReliabilityQueryRequest,
  RELIABILITY_QUERY_IDS,
} from './reliability-query-descriptors';
import { parseTaskDocuments } from './tasks-collection';

it('validates task documents returned by the method boundary', () => {
  const createdAt = new Date('2026-08-07T12:00:00.000Z');
  const [document] = parseTaskDocuments([{
    _id: 'task-1',
    sessionId: 'session-1',
    description: 'Validated task',
    createdAt,
  }]);

  if (!document) throw new Error('valid task payload must produce one document');
  assert.equal(document._id, 'task-1');
  assert.equal(document.sessionId, 'session-1');
  assert.equal(document.description, 'Validated task');
  assert.equal(document.createdAt, createdAt);
});

it('rejects malformed task entries returned by the method boundary', () => {
  const validTask = {
    _id: 'task-1',
    sessionId: 'session-1',
    description: 'Validated task',
    createdAt: new Date('2026-08-07T12:00:00.000Z'),
  };

  assert.throws(() => parseTaskDocuments({}), /non-array payload/);
  assert.throws(() => parseTaskDocuments([null]), /index 0: expected an object/);
  assert.throws(() => parseTaskDocuments([{ ...validTask, _id: 42 }]), /_id must be a string/);
  assert.throws(() => parseTaskDocuments([{ ...validTask, sessionId: 42 }]), /sessionId must be a string/);
  assert.throws(() => parseTaskDocuments([{ ...validTask, description: undefined }]), /description must be a string/);
  assert.throws(() => parseTaskDocuments([{ ...validTask, createdAt: '2026-08-07' }]), /createdAt must be a valid Date/);
  assert.throws(() => parseTaskDocuments([{ ...validTask, createdAt: new Date('invalid') }]), /createdAt must be a valid Date/);
  assert.throws(() => parseTaskDocuments([{ ...validTask, unexpected: true }]), /unknown field unexpected/);
});

it('preserves the legacy run-scoped query', () => {
  const [plan] = buildReliabilityCursorPlans('run-1');
  assert.deepEqual(plan, { selector: { runId: 'run-1' }, options: {} });
});

it('forces run and case scope for audit descriptors', () => {
  const [plan] = buildReliabilityCursorPlans({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'selector_included',
  });
  assert.deepEqual(plan, {
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

it('rejects raw query material and unknown descriptors', () => {
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

it('closes every declared query descriptor', () => {
  for (const queryId of RELIABILITY_QUERY_IDS) {
    const plans = buildReliabilityCursorPlans({ runId: 'run-1', caseExecutionId: 'case-1', queryId });
    if (plans.length === 0) throw new Error(`${queryId} must produce a cursor plan`);
    for (const plan of plans) {
      assert.equal(plan.selector.runId, 'run-1');
      assert.equal(plan.selector.caseExecutionId, 'case-1');
    }
  }
});

it('returns both server-owned projection cursors', () => {
  const plans = buildReliabilityCursorPlans({
    runId: 'run-1',
    caseExecutionId: 'case-1',
    queryId: 'multiple_projections',
  });
  const firstPlan = plans[0];
  const secondPlan = plans[1];
  if (!firstPlan || !secondPlan) throw new Error('multiple_projections must return two plans');
  assert.equal(plans.length, 2);
  assert.deepEqual(firstPlan.options.fields, { sequence: 1, projected: 1 });
  assert.deepEqual(secondPlan.options.fields, { sequence: 1, nested: 1 });
  assert.equal(firstPlan.options._auditObserverScope?.cursorOrdinal, 0);
  assert.equal(secondPlan.options._auditObserverScope?.cursorOrdinal, 1);
  assert.notEqual(
    firstPlan.options._auditObserverScope?.cursorFingerprint,
    secondPlan.options._auditObserverScope?.cursorFingerprint,
  );
});
