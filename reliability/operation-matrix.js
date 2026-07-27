import { buildSyntheticDocument, structureDigest } from './synthetic-data.js';

export const CAPABILITY_CONTRACT = {
  schemaVersion: 1,
  source: 'https://docs.meteor.com/performance/change-streams-observer-driver',
  reviewedAt: '2026-07-27',
};

export const CHANGE_STREAM_CAPABILITIES = [
  { id: 'insert', support: 'supported', exercisedBy: 'insertMany' },
  { id: 'update.set', support: 'supported', exercisedBy: 'updateOne:$set' },
  { id: 'update.unset', support: 'supported', exercisedBy: 'updateOne:$unset' },
  { id: 'update.increment', support: 'supported', exercisedBy: 'updateOne:$inc' },
  { id: 'update.array', support: 'supported', exercisedBy: 'updateOne:$push' },
  { id: 'replace', support: 'supported', exercisedBy: 'replaceOne' },
  { id: 'delete', support: 'supported', exercisedBy: 'deleteMany' },
  {
    id: 'selector_membership_transition',
    support: 'supported',
    reason: 'Declared by live-query semantics but not part of the bounded document-operation set',
  },
  {
    id: 'projection_cleared_field',
    support: 'supported',
    reason: 'Declared by observeChanges projection semantics but not exercised by this publication',
  },
  {
    id: 'reconnect_resubscription',
    support: 'supported',
    reason: 'Transport recovery requires a separate controlled disconnect topology',
  },
  {
    id: 'ordered_observer',
    support: 'fallback_expected',
    reason: 'Meteor change streams support unordered observers only',
  },
  {
    id: 'unsupported_selector',
    support: 'fallback_expected',
    reason: 'Selectors that Minimongo.Matcher cannot compile use the next observer driver',
  },
  {
    id: 'collection_ddl',
    support: 'not_supported',
    reason: 'Rename, drop, and invalidate events are destructive and are not live-query document mutations',
  },
  {
    id: 'expanded_events',
    support: 'not_supported',
    reason: 'Meteor does not expose showExpandedEvents through live-query publications',
  },
  {
    id: 'pre_images',
    support: 'not_supported',
    reason: 'Meteor live-query publications do not expose change-stream pre-images',
  },
];

const OPERATION_IDS = ['update.set', 'update.unset', 'update.increment', 'update.array', 'replace'];

export function recordCapabilityOutcome(outcomes, capabilityId, passed) {
  const nextStatus = passed ? 'passed' : 'failed';
  outcomes[capabilityId] = outcomes[capabilityId] === 'failed' ? 'failed' : nextStatus;
  return outcomes[capabilityId];
}

function withoutId(document) {
  const { _id, ...fields } = document;
  return fields;
}

export function buildMutation({ previous, revision, payloadBytes, seed }) {
  const generated = buildSyntheticDocument({
    runId: previous.runId,
    sequence: previous.sequence,
    revision,
    payloadBytes,
    seed,
  });
  const operationId = OPERATION_IDS[(revision - 1) % OPERATION_IDS.length];

  if (operationId === 'replace') {
    return {
      operationId,
      next: generated,
      write: { replaceOne: { filter: { _id: previous._id, runId: previous.runId }, replacement: generated } },
    };
  }

  const next = structuredClone(previous);
  next.revision = revision;
  next.payload = generated.payload;
  next.payloadDigest = generated.payloadDigest;
  const update = { $set: { revision, payload: generated.payload, payloadDigest: generated.payloadDigest } };

  if (operationId === 'update.set') {
    next.ephemeral = `set-at-${revision}`;
    update.$set.ephemeral = next.ephemeral;
  } else if (operationId === 'update.unset') {
    delete next.ephemeral;
    update.$unset = { ephemeral: '' };
  } else if (operationId === 'update.increment') {
    next.counter = (next.counter || 0) + 1;
    update.$inc = { counter: 1 };
  } else if (operationId === 'update.array') {
    const value = `revision-${revision}`;
    next.adversarial.repeated.push(value);
    update.$push = { 'adversarial.repeated': value };
  }
  next.structureDigest = structureDigest(next.adversarial);
  update.$set.structureDigest = next.structureDigest;

  return {
    operationId,
    next,
    write: { updateOne: { filter: { _id: previous._id, runId: previous.runId }, update } },
  };
}

export function summarizeCapabilities(outcomes) {
  return CHANGE_STREAM_CAPABILITIES.map((capability) => ({
    id: capability.id,
    support: capability.support,
    audit_status: outcomes[capability.id]
      || (capability.support === 'not_supported' ? 'not_supported' : 'not_exercised'),
    ...(capability.exercisedBy ? { operation: capability.exercisedBy } : {}),
    ...(capability.reason ? { reason: capability.reason } : {}),
  }));
}
