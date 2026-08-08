import crypto from 'node:crypto';
import type { CaseCoordinate } from '../contracts/release-audit.js';

/** Returns the stable bounded filename for one immutable case attempt. */
export function caseArtifactFileName(coordinate: CaseCoordinate, attemptId: string): string {
  const coordinateDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(coordinate))
    .digest('hex')
    .slice(0, 24);
  return `${coordinateDigest}-${attemptId}.json`;
}
