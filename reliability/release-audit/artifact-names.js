import crypto from 'node:crypto';

/** Returns the stable bounded filename for one immutable case attempt. */
export function caseArtifactFileName(coordinate, attemptId) {
  const coordinateDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(coordinate))
    .digest('hex')
    .slice(0, 24);
  return `${coordinateDigest}-${attemptId}.json`;
}
