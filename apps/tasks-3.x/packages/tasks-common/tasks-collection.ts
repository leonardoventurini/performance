import { Mongo } from 'meteor/mongo';

/** Task document persisted by the fixture workload. */
export interface TaskDocument {
  _id?: string;
  sessionId: string;
  description: string;
  createdAt: Date;
}

/** Fields permitted on task documents crossing the Meteor method boundary. */
const TASK_DOCUMENT_FIELDS = new Set(['_id', 'sessionId', 'description', 'createdAt']);

/**
 * Validates task documents returned across the untyped Meteor method boundary.
 *
 * The returned array is newly owned by the caller, so later mutation of the
 * transport payload cannot silently replace the validated collection itself.
 */
export function parseTaskDocuments(value: unknown): TaskDocument[] {
  if (!Array.isArray(value)) {
    throw new TypeError('fetchTasks returned a non-array payload');
  }

  const documents: TaskDocument[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`fetchTasks returned an invalid task at index ${index}: expected an object`);
    }

    for (const field of Object.keys(entry)) {
      if (!TASK_DOCUMENT_FIELDS.has(field)) {
        throw new TypeError(`fetchTasks returned an invalid task at index ${index}: unknown field ${field}`);
      }
    }

    const record: Record<string, unknown> = entry;
    if ('_id' in record && typeof record._id !== 'string') {
      throw new TypeError(`fetchTasks returned an invalid task at index ${index}: _id must be a string`);
    }
    if (typeof record.sessionId !== 'string') {
      throw new TypeError(`fetchTasks returned an invalid task at index ${index}: sessionId must be a string`);
    }
    if (typeof record.description !== 'string') {
      throw new TypeError(`fetchTasks returned an invalid task at index ${index}: description must be a string`);
    }
    if (!(record.createdAt instanceof Date) || Number.isNaN(record.createdAt.getTime())) {
      throw new TypeError(`fetchTasks returned an invalid task at index ${index}: createdAt must be a valid Date`);
    }

    const document: TaskDocument = {
      sessionId: record.sessionId,
      description: record.description,
      createdAt: record.createdAt,
    };
    if (typeof record._id === 'string') document._id = record._id;
    documents.push(document);
  }

  return documents;
}

/** Audit-owned document whose remaining fields depend on the declarative case. */
export interface ReliabilityDocument {
  _id?: string;
  runId: string;
  caseExecutionId?: string;
  [field: string]: unknown;
}

/** Task workload collection shared by reactive and method-driven clients. */
export const TasksCollection = new Mongo.Collection<TaskDocument>('taskCollection');

/** Run-scoped correctness documents interpreted by the audit harness. */
export const ReliabilityCollection = new Mongo.Collection<ReliabilityDocument>('reliabilityDocuments');

TasksCollection.allow({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});
