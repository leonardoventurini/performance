import { Binary, ObjectId } from 'mongodb';

function cloneValue(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ObjectId) return new ObjectId(value.toHexString());
  if (value instanceof Binary) {
    const bytes = value.buffer.subarray(0, value.position);
    return new Binary(Buffer.from(bytes), value.sub_type);
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if ('slice' in value && typeof value.slice === 'function') return value.slice();
    throw new TypeError('unsupported ArrayBuffer view');
  }
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function freezeValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  // V8 cannot freeze non-empty ArrayBuffer views. Every view here is a fresh
  // clone, so no producer or consumer retains a reference that can mutate it
  // before the owning evidence digest is computed.
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freezeValue(child);
  return Object.freeze(value);
}

/** Returns a type-preserving, producer-isolated, deeply frozen evidence clone. */
export function immutableClone<Value>(value: Value): Value {
  return freezeValue(cloneValue(value)) as Value;
}
