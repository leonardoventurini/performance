import crypto from 'node:crypto';
import net from 'node:net';

export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SUBSCRIBERS = 100;
const MAX_DOCUMENTS = 1_000;
const MAX_MUTATIONS = 25;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_GENERATED_PAYLOAD_BYTES = 1024 * 1024 * 1024;

type RandomSource = () => number;

export interface SyntheticDocumentOptions {
  readonly runId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly payloadBytes: number;
  readonly seed: number;
}

export interface WorkloadOptions {
  readonly subscribers: number;
  readonly documents: number;
  readonly mutations: number;
  readonly payloadBytes: number;
  readonly burstSize: number;
  readonly timeoutMs: number;
  readonly seed: number;
}
export interface SyntheticDocument extends Record<string, unknown> {
  readonly _id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly payload: string;
  readonly payloadDigest: string;
  readonly adversarial: {
    readonly unicode: string;
    readonly scalarBoundaries: { readonly maximumSafeInteger: number };
    readonly [key: string]: unknown;
  };
  readonly structureDigest: string;
}

interface BsonObjectIdLike { readonly _bsontype: 'ObjectId'; toHexString(): string }
interface BsonBinaryLike { readonly _bsontype: 'Binary'; readonly buffer: ArrayBufferView; readonly position: number; readonly sub_type: number }
type CanonicalValue = readonly unknown[];

function createRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function makePayload(byteLength: number, random: RandomSource, revision: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const prefix = `revision:${revision}|`;
  const chunkLength = Math.min(4096, Math.max(1, byteLength - prefix.length));
  let chunk = '';
  for (let index = 0; index < chunkLength; index += 1) {
    chunk += alphabet[Math.floor(random() * alphabet.length)];
  }
  return (prefix + chunk.repeat(Math.ceil(byteLength / chunk.length))).slice(0, byteLength);
}

export function payloadDigest(payload: string): string {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function structureDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isObjectIdLike(value: object): value is BsonObjectIdLike {
  return '_bsontype' in value && value._bsontype === 'ObjectId'
    && 'toHexString' in value && typeof value.toHexString === 'function';
}

function isBinaryLike(value: object): value is BsonBinaryLike {
  return '_bsontype' in value && value._bsontype === 'Binary'
    && 'buffer' in value && ArrayBuffer.isView(value.buffer)
    && 'position' in value && typeof value.position === 'number'
    && 'sub_type' in value && typeof value.sub_type === 'number';
}

function canonicalize(value: unknown): CanonicalValue {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'nan'];
    if (value === Infinity) return ['number', 'positive_infinity'];
    if (value === -Infinity) return ['number', 'negative_infinity'];
    if (Object.is(value, -0)) return ['number', 'negative_zero'];
    return ['number', String(value)];
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Array.isArray(value)) return ['array', value.map(canonicalize)];
  if (value && typeof value === 'object') {
    if (value instanceof Date) return ['date', value.toISOString()];
    if (ArrayBuffer.isView(value)) {
      return ['binary', 0, Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
    }
    if (isObjectIdLike(value)) {
      return ['object_id', value.toHexString()];
    }
    if (isBinaryLike(value)) {
      const bytes = Buffer.from(
        value.buffer.buffer,
        value.buffer.byteOffset,
        Math.min(value.position, value.buffer.byteLength),
      );
      return ['binary', value.sub_type, Buffer.from(bytes).toString('base64')];
    }
    return ['object', Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])];
  }
  return [typeof value, String(value)];
}

export function documentDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function buildSyntheticDocument({ runId, sequence, revision, payloadBytes, seed }: SyntheticDocumentOptions): SyntheticDocument {
  const random = createRandom((seed + sequence * 31 + revision * 997) >>> 0);
  const payload = makePayload(payloadBytes, random, revision);
  const adversarial = {
    unicode: `مرحبا-世界-🚀-${sequence}`,
    nested: { level1: { level2: { revision, sentinel: null } } },
    cardinality: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`field_${sequence}_${index}`, Math.floor(random() * 1_000_000)]),
    ),
    repeated: Array.from({ length: 16 }, (_, index) => `${sequence}:${revision}:${index % 3}`),
    scalarBoundaries: {
      boolean: revision % 2 === 0,
      zero: 0,
      negative: -sequence,
      maximumSafeInteger: Number.MAX_SAFE_INTEGER,
    },
  };
  return {
    _id: `${runId}:${sequence}`,
    runId,
    sequence,
    revision,
    payload,
    payloadDigest: payloadDigest(payload),
    adversarial,
    structureDigest: structureDigest(adversarial),
  };
}

export function validateWorkloadOptions<T extends WorkloadOptions>(options: T): T {
  const integerFields = ['subscribers', 'documents', 'mutations', 'payloadBytes', 'burstSize', 'timeoutMs', 'seed'] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(options[field]) || options[field] < (field === 'seed' ? 0 : 1)) {
      throw new Error(`${field} must be a ${field === 'seed' ? 'non-negative' : 'positive'} integer`);
    }
  }
  if (options.payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payloadBytes must not exceed ${MAX_PAYLOAD_BYTES}`);
  }
  if (options.burstSize > options.documents) {
    throw new Error('burstSize must not exceed documents');
  }
  if (options.subscribers > MAX_SUBSCRIBERS) throw new Error(`subscribers must not exceed ${MAX_SUBSCRIBERS}`);
  if (options.documents > MAX_DOCUMENTS) throw new Error(`documents must not exceed ${MAX_DOCUMENTS}`);
  if (options.mutations > MAX_MUTATIONS) throw new Error(`mutations must not exceed ${MAX_MUTATIONS}`);
  if (options.timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must not exceed ${MAX_TIMEOUT_MS}`);
  const generatedPayloadBytes = options.documents * options.payloadBytes * (options.mutations + 1);
  if (generatedPayloadBytes > MAX_GENERATED_PAYLOAD_BYTES) {
    throw new Error(`generated payload must not exceed ${MAX_GENERATED_PAYLOAD_BYTES} bytes`);
  }
  return options;
}

export function isLoopbackMongoUri(uri: string): boolean {
  const authority = uri.match(/^mongodb(?:\+srv)?:\/\/([^/]+)/)?.[1];
  if (!authority) return false;
  const hosts = authority.replace(/^.*@/, '').split(',');
  return hosts.every((host) => {
    const hostname = host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : host.split(':')[0];
    if (hostname === undefined) return false;
    if (hostname === 'localhost' || hostname === '::1') return true;
    return net.isIP(hostname) === 4 && hostname.startsWith('127.');
  });
}
