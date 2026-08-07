import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeclarativeFixture,
  createDatabaseAdapter,
} from '../../../reliability/runtime/adapters/database.js';
import type {
  DeclarativeFixture,
  ReliabilityCollection,
  ReliabilityDocument,
} from '../../../reliability/runtime/adapters/database.js';

function fixtureInput(caseExecutionId: string): Parameters<typeof buildDeclarativeFixture>[0] {
  return {
    definition: {
      fixture: {
        documents: { kind: 'literal', value: 1 },
        payloadBytes: { kind: 'literal', value: 0 },
        generator: 'field_removal_no_stale_residue-v1',
      },
    },
    plan: { coordinate: { seed: 42 }, resolvedParameters: { subscribers: 1 } },
    runId: 'shared-run',
    caseExecutionId,
  };
}

interface TestCollection extends ReliabilityCollection {
  readonly documents: Map<string, ReliabilityDocument>;
}

function collection(): TestCollection {
  const documents = new Map<string, ReliabilityDocument>();
  return {
    documents,
    async insertOne(document: ReliabilityDocument) { documents.set(document._id, structuredClone(document)); },
    async updateOne(selector: Record<string, unknown>, update: Record<string, unknown>) {
      const document = documents.get(String(selector._id));
      if (!document) throw new Error('test document is missing');
      if (update.$set && typeof update.$set === 'object') for (const [key, value] of Object.entries(update.$set)) document[key] = value;
      if (update.$inc && typeof update.$inc === 'object') for (const [key, value] of Object.entries(update.$inc)) document[key] = Number(document[key] ?? 0) + Number(value);
      if (update.$unset && typeof update.$unset === 'object') for (const key of Object.keys(update.$unset)) delete document[key];
      if (update.$push && typeof update.$push === 'object') for (const [key, value] of Object.entries(update.$push)) {
        const values = document[key];
        document[key] = [...(Array.isArray(values) ? values : []), value];
      }
    },
    async replaceOne(selector: Record<string, unknown>, replacement: ReliabilityDocument) { documents.set(String(selector._id), structuredClone(replacement)); },
    async deleteOne(selector: Record<string, unknown>) { documents.delete(String(selector._id)); },
    async deleteMany({ runId }: Record<string, unknown>) { for (const [id, document] of documents) if (document.runId === runId) documents.delete(id); },
    async countDocuments({ runId }: Record<string, unknown>) { return [...documents.values()].filter((document) => document.runId === runId).length; },
  };
}

test('database mutation and expected transition are independent paths', async () => {
  const store = collection();
  const fixture: DeclarativeFixture = { documents: [{
    _id: 'run:0', runId: 'run', caseExecutionId: 'case', sequence: 0, revision: 0,
    counter: 0,
  }] };
  const adapter = createDatabaseAdapter({ collection: store, fixture });
  const resolve = (value: unknown): unknown => value && typeof value === 'object'
    && Reflect.get(value, 'kind') === 'literal' ? Reflect.get(value, 'value') : value;
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
  assert.equal(store.documents.get('run:0')?.counter, 1);
  const outputDocument = output.expectedState[0];
  assert.ok(outputDocument);
  assert.equal(outputDocument.counter, 1);
  outputDocument.counter = 99;
  const expectedDocument = adapter.expectedSnapshot()[0];
  assert.ok(expectedDocument);
  assert.equal(expectedDocument.counter, 1);
});

test('cleanup proves no run-scoped documents remain', async () => {
  const store = collection();
  store.documents.set('one', {
    _id: 'one', runId: 'run', caseExecutionId: 'case', sequence: 0, revision: 0,
  });
  const adapter = createDatabaseAdapter({ collection: store, fixture: { documents: [] } });
  assert.deepEqual(await adapter.cleanup({ runId: 'run' }), {
    cleanup: true, provenance: { cleanup: 'mongodb' },
  });
});

test('fixture identity is isolated by case execution', () => {
  const first = buildDeclarativeFixture(fixtureInput('case-one'));
  const second = buildDeclarativeFixture(fixtureInput('case-two'));

  const firstDocument = first.documents[0];
  const secondDocument = second.documents[0];
  assert.ok(firstDocument && secondDocument);
  assert.notEqual(firstDocument._id, secondDocument._id);
  assert.equal(firstDocument._id, 'shared-run:case-one:0');
  assert.equal(Object.hasOwn(firstDocument, 'ephemeral'), true);
});

test('replacement mutations preserve audit scope without retaining stale fields', async () => {
  const store = collection();
  const fixture: DeclarativeFixture = { documents: [{
    _id: 'run:0', runId: 'run', caseExecutionId: 'case', sequence: 0,
    revision: 0, payload: 'payload', ephemeral: 'stale', projected: 'stale',
  }] };
  const adapter = createDatabaseAdapter({ collection: store, fixture });
  const resolve = (value: unknown): unknown => value;
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
      mutation: { kind: 'generated_document', generator: 'field_removal_no_stale_residue-v1' },
      expectedTransition: { kind: 'replace' },
    },
    resolve,
  });

  const replacement = store.documents.get('run:0');
  assert.ok(replacement);
  assert.equal(replacement.runId, 'run');
  assert.equal(replacement.caseExecutionId, 'case');
  assert.equal(replacement.retained, true);
  assert.equal(Object.hasOwn(replacement, 'ephemeral'), false);
  assert.deepEqual(output.expectedState, [replacement]);
});
