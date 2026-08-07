import crypto from 'node:crypto';
import { documentDigest } from '../synthetic-data.js';

/** Produces a stable digest for an unordered MongoDB or DDP document snapshot. */
type SnapshotDocument = Readonly<Record<string, unknown>> & { readonly _id?: string; readonly id?: string };

export function snapshotDigest(documents: readonly SnapshotDocument[]): string {
  const canonical = documents
    .map((document) => {
      const normalized = { ...document, _id: document._id || document.id };
      delete normalized.id;
      return [normalized._id ?? '', documentDigest(normalized)] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
