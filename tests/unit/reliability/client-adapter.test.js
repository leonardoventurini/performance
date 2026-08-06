import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReliabilityQueryId } from '../../../reliability/runtime/adapters/clients.js';

test('every declarative query shape maps to one closed fixture descriptor', () => {
  assert.equal(resolveReliabilityQueryId({ kind: 'unordered' }), 'unordered');
  assert.equal(resolveReliabilityQueryId({ kind: 'ordered' }), 'ordered_sequence');
  assert.equal(resolveReliabilityQueryId({ kind: 'projection' }), 'projection_conformance');
  assert.equal(resolveReliabilityQueryId({ kind: 'multiple_projections' }), 'multiple_projections');
  assert.equal(resolveReliabilityQueryId({ kind: 'windowed', limit: 1 }), 'limit_one');
  assert.equal(resolveReliabilityQueryId({ kind: 'windowed', skip: 1 }), 'skip_one');
  assert.equal(resolveReliabilityQueryId({
    kind: 'selector', selector: { field: 'included' },
  }), 'selector_included');
  assert.equal(resolveReliabilityQueryId({
    kind: 'selector', selector: { field: 'cohort' },
  }), 'selector_secondary_cohort');
  assert.equal(resolveReliabilityQueryId({ kind: 'unsupported_selector' }), 'unsupported_near');
  assert.throws(() => resolveReliabilityQueryId({ kind: 'arbitrary' }), /no closed fixture descriptor/);
});
