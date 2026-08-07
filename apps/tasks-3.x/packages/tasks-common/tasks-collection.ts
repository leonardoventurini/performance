import { Mongo } from 'meteor/mongo';

/** Task document persisted by the fixture workload. */
export interface TaskDocument {
  _id?: string;
  sessionId: string;
  description: string;
  createdAt: Date;
}

/** Audit-owned document whose remaining fields depend on the declarative case. */
export interface ReliabilityDocument {
  _id?: string;
  runId: string;
  caseExecutionId?: string;
  [field: string]: unknown;
}

export const TasksCollection = new Mongo.Collection<TaskDocument>('taskCollection');
export const ReliabilityCollection = new Mongo.Collection<ReliabilityDocument>('reliabilityDocuments');

TasksCollection.allow({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});
