import fs from 'node:fs';
import path from 'node:path';

import {
  validateAuditProfileCatalog,
  validateCapabilityCatalog,
  validateDeclarativeAuditProfile,
  validateDeclarativeCaseDefinition,
  validateNegativeControlCatalog,
} from '../contracts/declarative-audit.js';
import { contractDigest } from '../contracts/digest.js';
import type { DeclarativeCaseDefinition } from '../contracts/declarative-audit.js';

const DEFAULT_DEFINITIONS_ROOT = path.resolve(import.meta.dirname, '..', 'definitions');
const MAX_CATALOG_FILE_BYTES = 2 * 1024 * 1024;
type UnknownRecord = Record<string, unknown>;
export interface CatalogEntry extends UnknownRecord { readonly id: string }
/** Coordinate dimensions controlling where an authored case is executable. */
export interface CatalogApplicability {
  readonly topologies: readonly string[];
  readonly transports: readonly string[];
  readonly observerOrders: readonly (readonly string[])[];
}
/** Fully validated case definition plus its catalog-only applicability fields. */
export interface CatalogCase extends CatalogEntry, DeclarativeCaseDefinition {
  readonly applicability: readonly CatalogApplicability[];
}
/** Closed negative-control descriptor consumed by the runtime sensitivity checks. */
export interface CatalogNegativeControl extends CatalogEntry {
  readonly expectedReason: string;
  readonly mutation: Readonly<{ readonly kind: string }>;
}
export interface DeclarativeAuditCatalog {
  readonly contract: CatalogEntry;
  readonly capabilities: readonly CatalogEntry[];
  readonly profiles: readonly CatalogEntry[];
  readonly cases: readonly CatalogCase[];
  readonly negativeControls: readonly CatalogNegativeControl[];
  readonly digest: string;
  readonly capabilitiesById: ReadonlyMap<string, CatalogEntry>;
  readonly profilesById: ReadonlyMap<string, CatalogEntry>;
  readonly casesById: ReadonlyMap<string, CatalogCase>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireEntry(value: unknown, pathLabel: string): CatalogEntry {
  if (!isRecord(value) || typeof value.id !== 'string') throw new TypeError(`${pathLabel} must contain an identifier`);
  return { ...value, id: value.id };
}

function isCatalogCase(value: unknown): value is CatalogCase {
  return isRecord(value)
    && typeof value.id === 'string'
    && isRecord(value.fixture)
    && Array.isArray(value.steps)
    && Array.isArray(value.oracles)
    && Array.isArray(value.applicability);
}

function requireCatalogCase(value: unknown, pathLabel: string): CatalogCase {
  if (!isCatalogCase(value)) throw new TypeError(`${pathLabel} has an invalid validated case shape`);
  return structuredClone(value);
}

function isCatalogNegativeControl(value: unknown): value is CatalogNegativeControl {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.expectedReason === 'string'
    && isRecord(value.mutation)
    && typeof value.mutation.kind === 'string';
}

function requireCatalogNegativeControl(value: unknown, pathLabel: string): CatalogNegativeControl {
  if (!isCatalogNegativeControl(value)) {
    throw new TypeError(`${pathLabel} has an invalid validated negative-control shape`);
  }
  return structuredClone(value);
}

function requireProfileParameters(profile: CatalogEntry): UnknownRecord {
  if (!isRecord(profile.parameters)) throw new TypeError(`profile ${profile.id} parameters must be an object`);
  return profile.parameters;
}

function requireEntryArray(envelope: UnknownRecord, key: string): CatalogEntry[] {
  const entries = envelope[key];
  if (!Array.isArray(entries)) throw new TypeError(`${key} must be an array`);
  return entries.map((entry, index) => requireEntry(entry, `${key}[${index}]`));
}

function duplicateKeyError(filePath: string, key: string): never {
  throw new TypeError(`${filePath} contains duplicate JSON object key ${JSON.stringify(key)}`);
}

/**
 * Rejects duplicate object keys before JSON.parse can silently retain the last
 * value. This scanner recognizes JSON structure without interpreting values.
 */
function assertNoDuplicateJsonKeys(source: string, filePath: string): void {
  let cursor = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => {
    while (whitespace.test(source[cursor] || '')) cursor += 1;
  };
  const stringToken = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
      } else if (source[cursor] === '"') {
        cursor += 1;
        const parsed: unknown = JSON.parse(source.slice(start, cursor));
        if (typeof parsed !== 'string') throw new SyntaxError(`${filePath} contains an invalid JSON string`);
        return parsed;
      } else {
        cursor += 1;
      }
    }
    throw new SyntaxError(`${filePath} contains an unterminated JSON string`);
  };
  const scalar = () => {
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor] ?? '')) cursor += 1;
  };
  const value = () => {
    skipWhitespace();
    if (source[cursor] === '{') object();
    else if (source[cursor] === '[') array();
    else if (source[cursor] === '"') stringToken();
    else scalar();
    skipWhitespace();
  };
  const object = () => {
    cursor += 1;
    skipWhitespace();
    const keys = new Set();
    while (source[cursor] !== '}') {
      if (source[cursor] !== '"') throw new SyntaxError(`${filePath} contains an invalid JSON object key`);
      const key = stringToken();
      if (keys.has(key)) duplicateKeyError(filePath, key);
      keys.add(key);
      skipWhitespace();
      if (source[cursor] !== ':') throw new SyntaxError(`${filePath} contains an invalid JSON object`);
      cursor += 1;
      value();
      if (source[cursor] === ',') {
        cursor += 1;
        skipWhitespace();
      } else if (source[cursor] !== '}') {
        throw new SyntaxError(`${filePath} contains an invalid JSON object separator`);
      }
    }
    cursor += 1;
  };
  const array = () => {
    cursor += 1;
    skipWhitespace();
    while (source[cursor] !== ']') {
      value();
      if (source[cursor] === ',') {
        cursor += 1;
        skipWhitespace();
      } else if (source[cursor] !== ']') {
        throw new SyntaxError(`${filePath} contains an invalid JSON array separator`);
      }
    }
    cursor += 1;
  };
  value();
  if (cursor !== source.length) throw new SyntaxError(`${filePath} contains trailing JSON content`);
}

function readJson(filePath: string): unknown {
  const source = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(source) > MAX_CATALOG_FILE_BYTES) {
    throw new TypeError(`${filePath} exceeds the ${MAX_CATALOG_FILE_BYTES}-byte catalog limit`);
  }
  assertNoDuplicateJsonKeys(source, filePath);
  return JSON.parse(source);
}

function uniqueById<Value extends CatalogEntry>(values: readonly Value[], label: string): Map<string, Value> {
  const byId = new Map<string, Value>();
  for (const value of values) {
    if (byId.has(value.id)) throw new TypeError(`${label} contains duplicate identifier ${value.id}`);
    byId.set(value.id, value);
  }
  return byId;
}

/** Loads, validates, freezes, and digests the complete declarative contract graph. */
export function loadDeclarativeAuditCatalog(definitionsRoot = DEFAULT_DEFINITIONS_ROOT): Readonly<DeclarativeAuditCatalog> {
  const contract = requireEntry(readJson(path.join(definitionsRoot, 'contract.json')), 'contract');
  const capabilityEnvelope = validateCapabilityCatalog(
    readJson(path.join(definitionsRoot, 'capabilities.json')),
  );
  const capabilities = requireEntryArray(capabilityEnvelope, 'capabilities');
  const profileEnvelope = validateAuditProfileCatalog(
    readJson(path.join(definitionsRoot, 'profiles.json')),
  );
  const authoredProfiles = requireEntryArray(profileEnvelope, 'profiles');
  const profiles = authoredProfiles.map((profile, index) => {
    const profileParameters = requireProfileParameters(profile);
    const timeoutMs = profileParameters.timeoutMs;
    return validateDeclarativeAuditProfile({
    schemaVersion: 1,
    id: profile.id,
    parameters: profileParameters,
    caseTimeoutMs: timeoutMs,
  }, `profiles[${index}]`);
  }).map((profile, index) => requireEntry(profile, `profiles[${index}]`));
  const negativeControlEnvelope = validateNegativeControlCatalog(
    readJson(path.join(definitionsRoot, 'negative-controls.json')),
  );
  const negativeControlEntries = requireEntryArray(negativeControlEnvelope, 'controls');
  const negativeControls = negativeControlEntries.map((control, index) => (
    requireCatalogNegativeControl(control, `controls[${index}]`)
  ));
  const casesRoot = path.join(definitionsRoot, 'cases');
  const caseFiles = fs.readdirSync(casesRoot)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const cases = caseFiles.map((entry, index) => requireCatalogCase(validateDeclarativeCaseDefinition(
    readJson(path.join(casesRoot, entry)),
    `cases[${index}]`,
  ), `cases[${index}]`));

  const capabilitiesById = uniqueById(capabilities, 'capability catalog');
  const profilesById = uniqueById(profiles, 'profile catalog');
  const casesById = uniqueById(cases, 'case catalog');
  uniqueById(negativeControls, 'negative-control catalog');
  const referencedCases = new Set();
  for (const capability of capabilitiesById.values()) {
    const requiredCases = capability.requiredCases;
    if (!Array.isArray(requiredCases) || !requiredCases.every((caseId) => typeof caseId === 'string')) {
      throw new TypeError(`capability ${capability.id} has invalid required cases`);
    }
    for (const caseId of requiredCases) {
      if (!casesById.has(caseId)) {
        throw new TypeError(`capability ${capability.id} references missing case ${caseId}`);
      }
      referencedCases.add(caseId);
    }
  }
  for (const caseId of casesById.keys()) {
    if (!referencedCases.has(caseId)) throw new TypeError(`case ${caseId} is not referenced by a capability`);
  }

  const normalized = structuredClone({
    contract,
    capabilities,
    profiles,
    cases,
    negativeControls,
  });
  const digest = contractDigest(normalized);
  return Object.freeze({
    ...normalized,
    digest,
    capabilitiesById,
    profilesById,
    casesById,
  });
}

export { assertNoDuplicateJsonKeys };
