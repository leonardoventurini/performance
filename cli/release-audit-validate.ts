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
import type { CliValues } from '../lib/benchmark-types.js';
import type { CaseCoordinate } from '../reliability/contracts/release-audit.js';
import type { ProgressEvent } from '../reliability/release-audit/progress-events.js';

type UnknownRecord = Record<string, unknown>;
interface ManifestCaseReference extends UnknownRecord {
  readonly coordinate: CaseCoordinate;
  readonly attemptId: string;
  readonly digest: string;
}
interface ValidatedManifest extends UnknownRecord {
  readonly release: UnknownRecord;
  readonly topologyScope: readonly string[];
  readonly transportScope: readonly string[];
  readonly capabilities: readonly Readonly<{ coordinates: readonly CaseCoordinate[] }>[];
  readonly cases: readonly ManifestCaseReference[];
  readonly negativeControls: readonly unknown[];
  readonly negativeControlContractDigest: string;
  readonly recovery: UnknownRecord;
  readonly progress: Readonly<{ digest: string; firstSequence: number; lastSequence: number }>;
  readonly status: string;
}

function digest(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Validates a sealed release manifest and every referenced case digest. */
export function validateReleaseAuditArtifact(manifestPath?: string): ValidatedManifest {
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
    throw new Error('release-audit-validate requires --manifest <manifest.json>');
  }
  const resolvedManifest = path.resolve(manifestPath);
  const root = path.dirname(resolvedManifest);
  const manifest = projectManifest(validateReleaseAuditManifest(
    JSON.parse(fs.readFileSync(resolvedManifest, 'utf8')),
  ));
  const caseDirectory = path.join(root, 'cases');
  const caseResults: UnknownRecord[] = [];

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
    seed: requireOnlySeed(seeds),
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

function verifyProgressJournal(root: string, manifest: ValidatedManifest): void {
  const journalPath = path.join(root, 'progress.ndjson');
  const contents = fs.readFileSync(journalPath);
  if (digest(contents) !== manifest.progress.digest) {
    throw new Error('Progress journal digest does not match the manifest');
  }
  const serialized = contents.toString('utf8');
  if (!serialized.endsWith('\n')) {
    throw new Error('Progress journal is not sealed on a complete record');
  }
  const records: unknown[] = serialized.trimEnd().split('\n').map((line) => JSON.parse(line));
  const initialRecord = records[0];
  if (!isRecord(initialRecord) || typeof initialRecord.auditId !== 'string') {
    throw new Error('Progress journal is empty');
  }
  const auditId = initialRecord.auditId;
  const events: ProgressEvent[] = records.map((event) => validateProgressEvent(event, auditId));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined || event.sequence !== index + 1) {
      throw new Error('Progress journal sequence is not contiguous');
    }
  }
  const first = events[0];
  const terminal = events.at(-1);
  if (first === undefined || terminal === undefined) throw new Error('Progress journal is empty');
  if (first.sequence !== manifest.progress.firstSequence
    || terminal.sequence !== manifest.progress.lastSequence) {
    throw new Error('Progress journal sequence boundary does not match the manifest');
  }
  if (terminal.kind !== 'audit_completed' || terminal.payload.status !== manifest.status) {
    throw new Error('Progress journal terminal decision does not match the manifest');
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObject(entry)]));
  }
  return value;
}

/** CLI handler for offline release-manifest validation. */
export function runReleaseAuditValidate({ values }: Readonly<{ values: CliValues }>): void {
  const manifestPath = values.manifest;
  if (typeof manifestPath !== 'string') {
    throw new Error('release-audit-validate requires --manifest <manifest.json>');
  }
  const manifest = validateReleaseAuditArtifact(manifestPath);
  console.log(`Release audit manifest is valid: ${manifest.status}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isManifest(value: unknown): value is ValidatedManifest {
  if (!isRecord(value) || !isRecord(value.release) || !isRecord(value.recovery)
    || !isRecord(value.progress) || !Array.isArray(value.topologyScope)
    || !value.topologyScope.every((entry) => typeof entry === 'string')
    || !Array.isArray(value.transportScope)
    || !value.transportScope.every((entry) => typeof entry === 'string')
    || !Array.isArray(value.capabilities) || !Array.isArray(value.cases)
    || !Array.isArray(value.negativeControls)
    || typeof value.negativeControlContractDigest !== 'string'
    || typeof value.status !== 'string' || typeof value.progress.digest !== 'string'
    || typeof value.progress.firstSequence !== 'number'
    || typeof value.progress.lastSequence !== 'number') return false;
  return value.capabilities.every((capability) => isRecord(capability)
      && Array.isArray(capability.coordinates))
    && value.cases.every((reference) => isRecord(reference)
      && isRecord(reference.coordinate) && typeof reference.attemptId === 'string'
      && typeof reference.digest === 'string');
}

function projectManifest(value: unknown): ValidatedManifest {
  if (!isManifest(value)) throw new TypeError('validated manifest has an invalid projected shape');
  return structuredClone(value);
}

function requireOnlySeed(seeds: ReadonlySet<number>): number {
  const seed = seeds.values().next().value;
  if (typeof seed !== 'number') throw new TypeError('Manifest is missing its deterministic seed');
  return seed;
}
