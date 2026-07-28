import { Mongo } from 'meteor/mongo';

/** Durable dashboard-initiated audit execution metadata. */
export const AuditExecutions = new Mongo.Collection('auditExecutions');

/** Bounded, sequenced child-process output for audit executions. */
export const AuditEvents = new Mongo.Collection('auditEvents');

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
