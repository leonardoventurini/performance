const MAX_RESULT_LABEL_LENGTH = 200;
const AUDIT_STATUSES = new Set(['passed', 'failed', 'incomplete']);
const AUDIT_PROFILES = new Set(['smoke', 'extreme']);
const AUDIT_DRIVERS = new Set(['changeStreams', 'oplog']);

/**
 * @typedef {object} NormalizedRunResult
 * @property {Date} timestamp Canonical run timestamp.
 * @property {string} tag Operator-facing result label.
 * @property {{version: string, sha: string}} meteor Meteor identity.
 * @property {Record<string, unknown>} runtime Runtime evidence.
 * @property {string} scenario Scenario identifier.
 * @property {string} app Fixture identifier.
 * @property {number} wall_clock_ms Measured workload duration.
 * @property {Record<string, unknown>} metrics Metric families.
 */

/**
 * Validates and clones the canonical result envelope before Mongo insertion.
 *
 * @param {unknown} value Untrusted result payload.
 * @returns {NormalizedRunResult & Record<string, unknown>} Normalized result.
 */
export function normalizeRunResult(value) {
  assertPlainObject(value, 'Result');
  assertBoundedString(value.tag, 'Result tag');
  assertBoundedString(value.scenario, 'Result scenario');
  assertBoundedString(value.app, 'Result app');
  assertPlainObject(value.meteor, 'Result meteor identity');
  assertBoundedString(value.meteor.version, 'Meteor version');
  assertBoundedString(value.meteor.sha, 'Meteor revision');
  assertPlainObject(value.runtime, 'Result runtime');
  assertPlainObject(value.metrics, 'Result metrics');

  if (!Number.isFinite(value.wall_clock_ms) || value.wall_clock_ms < 0) {
    throw new Error('Result wall_clock_ms must be a finite non-negative number.');
  }

  const timestamp = value.timestamp instanceof Date
    ? new Date(value.timestamp.getTime())
    : new Date(value.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('Result timestamp must be a valid date.');
  }

  const normalized = structuredClone(value);
  normalized.timestamp = timestamp;
  return normalized;
}

/**
 * Validates that an imported result belongs to one exact dashboard execution.
 *
 * @param {unknown} value Candidate result.
 * @param {{
 *   profile: 'smoke'|'extreme',
 *   observerDriver: 'changeStreams'|'oplog',
 *   expectedTag: string,
 *   meteorVersion: string|null
 * }} expected Correlation contract.
 * @returns {NormalizedRunResult & Record<string, unknown>} Validated result.
 */
export function normalizeAuditRunResult(value, expected) {
  const normalized = normalizeRunResult(value);
  const expectedScenario = `change-stream-audit-${expected.profile}`;
  if (normalized.scenario !== expectedScenario || normalized.app !== 'tasks-3.x') {
    throw new Error('Audit result scenario or application does not match the request.');
  }
  if (normalized.tag !== expected.expectedTag) {
    throw new Error('Audit result tag does not match the execution correlation tag.');
  }
  if (
    expected.meteorVersion !== null
    && normalized.meteor.version !== expected.meteorVersion
  ) {
    throw new Error('Audit result Meteor version does not match the requested release.');
  }

  const audit = normalized.metrics.change_stream_audit;
  assertPlainObject(audit, 'Change-stream audit metric');
  if (!AUDIT_STATUSES.has(audit.status)) {
    throw new Error('Change-stream audit status is missing or unsupported.');
  }
  if (!AUDIT_PROFILES.has(audit.profile) || audit.profile !== expected.profile) {
    throw new Error('Change-stream audit profile does not match the request.');
  }
  if (
    !AUDIT_DRIVERS.has(audit.requested_driver)
    || audit.requested_driver !== expected.observerDriver
  ) {
    throw new Error('Change-stream audit observer driver does not match the request.');
  }
  if (
    audit.actual_driver !== expected.observerDriver
    || normalized.runtime.observer_driver_actual !== expected.observerDriver
  ) {
    throw new Error('Change-stream audit actual observer evidence does not match the request.');
  }
  return normalized;
}

/**
 * Asserts a bounded non-empty public result label.
 *
 * @param {unknown} value Candidate label.
 * @param {string} label Error-message subject.
 */
function assertBoundedString(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_RESULT_LABEL_LENGTH
  ) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
}

/**
 * Asserts a plain data object.
 *
 * @param {unknown} value Candidate object.
 * @param {string} label Error-message subject.
 */
function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}
