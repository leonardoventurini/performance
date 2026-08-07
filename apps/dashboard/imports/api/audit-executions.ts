import { Mongo } from 'meteor/mongo';
import type { AuditLaunchRequest, AuditStatus } from './audit-contract';

/** Durable server-owned audit execution state. */
export interface AuditExecutionDocument {
  _id?: string;
  activeLease?: string;
  status: AuditStatus;
  request: AuditLaunchRequest;
  createdAt: Date;
  updatedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  eventCount?: number;
  processId?: number;
  recoveryRequired?: boolean;
  recoveryResolvedAt?: Date;
  resultRunId?: string | null;
  auditStatus?: string | null;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}

/** One sanitized line emitted by an owned audit process. */
export interface AuditEventDocument {
  _id?: string;
  executionId: string;
  sequence: number;
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
  createdAt: Date;
}

/** Durable dashboard-initiated audit execution metadata. */
export const AuditExecutions = new Mongo.Collection<AuditExecutionDocument>('auditExecutions');

/** Bounded, sequenced child-process output for audit executions. */
export const AuditEvents = new Mongo.Collection<AuditEventDocument>('auditEvents');

AuditExecutions.deny({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});

AuditEvents.deny({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});
