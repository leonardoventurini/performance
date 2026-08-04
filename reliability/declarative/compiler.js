import {
  validateCaseCoordinate,
} from '../contracts/release-audit.js';
import {
  validateCompiledCasePlan,
} from '../contracts/declarative-audit.js';
import { contractDigest } from '../contracts/digest.js';

export const DECLARATIVE_AUDIT_INTERPRETER_VERSION = 'declarative-audit-v1';

function includesOrder(orders, expected) {
  return orders.some((order) => contractDigest(order) === contractDigest(expected));
}

function applies(definition, coordinate) {
  return definition.applicability.some((entry) => (
    entry.topologies.includes(coordinate.topology)
    && entry.transports.includes(coordinate.transport)
    && includesOrder(entry.observerOrders, coordinate.observerOrder)
  ));
}

function resolveParameters(definition, profile) {
  const values = Object.fromEntries(Object.entries(definition.parameters)
    .map(([name, parameter]) => [name, parameter.default]));
  for (const [name, value] of Object.entries(profile.parameters)) {
    if (!Object.hasOwn(definition.parameters, name)) continue;
    const parameter = definition.parameters[name];
    if (parameter.type === 'integer'
      && (!Number.isSafeInteger(value) || value < parameter.minimum || value > parameter.maximum)) {
      throw new TypeError(`profile ${profile.id} parameter ${name} is outside case ${definition.id} bounds`);
    }
    if (parameter.type === 'enum' && !parameter.values.includes(value)) {
      throw new TypeError(`profile ${profile.id} parameter ${name} is invalid for case ${definition.id}`);
    }
    if (parameter.type === 'boolean' && typeof value !== 'boolean') {
      throw new TypeError(`profile ${profile.id} parameter ${name} must be boolean`);
    }
    values[name] = value;
  }
  return values;
}

/** Compiles one exact, deterministic, side-effect-free case plan. */
export function compileDeclarativeCase({ catalog, caseId, profileId, coordinate }) {
  const definition = catalog.casesById.get(caseId);
  if (!definition) throw new TypeError(`unknown declarative audit case ${caseId}`);
  const profile = catalog.profilesById.get(profileId);
  if (!profile) throw new TypeError(`unknown declarative audit profile ${profileId}`);
  const validatedCoordinate = validateCaseCoordinate({ ...coordinate, caseId });
  if (!applies(definition, validatedCoordinate)) {
    throw new TypeError(`case ${caseId} does not apply to the requested coordinate`);
  }
  const resolvedParameters = resolveParameters(definition, profile);
  const caseDefinitionDigest = contractDigest(definition);
  const unsigned = {
    schemaVersion: 1,
    contractId: catalog.contract.id,
    contractDigest: catalog.digest,
    caseDefinitionDigest,
    profileId,
    coordinate: validatedCoordinate,
    resolvedParameters,
    steps: definition.steps,
    budget: {
      ...definition.budget,
      caseTimeoutMs: Math.min(definition.budget.caseTimeoutMs, profile.caseTimeoutMs),
    },
  };
  return validateCompiledCasePlan({ ...unsigned, digest: contractDigest(unsigned) });
}

/** Compiles all required coordinates and refuses missing definitions up front. */
export function compileDeclarativeMatrix({ catalog, matrix, profileId }) {
  return Object.freeze(matrix.coordinates.map((coordinate) => compileDeclarativeCase({
    catalog,
    caseId: coordinate.caseId,
    profileId,
    coordinate,
  })));
}
