import { createHash } from 'node:crypto';

/**
 * Produces a canonical JSON representation with recursively sorted object keys.
 *
 * Arrays retain their declared order because contract order is semantically
 * significant for observer preferences and attempt evidence.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Returns the lowercase SHA-256 digest of a canonicalized contract value.
 */
export function contractDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
