/** Maximum length accepted for a dashboard audit tag. */
export const MAX_AUDIT_TAG_LENGTH = 80;

/** Maximum unsigned 32-bit seed accepted by the deterministic generator. */
export const MAX_AUDIT_SEED = 0xFFFFFFFF;

/** Audit profiles exposed by the dashboard control plane. */
export const AUDIT_PROFILES = Object.freeze(['smoke', 'extreme']);

/** Observer drivers exposed by the dashboard control plane. */
export const AUDIT_OBSERVER_DRIVERS = Object.freeze(['changeStreams', 'oplog']);

/** Non-terminal execution states that hold the global audit lease. */
export const ACTIVE_AUDIT_STATUSES = Object.freeze([
  'queued',
  'starting',
  'running',
  'cancelling',
]);

/** Terminal execution states. */
export const TERMINAL_AUDIT_STATUSES = Object.freeze([
  'passed',
  'failed',
  'cancelled',
  'interrupted',
]);

const REQUEST_KEYS = new Set([
  'profile',
  'observerDriver',
  'meteorVersion',
  'seed',
  'tag',
]);
const METEOR_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,79}$/;
const SEED_PATTERN = /^\d{1,10}$/;

/**
 * @typedef {object} AuditLaunchRequest
 * @property {'smoke'|'extreme'} profile Bounded workload profile.
 * @property {'changeStreams'|'oplog'} observerDriver Requested observer path.
 * @property {string|null} meteorVersion Optional published Meteor release.
 * @property {string|null} seed Optional unsigned 32-bit deterministic seed.
 * @property {string|null} tag Optional operator-facing result label.
 */

/**
 * Determines whether a value is a plain data object suitable for validation.
 *
 * @param {unknown} value Candidate value.
 * @returns {value is Record<string, unknown>} Whether the value is plain.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validates and normalizes the strict dashboard audit request.
 *
 * Unknown fields are rejected so the browser can never smuggle raw CLI
 * arguments, environment variables, paths, or database targets to the runner.
 *
 * @param {unknown} value Untrusted DDP method input.
 * @returns {AuditLaunchRequest} Frozen normalized request.
 */
export function validateAuditLaunchRequest(value) {
  if (!isPlainObject(value)) {
    throw new Error('Audit request must be an object.');
  }

  const unknownKeys = Object.keys(value).filter((key) => !REQUEST_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Audit request contains unsupported field "${unknownKeys[0]}".`);
  }

  const profile = value.profile ?? 'smoke';
  if (!AUDIT_PROFILES.includes(profile)) {
    throw new Error('Audit profile must be smoke or extreme.');
  }

  const observerDriver = value.observerDriver ?? 'changeStreams';
  if (!AUDIT_OBSERVER_DRIVERS.includes(observerDriver)) {
    throw new Error('Observer driver must be changeStreams or oplog.');
  }

  const meteorVersion = normalizeOptionalString(value.meteorVersion);
  if (meteorVersion !== null && !METEOR_VERSION_PATTERN.test(meteorVersion)) {
    throw new Error('Meteor version contains unsupported characters.');
  }

  const seed = normalizeOptionalString(value.seed);
  if (seed !== null) {
    if (!SEED_PATTERN.test(seed) || Number(seed) > MAX_AUDIT_SEED) {
      throw new Error(`Seed must be an integer from 0 to ${MAX_AUDIT_SEED}.`);
    }
  }

  const tag = normalizeOptionalString(value.tag);
  if (tag !== null && (
    tag.length > MAX_AUDIT_TAG_LENGTH
    || !TAG_PATTERN.test(tag)
  )) {
    throw new Error('Tag contains unsupported characters or is too long.');
  }

  return Object.freeze({
    profile,
    observerDriver,
    meteorVersion,
    seed,
    tag,
  });
}

/**
 * Builds the only CLI argv shape the dashboard is permitted to execute.
 *
 * @param {AuditLaunchRequest} request Validated launch request.
 * @param {{ outputPath: string, executionId: string }} context Server paths
 * and correlation identity.
 * @returns {ReadonlyArray<string>} Shell-free CLI arguments.
 */
export function buildAuditArgv(request, { outputPath, executionId }) {
  const tag = request.tag ?? `dashboard:${executionId}`;
  return Object.freeze([
    'bench.js',
    'audit',
    '--profile',
    request.profile,
    '--observer-driver',
    request.observerDriver,
    '--tag',
    tag,
    '--output',
    outputPath,
    ...(request.seed === null ? [] : ['--seed', request.seed]),
    ...(request.meteorVersion === null
      ? []
      : ['--meteor-version', request.meteorVersion]),
  ]);
}

/**
 * Returns whether a lifecycle status is terminal.
 *
 * @param {unknown} status Candidate status.
 * @returns {boolean} Whether no further lifecycle transition is allowed.
 */
export function isTerminalAuditStatus(status) {
  return TERMINAL_AUDIT_STATUSES.includes(status);
}

/**
 * Normalizes a nullable form value without coercing non-strings.
 *
 * @param {unknown} value Candidate value.
 * @returns {string|null} Trimmed value or null.
 */
function normalizeOptionalString(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('Optional audit fields must be strings.');
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}
