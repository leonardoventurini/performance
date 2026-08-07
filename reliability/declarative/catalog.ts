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

const DEFAULT_DEFINITIONS_ROOT = path.resolve(import.meta.dirname, '..', 'definitions');
const MAX_CATALOG_FILE_BYTES = 2 * 1024 * 1024;

function duplicateKeyError(filePath, key) {
  throw new TypeError(`${filePath} contains duplicate JSON object key ${JSON.stringify(key)}`);
}

/**
 * Rejects duplicate object keys before JSON.parse can silently retain the last
 * value. This scanner recognizes JSON structure without interpreting values.
 */
function assertNoDuplicateJsonKeys(source, filePath) {
  let cursor = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => {
    while (whitespace.test(source[cursor] || '')) cursor += 1;
  };
  const stringToken = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
      } else if (source[cursor] === '"') {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor));
      } else {
        cursor += 1;
      }
    }
    throw new SyntaxError(`${filePath} contains an unterminated JSON string`);
  };
  const scalar = () => {
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor])) cursor += 1;
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

function readJson(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(source) > MAX_CATALOG_FILE_BYTES) {
    throw new TypeError(`${filePath} exceeds the ${MAX_CATALOG_FILE_BYTES}-byte catalog limit`);
  }
  assertNoDuplicateJsonKeys(source, filePath);
  return JSON.parse(source);
}

function uniqueById(values, label) {
  const byId = new Map();
  for (const value of values) {
    if (byId.has(value.id)) throw new TypeError(`${label} contains duplicate identifier ${value.id}`);
    byId.set(value.id, value);
  }
  return byId;
}

/** Loads, validates, freezes, and digests the complete declarative contract graph. */
export function loadDeclarativeAuditCatalog(definitionsRoot = DEFAULT_DEFINITIONS_ROOT) {
  const contract = readJson(path.join(definitionsRoot, 'contract.json'));
  const capabilities = validateCapabilityCatalog(
    readJson(path.join(definitionsRoot, 'capabilities.json')),
  ).capabilities;
  const authoredProfiles = validateAuditProfileCatalog(
    readJson(path.join(definitionsRoot, 'profiles.json')),
  ).profiles;
  const profiles = authoredProfiles.map((profile, index) => validateDeclarativeAuditProfile({
    schemaVersion: 1,
    id: profile.id,
    parameters: profile.parameters,
    caseTimeoutMs: profile.parameters.timeoutMs,
  }, `profiles[${index}]`));
  const negativeControls = validateNegativeControlCatalog(
    readJson(path.join(definitionsRoot, 'negative-controls.json')),
  ).controls;
  const casesRoot = path.join(definitionsRoot, 'cases');
  const caseFiles = fs.readdirSync(casesRoot)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const cases = caseFiles.map((entry, index) => validateDeclarativeCaseDefinition(
    readJson(path.join(casesRoot, entry)),
    `cases[${index}]`,
  ));

  const capabilitiesById = uniqueById(capabilities, 'capability catalog');
  const profilesById = uniqueById(profiles, 'profile catalog');
  const casesById = uniqueById(cases, 'case catalog');
  uniqueById(negativeControls, 'negative-control catalog');
  const referencedCases = new Set();
  for (const capability of capabilitiesById.values()) {
    for (const caseId of capability.requiredCases) {
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
