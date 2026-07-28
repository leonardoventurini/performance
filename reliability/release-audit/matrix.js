import {
  DDP_TRANSPORTS,
  MONGO_TOPOLOGIES,
  validateCapabilityDefinition,
  validateCaseCoordinate,
  coordinateKey,
} from '../contracts/release-audit.js';
import { RELEASE_CAPABILITY_REGISTRY } from './capability-registry.js';

function assertUnique(values, label, permitted) {
  if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be a non-empty array of unique values`);
  }
  for (const value of values) {
    if (!permitted.includes(value)) throw new TypeError(`${label} contains unknown value ${value}`);
  }
}

/**
 * Resolves the explicit applicability map without inventing a Cartesian
 * product beyond coordinates declared by the capability registry.
 */
export function resolveReleaseAuditMatrix({
  topologyScope,
  transportScope,
  seed,
  registry = RELEASE_CAPABILITY_REGISTRY,
}) {
  assertUnique(topologyScope, 'topologyScope', MONGO_TOPOLOGIES);
  assertUnique(transportScope, 'transportScope', DDP_TRANSPORTS);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('seed must be an unsigned 32-bit integer');
  }

  const coordinates = new Map();
  const requiredByCapability = new Map();
  for (const capability of registry) {
    validateCapabilityDefinition(capability);
    if (requiredByCapability.has(capability.id)) {
      throw new TypeError(`duplicate capability identifier ${capability.id}`);
    }
    const required = [];
    if (capability.expectation === 'out_of_scope'
      || capability.expectation === 'not_supported') {
      requiredByCapability.set(capability.id, required);
      continue;
    }
    for (const caseId of capability.requiredCases) {
      for (const applicability of capability.applicability) {
        for (const topology of applicability.topologies) {
          if (!topologyScope.includes(topology)) continue;
          for (const transport of applicability.transports) {
            if (!transportScope.includes(transport)) continue;
            for (const observerOrder of applicability.observerOrders) {
              const coordinate = validateCaseCoordinate({
                caseId,
                transport,
                observerOrder,
                topology,
                seed,
                ...(caseId.startsWith('recovery.') ? { faultId: caseId } : {}),
              });
              const key = coordinateKey(coordinate);
              coordinates.set(key, coordinate);
              required.push(key);
            }
          }
        }
      }
    }
    if (required.length === 0) {
      throw new TypeError(`required capability ${capability.id} has no applicable coordinate`);
    }
    requiredByCapability.set(capability.id, [...new Set(required)].sort());
  }

  return Object.freeze({
    coordinates: Object.freeze([...coordinates.values()]
      .sort((left, right) => coordinateKey(left).localeCompare(coordinateKey(right)))),
    requiredByCapability: Object.freeze(Object.fromEntries(
      [...requiredByCapability].map(([id, keys]) => [id, Object.freeze(keys)]),
    )),
  });
}
