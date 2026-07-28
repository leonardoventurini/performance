import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateReleaseAuditManifest } from '../reliability/contracts/release-audit.js';
import { caseArtifactFileName } from '../reliability/release-audit/artifact-names.js';

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

  for (const reference of manifest.cases) {
    const fileName = caseArtifactFileName(reference.coordinate, reference.attemptId);
    const casePath = path.join(caseDirectory, fileName);
    if (!fs.existsSync(casePath)) {
      throw new Error(`Referenced case artifact is missing: ${fileName}`);
    }
    const caseArtifact = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    const canonical = JSON.stringify(sortObject(caseArtifact));
    if (digest(canonical) !== reference.digest) {
      throw new Error(`Referenced case digest does not match: ${fileName}`);
    }
  }
  return manifest;
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
