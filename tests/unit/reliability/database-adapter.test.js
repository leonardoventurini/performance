import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatabaseAdapter } from '../../../reliability/runtime/adapters/database.js';

function collection() {
  const documents = new Map();
  return {
    documents,
    async insertOne(document) { documents.set(document._id, structuredClone(document)); },
    async updateOne(selector, update) {
      const document = documents.get(selector._id);
      if (update.$set) for (const [key, value] of Object.entries(update.$set)) document[key] = value;
      if (update.$inc) for (const [key, value] of Object.entries(update.$inc)) document[key] += value;
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete document[key];
      if (update.$push) for (const [key, value] of Object.entries(update.$push)) document[key].push(value);
    },
    async replaceOne(selector, replacement) { documents.set(selector._id, structuredClone(replacement)); },
    async deleteOne(selector) { documents.delete(selector._id); },
    async deleteMany({ runId }) { for (const [id, document] of documents) if (document.runId === runId) documents.delete(id); },
    async countDocuments({ runId }) { return [...documents.values()].filter((document) => document.runId === runId).length; },
  };
}

test('database mutation and expected transition are independent paths', async () => {
  const store = collection();
  const fixture = { documents: [{ _id: 'run:0', runId: 'run', counter: 0 }] };
  const adapter = createDatabaseAdapter({ collection: store, fixture });
  const resolve = (value) => value?.kind === 'literal' ? value.value : value;
  await adapter.write({
    step: {
      operation: 'insert_one', selector: { index: 0 }, mutation: { kind: 'fixture_document' },
      expectedTransition: { kind: 'insert' },
    },
    resolve,
  });
  const output = await adapter.write({
    step: {
      operation: 'update_one', selector: { index: 0 }, mutation: { kind: 'increment', path: ['counter'], amount: 1 },
      expectedTransition: { kind: 'increment_field', path: ['counter'], amount: 1 },
    },
    resolve,
  });
  assert.equal(store.documents.get('run:0').counter, 1);
  assert.equal(output.expectedState[0].counter, 1);
  output.expectedState[0].counter = 99;
  assert.equal(adapter.expectedSnapshot()[0].counter, 1);
});

test('cleanup proves no run-scoped documents remain', async () => {
  const store = collection();
  store.documents.set('one', { _id: 'one', runId: 'run' });
  const adapter = createDatabaseAdapter({ collection: store, fixture: { documents: [] } });
  assert.deepEqual(await adapter.cleanup({ runId: 'run' }), {
    cleanup: true, provenance: { cleanup: 'mongodb' },
  });
});

test('replacement mutations preserve audit scope without retaining stale fields', async () => {
  const store = collection();
  const fixture = { documents: [{
    _id: 'run:0', runId: 'run', caseExecutionId: 'case', sequence: 0,
    revision: 0, payload: 'payload', ephemeral: 'stale', projected: 'stale',
  }] };
  const adapter = createDatabaseAdapter({ collection: store, fixture });
  const resolve = (value) => value;
  await adapter.write({
    step: {
      operation: 'insert_one', selector: { index: 0 }, mutation: { kind: 'fixture_document' },
      expectedTransition: { kind: 'insert' },
    },
    resolve,
  });
  const output = await adapter.write({
    step: {
      operation: 'replace_one', selector: { index: 0 },
      mutation: { kind: 'generated_document', generator: 'replacement_no_stale_residue-v1' },
      expectedTransition: { kind: 'replace' },
    },
    resolve,
  });

  const replacement = store.documents.get('run:0');
  assert.equal(replacement.runId, 'run');
  assert.equal(replacement.caseExecutionId, 'case');
  assert.equal(replacement.retained, 'new');
  assert.equal(Object.hasOwn(replacement, 'ephemeral'), false);
  assert.deepEqual(output.expectedState, [replacement]);
});
