import crypto from 'node:crypto';

import { Binary, BSON, ObjectId } from 'mongodb';

import { buildSyntheticDocument } from '../../synthetic-data.js';

function clone(value) {
  return BSON.EJSON.deserialize(BSON.EJSON.serialize(value));
}

function setPath(document, path, value) {
  let target = document;
  for (const part of path.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object') target[part] = {};
    target = target[part];
  }
  target[path.at(-1)] = clone(value);
}

function deletePath(document, path) {
  let target = document;
  for (const part of path.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object') return;
    target = target[part];
  }
  delete target[path.at(-1)];
}

function generatedFields(generator, { seed, payloadBytes }) {
  const hashBytes = crypto.createHash('sha256').update(`${generator}:${seed}`).digest();
  const textPayload = (character) => character.repeat(payloadBytes);
  const fields = {
    'array_shapes-v1': { arrays: [[], [1], [1, { nested: [true, null] }]] },
    'ascii_and_empty_strings-v1': { empty: '', ascii: 'Meteor change streams 0123456789' },
    'binary-v1': { binary: new Binary(hashBytes) },
    'compressible_payload-v1': { payload: textPayload('A') },
    'concurrent_distinct_fields-v1': { writerA: 0, writerB: 0 },
    'dates-v1': { epoch: new Date(0), recent: new Date('2026-01-01T00:00:00.000Z') },
    'ejson_scalars-v1': { finite: 1.5, boolean: true, nil: null },
    'emoji_surrogate_boundaries-v1': { text: 'A🚀B👩🏽‍🚀C' },
    'field_removal_no_stale_residue-v1': { ephemeral: 'remove-me', retained: true },
    'hot_key-v1': { counter: 0, hotKey: 'shared' },
    'identical_projected_state-v1': { projected: 'stable', unpublished: 'before' },
    'near_bson_ceiling-v1': { payload: textPayload('B') },
    'object_ids-v1': { objectId: new ObjectId(hashBytes.subarray(0, 12)) },
    'object_shapes-v1': { object: { alpha: 1, beta: { gamma: true } } },
    'replacement-document-v1': { replacement: true, ephemeral: 'old' },
    'replacement_no_stale_residue-v1': { replacement: true, retained: 'new' },
    'right_to_left_text-v1': { text: 'مرحبا بالعالم — שלום עולם' },
    'seeded_incompressible_payload-v1': { payload: hashBytes.toString('base64').repeat(Math.ceil(payloadBytes / 44)).slice(0, payloadBytes) },
    'unicode_composed_decomposed-v1': { composed: 'é', decomposed: 'e\u0301' },
    'synthetic-document-v1': {},
  }[generator];
  if (!fields) throw new Error(`generator ${generator} is unavailable`);
  return fields;
}

/** Builds independent run/case-scoped fixture documents from a closed generator. */
export function buildDeclarativeFixture({ definition, plan, runId, caseExecutionId }) {
  const documents = Number(definition.fixture.documents.kind === 'parameter'
    ? plan.resolvedParameters[definition.fixture.documents.name]
    : definition.fixture.documents.value);
  const payloadBytes = Number(definition.fixture.payloadBytes.kind === 'parameter'
    ? plan.resolvedParameters[definition.fixture.payloadBytes.name]
    : definition.fixture.payloadBytes.value);
  const fixtureDocuments = Array.from({ length: documents }, (_, index) => ({
    ...buildSyntheticDocument({
      runId,
      sequence: index,
      revision: 0,
      payloadBytes: Math.min(payloadBytes, 8 * 1024 * 1024),
      seed: plan.coordinate.seed,
    }),
    caseExecutionId,
    included: true,
    cohort: index % 2 === 0 ? 'secondary' : 'primary',
    projected: 'initial',
    nested: { value: 'initial' },
    items: [],
    counter: 0,
    ephemeral: 'present',
    ...generatedFields(definition.fixture.generator, { seed: plan.coordinate.seed, payloadBytes }),
  }));
  return Object.freeze({
    documents: Object.freeze(fixtureDocuments),
    subscriberIds: Object.freeze(Array.from(
      { length: plan.resolvedParameters.subscribers },
      (_, index) => `client-${index}`,
    )),
  });
}

function applyTransition(document, transition, resolve) {
  const next = clone(document);
  if (transition.kind === 'delete') return null;
  if (transition.kind === 'replace') return next;
  if (transition.kind === 'set_field') setPath(next, transition.path, resolve(transition.value));
  if (transition.kind === 'remove_field') deletePath(next, transition.path);
  if (transition.kind === 'increment_field') {
    const current = transition.path.reduce((value, part) => value?.[part], next) || 0;
    setPath(next, transition.path, current + Number(resolve(transition.amount)));
  }
  if (transition.kind === 'append_array') {
    const current = transition.path.reduce((value, part) => value?.[part], next) || [];
    setPath(next, transition.path, [...current, resolve(transition.value)]);
  }
  if (transition.kind === 'projection_variant') {
    if (transition.variant === 'field_added') next.projected = 'added';
    if (transition.variant === 'field_changed') next.projected = 'changed';
    if (transition.variant === 'field_removed') delete next.projected;
    if (transition.variant === 'nested_field_changed') next.nested = { value: 'changed' };
    if (transition.variant === 'object_id_preserved') next.objectIdWitness = next.objectId;
  }
  return next;
}

function mongoUpdate(mutation, resolve) {
  if (mutation.kind === 'set') return { $set: { [mutation.path.join('.')]: resolve(mutation.value) } };
  if (mutation.kind === 'unset') return { $unset: { [mutation.path.join('.')]: '' } };
  if (mutation.kind === 'increment') return { $inc: { [mutation.path.join('.')]: resolve(mutation.amount) } };
  if (mutation.kind === 'push') return { $push: { [mutation.path.join('.')]: resolve(mutation.value) } };
  if (mutation.kind === 'projection_variant') {
    if (mutation.variant === 'field_added') return { $set: { projected: 'added' } };
    if (mutation.variant === 'field_changed') return { $set: { projected: 'changed' } };
    if (mutation.variant === 'field_removed') return { $unset: { projected: '' } };
    if (mutation.variant === 'nested_field_changed') return { $set: { 'nested.value': 'changed' } };
    if (mutation.variant === 'object_id_preserved') return { $set: { objectIdWitness: true } };
  }
  throw new Error(`MongoDB mutation ${mutation.kind}:${mutation.variant || ''} is unavailable`);
}

function withRevisionIncrement(update) {
  return {
    ...update,
    $inc: { ...(update.$inc || {}), revision: 1 },
  };
}

/** Creates the database/model adapter for one isolated case. */
export function createDatabaseAdapter({ collection, fixture }) {
  const expected = new Map(fixture.documents.map((document) => [String(document._id), clone(document)]));
  const inserted = new Set();
  return Object.freeze({
    expectedSnapshot: () => [...expected.values()].filter((document) => inserted.has(String(document._id))),
    async write({ step, resolve }) {
      const fixtureDocument = fixture.documents[step.selector.index];
      if (!fixtureDocument) throw new Error('fixture selector is outside the generated document set');
      const id = String(fixtureDocument._id);
      if (step.operation === 'insert_one') {
        const document = step.mutation.kind === 'generated_document'
          ? { ...fixtureDocument, ...generatedFields(step.mutation.generator, {
            seed: Number(resolve({ kind: 'coordinate', field: 'seed' })),
            payloadBytes: Buffer.byteLength(fixtureDocument.payload || ''),
          }) }
          : fixtureDocument;
        await collection.insertOne(clone(document));
        expected.set(id, applyTransition(document, step.expectedTransition, resolve));
        inserted.add(id);
      } else if (step.operation === 'update_one') {
        await collection.updateOne(
          { _id: fixtureDocument._id },
          withRevisionIncrement(mongoUpdate(step.mutation, resolve)),
        );
        const transitioned = applyTransition(expected.get(id), step.expectedTransition, resolve);
        transitioned.revision = Number(transitioned.revision || 0) + 1;
        expected.set(id, transitioned);
      } else if (step.operation === 'replace_one') {
        const replacement = {
          _id: fixtureDocument._id,
          runId: fixtureDocument.runId,
          caseExecutionId: fixtureDocument.caseExecutionId,
          sequence: fixtureDocument.sequence,
          ...generatedFields(
            step.mutation.generator || 'replacement-document-v1',
            { seed: 0, payloadBytes: Buffer.byteLength(fixtureDocument.payload || '') },
          ),
          revision: Number(expected.get(id)?.revision || 0) + 1,
        };
        await collection.replaceOne({ _id: fixtureDocument._id }, replacement);
        expected.set(id, replacement);
      } else if (step.operation === 'delete_one') {
        await collection.deleteOne({ _id: fixtureDocument._id });
        expected.delete(id);
        inserted.delete(id);
      } else {
        throw new Error(`MongoDB operation ${step.operation} is unavailable`);
      }
      return { expectedState: clone([...expected.values()].filter((document) => inserted.has(String(document._id)))) };
    },
    async cleanup({ runId, signal }) {
      if (signal?.aborted) throw signal.reason;
      await collection.deleteMany({ runId });
      const remaining = await collection.countDocuments({ runId });
      return { cleanup: remaining === 0, provenance: { cleanup: 'mongodb' } };
    },
  });
}
