import type { Binary, ObjectId } from 'mongodb';

/** JSON scalar values that survive canonical JSON serialization unchanged. */
export type JsonPrimitive = boolean | number | string | null;

/** JSON object with recursively JSON-safe values. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Closed recursive value accepted at JSON trust boundaries. */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** Extended JSON values supported by the DDP/EJSON boundary. */
export type EjsonValue = JsonValue | Date | Uint8Array | Readonly<{ readonly $type: number; readonly $value: string }>;

/** BSON values accepted by database-facing contracts without implying wire safety. */
export type BsonValue = JsonValue | Date | Uint8Array | Binary | ObjectId;

/** Returns whether an unknown value is a finite, recursively JSON-safe value. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

/** Returns whether an unknown value is a non-array JSON object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value);
}

/** Parses JSON while preserving the untrusted boundary until validation succeeds. */
export function parseJson(source: string): unknown {
  return JSON.parse(source) as unknown;
}
