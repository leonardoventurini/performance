import crypto from 'node:crypto';

import { Binary, BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

import type {
  DeclarativeMutation,
  DeclarativeTransition,
  DeclarativeValueRef,
} from '../../contracts/declarative-audit.js';
import { buildSyntheticDocument } from '../../synthetic-data.js';

type MutableDocument = Record<string, unknown>;

/** MongoDB document shape owned by one declarative case. */
export interface ReliabilityDocument extends Document {
  _id: string;
  runId: string;
  caseExecutionId: string;
  sequence: number;
  revision: number;
  payload?: string;
}

/** Immutable fixture generated before a case starts. */
export interface DeclarativeFixture {
  readonly [key: string]: unknown;
  readonly documents: readonly ReliabilityDocument[];
  readonly subscriberIds?: readonly string[];
}

interface FixtureBuildPlan {
  readonly coordinate: Readonly<{ seed: number }>;
  readonly resolvedParameters: Readonly<Record<string, unknown>>;
}

interface FixtureBuildDefinition {
  readonly fixture: Readonly<{
    generator: string;
    documents: DeclarativeValueRef;
    payloadBytes: DeclarativeValueRef;
  }>;
}

interface DatabaseWriteStep {
  readonly operation: string;
  readonly selector: Readonly<{ index: number }>;
  readonly mutation: DeclarativeMutation;
  readonly expectedTransition: DeclarativeTransition;
}

type ResolveValue = (reference: unknown) => unknown;

/** Minimal Mongo collection boundary used by the database adapter and its tests. */
export interface ReliabilityCollection {
  insertOne(document: ReliabilityDocument): Promise<unknown>;
  updateOne(selector: Document, update: Document): Promise<unknown>;
  replaceOne(selector: Document, replacement: ReliabilityDocument): Promise<unknown>;
  deleteOne(selector: Document): Promise<unknown>;
  deleteMany(selector: Document): Promise<unknown>;
  countDocuments(selector: Document): Promise<number>;
}

function cloneValue(value: unknown): unknown {
  return BSON.EJSON.deserialize(BSON.EJSON.serialize(value));
}

function cloneDocument(document: ReliabilityDocument): ReliabilityDocument {
  const cloned = cloneValue(document);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new TypeError('reliability document clone is invalid');
  }
  return {
    ...cloned,
    _id: String(Reflect.get(cloned, '_id')),
    runId: String(Reflect.get(cloned, 'runId')),
    caseExecutionId: String(Reflect.get(cloned, 'caseExecutionId')),
    sequence: Number(Reflect.get(cloned, 'sequence')),
    revision: Number(Reflect.get(cloned, 'revision')),
    ...(typeof Reflect.get(cloned, 'payload') === 'string' ? { payload: Reflect.get(cloned, 'payload') } : {}),
  };
}

function setPath(document: MutableDocument, path: readonly string[], value: unknown): void {
  const finalPart = path.at(-1);
  if (finalPart === undefined) throw new Error('document path must not be empty');
  let target = document;
  for (const part of path.slice(0, -1)) {
    const child = target[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) target[part] = {};
    const next = target[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('document path is not traversable');
    target = Object.fromEntries(Object.entries(next));
  }
  target[finalPart] = cloneValue(value);
}

function deletePath(document: MutableDocument, path: readonly string[]): void {
  const finalPart = path.at(-1);
  if (finalPart === undefined) throw new Error('document path must not be empty');
  let target = document;
  for (const part of path.slice(0, -1)) {
    const child = target[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) return;
    target = Object.fromEntries(Object.entries(child));
  }
  delete target[finalPart];
}

function generatedFields(generator: string, { seed, payloadBytes }: Readonly<{
  seed: number;
  payloadBytes: number;
}>): MutableDocument {
  const hashBytes = crypto.createHash('sha256').update(`${generator}:${seed}`).digest();
  const textPayload = (character: string): string => character.repeat(payloadBytes);
  const generators: Readonly<Record<string, () => MutableDocument>> = {
    'array_shapes-v1': () => ({ arrays: [[], [1], [1, { nested: [true, null] }]] }),
    'ascii_and_empty_strings-v1': () => ({ empty: '', ascii: 'Meteor change streams 0123456789' }),
    'binary-v1': () => ({ binary: new Binary(hashBytes) }),
    'compressible_payload-v1': () => ({ payload: textPayload('A') }),
    'concurrent_distinct_fields-v1': () => ({ writerA: 0, writerB: 0 }),
    'dates-v1': () => ({ epoch: new Date(0), recent: new Date('2026-01-01T00:00:00.000Z') }),
    'ejson_scalars-v1': () => ({ finite: 1.5, boolean: true, nil: null }),
    'emoji_surrogate_boundaries-v1': () => ({ text: 'A🚀B👩🏽‍🚀C' }),
    'field_removal_no_stale_residue-v1': () => ({ retained: true }),
    'hot_key-v1': () => ({ counter: 0, hotKey: 'shared' }),
    'identical_projected_state-v1': () => ({ projected: 'stable', unpublished: 'before' }),
    'near_bson_ceiling-v1': () => ({ payload: textPayload('B') }),
    'object_ids-v1': () => ({ objectId: new ObjectId(hashBytes.subarray(0, 12)) }),
    'object_shapes-v1': () => ({ object: { alpha: 1, beta: { gamma: true } } }),
    'replacement-document-v1': () => ({ replacement: true, ephemeral: 'old' }),
    'replacement_no_stale_residue-v1': () => ({ replacement: true, retained: 'new' }),
    'right_to_left_text-v1': () => ({ text: 'مرحبا بالعالم — שלום עולם' }),
    'seeded_incompressible_payload-v1': () => ({ payload: hashBytes.toString('base64').repeat(Math.ceil(payloadBytes / 44)).slice(0, payloadBytes) }),
    'unicode_composed_decomposed-v1': () => ({ composed: 'é', decomposed: 'e\u0301' }),
    'synthetic-document-v1': () => ({}),
  };
  const buildFields = generators[generator];
  const fields = buildFields?.();
  if (!fields) throw new Error(`generator ${generator} is unavailable`);
  return fields;
}

/** Builds independent run/case-scoped fixture documents from a closed generator. */
function resolveFixtureNumber(reference: DeclarativeValueRef, plan: FixtureBuildPlan): number {
  return Number(reference.kind === 'parameter'
    ? plan.resolvedParameters[reference.name]
    : reference.kind === 'literal' ? reference.value : Number.NaN);
}

export function buildDeclarativeFixture({ definition, plan, runId, caseExecutionId }: Readonly<{
  definition: FixtureBuildDefinition;
  plan: FixtureBuildPlan;
  runId: string;
  caseExecutionId: string;
}>): DeclarativeFixture {
  const documents = resolveFixtureNumber(definition.fixture.documents, plan);
  const payloadBytes = resolveFixtureNumber(definition.fixture.payloadBytes, plan);
  const fixtureDocuments = Array.from({ length: documents }, (_, index) => ({
    ...buildSyntheticDocument({
      runId,
      sequence: index,
      revision: 0,
      payloadBytes: Math.min(payloadBytes, 8 * 1024 * 1024),
      seed: plan.coordinate.seed,
    }),
    _id: `${runId}:${caseExecutionId}:${index}`,
    runId,
    caseExecutionId,
    sequence: index,
    revision: 0,
    payload: String(buildSyntheticDocument({
      runId,
      sequence: index,
      revision: 0,
      payloadBytes: Math.min(payloadBytes, 8 * 1024 * 1024),
      seed: plan.coordinate.seed,
    }).payload ?? ''),
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
      { length: Number(plan.resolvedParameters.subscribers) },
      (_, index) => `client-${index}`,
    )),
  });
}

function pathValue(document: MutableDocument, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, part) => (
    value && typeof value === 'object' ? Reflect.get(value, part) : undefined
  ), document);
}

function applyTransition(
  document: ReliabilityDocument | undefined,
  transition: DeclarativeTransition,
  resolve: ResolveValue,
): ReliabilityDocument | null {
  if (!document) throw new Error('expected-model transition targets a missing document');
  const next = cloneDocument(document);
  if (transition.kind === 'delete') return null;
  if (transition.kind === 'replace') return next;
  if (transition.kind === 'set_field' && transition.path && transition.value) setPath(next, transition.path, resolve(transition.value));
  if (transition.kind === 'remove_field' && transition.path) deletePath(next, transition.path);
  if (transition.kind === 'increment_field') {
    if (!transition.path || !transition.amount) throw new Error('increment transition is incomplete');
    const current = Number(pathValue(next, transition.path) || 0);
    setPath(next, transition.path, current + Number(resolve(transition.amount)));
  }
  if (transition.kind === 'append_array') {
    if (!transition.path || !transition.value) throw new Error('append transition is incomplete');
    const currentValue = pathValue(next, transition.path);
    const current = Array.isArray(currentValue) ? currentValue : [];
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

function mutationPath(mutation: DeclarativeMutation): string {
  if (!mutation.path || mutation.path.length === 0) throw new Error(`MongoDB mutation ${mutation.kind} has no path`);
  return mutation.path.join('.');
}

function mongoUpdate(mutation: DeclarativeMutation, resolve: ResolveValue): Document {
  if (mutation.kind === 'set' && mutation.value) return { $set: { [mutationPath(mutation)]: resolve(mutation.value) } };
  if (mutation.kind === 'unset') return { $unset: { [mutationPath(mutation)]: '' } };
  if (mutation.kind === 'increment' && mutation.amount) return { $inc: { [mutationPath(mutation)]: resolve(mutation.amount) } };
  if (mutation.kind === 'push' && mutation.value) return { $push: { [mutationPath(mutation)]: resolve(mutation.value) } };
  if (mutation.kind === 'projection_variant') {
    if (mutation.variant === 'field_added') return { $set: { projected: 'added' } };
    if (mutation.variant === 'field_changed') return { $set: { projected: 'changed' } };
    if (mutation.variant === 'field_removed') return { $unset: { projected: '' } };
    if (mutation.variant === 'nested_field_changed') return { $set: { 'nested.value': 'changed' } };
    if (mutation.variant === 'object_id_preserved') return { $set: { objectIdWitness: true } };
  }
  throw new Error(`MongoDB mutation ${mutation.kind}:${mutation.variant || ''} is unavailable`);
}

function withRevisionIncrement(update: Document): Document {
  const increment = update.$inc;
  return {
    ...update,
    $inc: { ...(increment && typeof increment === 'object' ? increment : {}), revision: 1 },
  };
}

/** Creates the database/model adapter for one isolated case. */
export function createDatabaseAdapter({ collection, fixture }: Readonly<{
  collection: ReliabilityCollection;
  fixture: DeclarativeFixture;
}>) {
  const expected = new Map(fixture.documents.map((document) => [String(document._id), cloneDocument(document)]));
  const inserted = new Set();
  return Object.freeze({
    expectedSnapshot: () => [...expected.values()]
      .filter((document) => inserted.has(String(document._id)))
      .map(cloneDocument),
    async write({ step, resolve }: Readonly<{
      step: DatabaseWriteStep;
      resolve: ResolveValue;
    }>) {
      const fixtureDocument = fixture.documents[step.selector.index];
      if (!fixtureDocument) throw new Error('fixture selector is outside the generated document set');
      const id = String(fixtureDocument._id);
      if (step.operation === 'insert_one') {
        const document = step.mutation.kind === 'generated_document'
          ? { ...fixtureDocument, ...generatedFields(step.mutation.generator ?? '', {
            seed: Number(resolve({ kind: 'coordinate', field: 'seed' })),
            payloadBytes: Buffer.byteLength(fixtureDocument.payload || ''),
          }) }
          : fixtureDocument;
        await collection.insertOne(cloneDocument(document));
        const transitioned = applyTransition(document, step.expectedTransition, resolve);
        if (transitioned) expected.set(id, transitioned);
        inserted.add(id);
      } else if (step.operation === 'update_one') {
        await collection.updateOne(
          { _id: fixtureDocument._id },
          withRevisionIncrement(mongoUpdate(step.mutation, resolve)),
        );
        const transitioned = applyTransition(expected.get(id), step.expectedTransition, resolve);
        if (!transitioned) throw new Error('update transition unexpectedly deleted its document');
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
      return {
        expectedState: [...expected.values()]
          .filter((document) => inserted.has(String(document._id)))
          .map(cloneDocument),
      };
    },
    async cleanup({ runId, signal }: Readonly<{ runId: string; signal?: AbortSignal }>) {
      if (signal?.aborted) throw signal.reason;
      await collection.deleteMany({ runId });
      const remaining = await collection.countDocuments({ runId });
      return { cleanup: remaining === 0, provenance: { cleanup: 'mongodb' } };
    },
  });
}
