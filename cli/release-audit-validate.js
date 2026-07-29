import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateAuditCaseResult,
  validateReleaseAuditManifest,
} from '../reliability/contracts/release-audit.js';
import { caseArtifactFileName } from '../reliability/release-audit/artifact-names.js';
import { contractDigest } from '../reliability/contracts/digest.js';
import { aggregateReleaseAudit } from '../reliability/release-audit/aggregate.js';
import { RELEASE_CAPABILITY_CONTRACT_DIGEST } from '../reliability/release-audit/capability-registry.js';
import { validateProgressEvent } from '../reliability/release-audit/progress-events.js';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Validates a sealed release manifest and every referenced case digest. */
export function validateReleaseAuditArtifact(manifestPath) {
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
    throw new Error('release-audit-validate requires --manifest <manifest.json>');
  }
  const resolvedManifest = path.resolve(manifestPath);
  const root = path.dirname(resolvedManifest);
  const manifest = validateReleaseAuditManifest(
    JSON.parse(fs.readFileSync(resolvedManifest, 'utf8')),
  );
  const caseDirectory = path.join(root, 'cases');
  const caseResults = [];

  for (const reference of manifest.cases) {
    const fileName = caseArtifactFileName(reference.coordinate, reference.attemptId);
    const casePath = path.join(caseDirectory, fileName);
    if (!fs.existsSync(casePath)) {
      throw new Error(`Referenced case artifact is missing: ${fileName}`);
    }
    const caseArtifact = validateAuditCaseResult(
      JSON.parse(fs.readFileSync(casePath, 'utf8')),
    );
    const canonical = JSON.stringify(sortObject(caseArtifact));
    if (digest(canonical) !== reference.digest) {
      throw new Error(`Referenced case digest does not match: ${fileName}`);
    }
    caseResults.push(caseArtifact);
  }
  const seeds = new Set(manifest.capabilities.flatMap(({ coordinates }) => (
    coordinates.map(({ seed }) => seed)
  )));
  if (seeds.size !== 1) {
    throw new Error('Manifest must contain exactly one deterministic seed');
  }
  verifyProgressJournal(root, manifest);
  const recomputed = aggregateReleaseAudit({
    release: manifest.release,
    topologyScope: manifest.topologyScope,
    transportScope: manifest.transportScope,
    seed: [...seeds][0],
    caseResults,
    negativeControls: manifest.negativeControls,
    negativeControlContractDigest: manifest.negativeControlContractDigest,
    recovery: manifest.recovery,
    progress: manifest.progress,
    capabilityContractDigest: RELEASE_CAPABILITY_CONTRACT_DIGEST,
  });
  if (contractDigest(recomputed) !== contractDigest(manifest)) {
    throw new Error('Manifest does not match the canonical aggregate decision');
  }
  return manifest;
}

function verifyProgressJournal(root, manifest) {
  const journalPath = path.join(root, 'progress.ndjson');
  const contents = fs.readFileSync(journalPath);
  if (digest(contents) !== manifest.progress.digest) {
    throw new Error('Progress journal digest does not match the manifest');
  }
  const serialized = contents.toString('utf8');
  if (!serialized.endsWith('\n')) {
    throw new Error('Progress journal is not sealed on a complete record');
  }
  const records = serialized.trimEnd().split('\n').map((line) => JSON.parse(line));
  const auditId = records[0]?.auditId;
  if (!auditId) throw new Error('Progress journal is empty');
  const events = records.map((event) => validateProgressEvent(event, auditId));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence !== index + 1) {
      throw new Error('Progress journal sequence is not contiguous');
    }
  }
  if (events[0].sequence !== manifest.progress.firstSequence
    || events.at(-1).sequence !== manifest.progress.lastSequence) {
    throw new Error('Progress journal sequence boundary does not match the manifest');
  }
  const terminal = events.at(-1);
  if (terminal.kind !== 'audit_completed' || terminal.payload.status !== manifest.status) {
    throw new Error('Progress journal terminal decision does not match the manifest');
  }
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}

/** CLI handler for offline release-manifest validation. */
export function runReleaseAuditValidate({ values }) {
  const manifest = validateReleaseAuditArtifact(values.manifest);
  console.log(`Release audit manifest is valid: ${manifest.status}`);
}
