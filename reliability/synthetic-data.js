import crypto from 'node:crypto';
import net from 'node:net';

export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SUBSCRIBERS = 100;
const MAX_DOCUMENTS = 1_000;
const MAX_MUTATIONS = 25;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_GENERATED_PAYLOAD_BYTES = 1024 * 1024 * 1024;

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function makePayload(byteLength, random, revision) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const prefix = `revision:${revision}|`;
  const chunkLength = Math.min(4096, Math.max(1, byteLength - prefix.length));
  let chunk = '';
  for (let index = 0; index < chunkLength; index += 1) {
    chunk += alphabet[Math.floor(random() * alphabet.length)];
  }
  return (prefix + chunk.repeat(Math.ceil(byteLength / chunk.length))).slice(0, byteLength);
}

export function payloadDigest(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function structureDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function documentDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function buildSyntheticDocument({ runId, sequence, revision, payloadBytes, seed }) {
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

export function validateWorkloadOptions(options) {
  const integerFields = ['subscribers', 'documents', 'mutations', 'payloadBytes', 'burstSize', 'timeoutMs', 'seed'];
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

export function isLoopbackMongoUri(uri) {
  const authority = uri.match(/^mongodb(?:\+srv)?:\/\/([^/]+)/)?.[1];
  if (!authority) return false;
  const hosts = authority.replace(/^.*@/, '').split(',');
  return hosts.every((host) => {
    const hostname = host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : host.split(':')[0];
    if (hostname === 'localhost' || hostname === '::1') return true;
    return net.isIP(hostname) === 4 && hostname.startsWith('127.');
  });
}
