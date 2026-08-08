/** Maximum length accepted for a dashboard audit tag. */
export const MAX_AUDIT_TAG_LENGTH = 80;

/** Maximum unsigned 32-bit seed accepted by the deterministic generator. */
export const MAX_AUDIT_SEED = 0xFFFFFFFF;

/** Audit profiles exposed by the dashboard control plane. */
export const AUDIT_PROFILES = ['smoke', 'extreme'] as const;
export type AuditProfile = (typeof AUDIT_PROFILES)[number];

/** Observer drivers exposed by the dashboard control plane. */
export const AUDIT_OBSERVER_DRIVERS = ['changeStreams', 'oplog'] as const;
export type AuditObserverDriver = (typeof AUDIT_OBSERVER_DRIVERS)[number];

/** Non-terminal execution states that hold the global audit lease. */
export const ACTIVE_AUDIT_STATUSES = [
  'queued',
  'starting',
  'running',
  'cancelling',
] as const;

/** Terminal execution states. */
export const TERMINAL_AUDIT_STATUSES = [
  'passed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type AuditStatus =
  | (typeof ACTIVE_AUDIT_STATUSES)[number]
  | (typeof TERMINAL_AUDIT_STATUSES)[number];

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

/** Strict browser-to-control-plane request contract. */
export interface AuditLaunchRequest {
  profile: AuditProfile;
  observerDriver: AuditObserverDriver;
  meteorVersion: string | null;
  seed: string | null;
  tag: string | null;
}

/**
 * Determines whether a value is a plain data object suitable for validation.
 *
 * @param {unknown} value Candidate value.
 * @returns {value is Record<string, unknown>} Whether the value is plain.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
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
export function validateAuditLaunchRequest(value: unknown): Readonly<AuditLaunchRequest> {
  if (!isPlainObject(value)) {
    throw new Error('Audit request must be an object.');
  }

  const unknownKeys = Object.keys(value).filter((key) => !REQUEST_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Audit request contains unsupported field "${unknownKeys[0]}".`);
  }

  const profile = value.profile ?? 'smoke';
  if (typeof profile !== 'string' || !AUDIT_PROFILES.some((candidate) => candidate === profile)) {
    throw new Error('Audit profile must be smoke or extreme.');
  }

  const observerDriver = value.observerDriver ?? 'changeStreams';
  if (typeof observerDriver !== 'string' || !AUDIT_OBSERVER_DRIVERS.some((candidate) => candidate === observerDriver)) {
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
    profile: profile as AuditProfile,
    observerDriver: observerDriver as AuditObserverDriver,
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
export function buildAuditArgv(
  request: AuditLaunchRequest,
  { outputPath, executionId }: { outputPath: string; executionId: string },
): ReadonlyArray<string> {
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
export function isTerminalAuditStatus(status: unknown): status is (typeof TERMINAL_AUDIT_STATUSES)[number] {
  return typeof status === 'string' && TERMINAL_AUDIT_STATUSES.some((candidate) => candidate === status);
}

/**
 * Normalizes a nullable form value without coercing non-strings.
 *
 * @param {unknown} value Candidate value.
 * @returns {string|null} Trimmed value or null.
 */
function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('Optional audit fields must be strings.');
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}
