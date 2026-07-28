import crypto from 'node:crypto';
import { documentDigest } from '../synthetic-data.js';

/** Produces a stable digest for an unordered MongoDB or DDP document snapshot. */
export function snapshotDigest(documents) {
  const canonical = documents
    .map((document) => {
      const normalized = { ...document, _id: document._id || document.id };
      delete normalized.id;
      return [normalized._id, documentDigest(normalized)];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
