import {
  validateCaseCoordinate,
} from '../contracts/release-audit.js';
import {
  validateCompiledCasePlan,
} from '../contracts/declarative-audit.js';
import { contractDigest } from '../contracts/digest.js';
import type { CaseCoordinate } from '../contracts/release-audit.js';
import type { CatalogEntry } from './catalog.js';

export const DECLARATIVE_AUDIT_INTERPRETER_VERSION = 'change-stream-interpreter-v1';
type ParameterValue = string | number | boolean | null;
interface ParameterDefinition { readonly type: string; readonly default: ParameterValue; readonly minimum?: number; readonly maximum?: number; readonly values?: readonly ParameterValue[] }
interface Applicability { readonly topologies: readonly string[]; readonly transports: readonly string[]; readonly observerOrders: readonly (readonly string[])[] }
interface ValueReference { readonly kind: string; readonly value?: unknown; readonly name?: string; readonly field?: 'seed' | 'transport' | 'topology' | 'observerOrder' }
interface PlanStep extends Record<string, unknown> { readonly kind: string; readonly concurrencyGroup?: string; readonly participants?: ValueReference; readonly barrier?: string }
interface Definition extends CatalogEntry { readonly applicability: readonly Applicability[]; readonly parameters: Readonly<Record<string, ParameterDefinition>>; readonly steps: readonly PlanStep[]; readonly budget: Readonly<Record<string, number>> & { readonly caseTimeoutMs: number } }
interface Profile extends CatalogEntry { readonly parameters: Readonly<Record<string, ParameterValue>>; readonly caseTimeoutMs: number }
interface CoordinateMatrix { readonly coordinates: readonly (Omit<CaseCoordinate, 'caseId'> & { readonly caseId: string })[] }
interface CompilerCatalog { readonly contract: CatalogEntry; readonly digest: string; readonly casesById: ReadonlyMap<string, CatalogEntry>; readonly profilesById: ReadonlyMap<string, CatalogEntry> }
export interface CompiledCasePlan extends Record<string, unknown> { readonly digest: string; readonly resolvedParameters: Readonly<Record<string, ParameterValue>>; readonly budget: Readonly<Record<string, number>> & { readonly caseTimeoutMs: number } }

function compiledPlan(value: unknown): CompiledCasePlan {
  const validated = validateCompiledCasePlan(value);
  if (typeof validated.digest !== 'string' || !validated.resolvedParameters || typeof validated.resolvedParameters !== 'object' || Array.isArray(validated.resolvedParameters)
    || !validated.budget || typeof validated.budget !== 'object' || Array.isArray(validated.budget) || !('caseTimeoutMs' in validated.budget) || typeof validated.budget.caseTimeoutMs !== 'number') {
    throw new TypeError('validated compiled plan has an invalid projected shape');
  }
  const resolvedParameters: Record<string, ParameterValue> = {};
  for (const [key, entry] of Object.entries(validated.resolvedParameters)) {
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') resolvedParameters[key] = entry;
    else throw new TypeError(`compiled plan parameter ${key} has an invalid value`);
  }
  const budget: Record<string, number> & { caseTimeoutMs: number } = { caseTimeoutMs: validated.budget.caseTimeoutMs };
  for (const [key, entry] of Object.entries(validated.budget)) if (typeof entry === 'number') budget[key] = entry;
  return { ...validated, digest: validated.digest, resolvedParameters, budget };
}

function assertDefinition(value: CatalogEntry): asserts value is Definition {
  if (!Array.isArray(value.applicability) || !value.parameters || typeof value.parameters !== 'object'
    || !Array.isArray(value.steps) || !value.budget || typeof value.budget !== 'object') {
    throw new TypeError(`case ${value.id} has an invalid compiled shape`);
  }
}

function assertProfile(value: CatalogEntry): asserts value is Profile {
  if (!value.parameters || typeof value.parameters !== 'object' || typeof value.caseTimeoutMs !== 'number') {
    throw new TypeError(`profile ${value.id} has an invalid compiled shape`);
  }
}

function includesOrder(orders: readonly (readonly string[])[], expected: readonly string[]): boolean {
  return orders.some((order) => contractDigest(order) === contractDigest(expected));
}

function applies(definition: Definition, coordinate: CaseCoordinate): boolean {
  return definition.applicability.some((entry) => (
    entry.topologies.includes(coordinate.topology)
    && entry.transports.includes(coordinate.transport)
    && includesOrder(entry.observerOrders, coordinate.observerOrder)
  ));
}

function resolveParameters(definition: Definition, profile: Profile): Record<string, ParameterValue> {
  const values = Object.fromEntries(Object.entries(definition.parameters)
    .map(([name, parameter]) => [name, parameter.default]));
  for (const [name, value] of Object.entries(profile.parameters)) {
    if (!Object.hasOwn(definition.parameters, name)) continue;
    const parameter = definition.parameters[name];
    if (parameter === undefined) continue;
    if (parameter.type === 'integer'
      && (typeof value !== 'number' || !Number.isSafeInteger(value) || parameter.minimum === undefined || parameter.maximum === undefined || value < parameter.minimum || value > parameter.maximum)) {
      throw new TypeError(`profile ${profile.id} parameter ${name} is outside case ${definition.id} bounds`);
    }
    if (parameter.type === 'enum' && (!parameter.values || !parameter.values.includes(value))) {
      throw new TypeError(`profile ${profile.id} parameter ${name} is invalid for case ${definition.id}`);
    }
    if (parameter.type === 'boolean' && typeof value !== 'boolean') {
      throw new TypeError(`profile ${profile.id} parameter ${name} must be boolean`);
    }
    values[name] = value;
  }
  return values;
}

function resolvedBarrierParticipants(reference: ValueReference, resolvedParameters: Readonly<Record<string, ParameterValue>>, coordinate: CaseCoordinate): unknown {
  if (reference.kind === 'literal') return reference.value;
  if (reference.kind === 'parameter') return reference.name === undefined ? undefined : resolvedParameters[reference.name];
  if (reference.kind === 'coordinate') return reference.field === undefined ? undefined : coordinate[reference.field];
  return null;
}

function validateConcurrencyGroups(definition: Definition, resolvedParameters: Readonly<Record<string, ParameterValue>>, coordinate: CaseCoordinate): void {
  const counts = new Map<string, number>();
  for (const step of definition.steps) {
    if (step.concurrencyGroup !== undefined) {
      counts.set(step.concurrencyGroup, (counts.get(step.concurrencyGroup) || 0) + 1);
    }
  }
  for (const step of definition.steps.filter(({ kind }) => kind === 'barrier')) {
    if (step.participants === undefined || step.barrier === undefined) throw new TypeError(`case ${definition.id} has an invalid barrier`);
    const participants = resolvedBarrierParticipants(step.participants, resolvedParameters, coordinate);
    if (!Number.isSafeInteger(participants) || participants !== counts.get(step.barrier)) {
      throw new TypeError(`case ${definition.id} barrier ${step.barrier} participant count does not match its concurrency group`);
    }
  }
}

/** Compiles one exact, deterministic, side-effect-free case plan. */
export function compileDeclarativeCase({ catalog, caseId, profileId, coordinate }: { catalog: CompilerCatalog; caseId: string; profileId: string; coordinate: Omit<CaseCoordinate, 'caseId'> | CaseCoordinate }): CompiledCasePlan {
  const definition = catalog.casesById.get(caseId);
  if (!definition) throw new TypeError(`unknown declarative audit case ${caseId}`);
  assertDefinition(definition);
  const profile = catalog.profilesById.get(profileId);
  if (!profile) throw new TypeError(`unknown declarative audit profile ${profileId}`);
  assertProfile(profile);
  const validatedCoordinate = validateCaseCoordinate({ ...coordinate, caseId });
  if (!applies(definition, validatedCoordinate)) {
    throw new TypeError(`case ${caseId} does not apply to the requested coordinate`);
  }
  const resolvedParameters = resolveParameters(definition, profile);
  validateConcurrencyGroups(definition, resolvedParameters, validatedCoordinate);
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
  return compiledPlan({ ...unsigned, digest: contractDigest(unsigned) });
}

/** Compiles all required coordinates and refuses missing definitions up front. */
export function compileDeclarativeMatrix({ catalog, matrix, profileId }: { catalog: CompilerCatalog; matrix: CoordinateMatrix; profileId: string }): readonly CompiledCasePlan[] {
  return Object.freeze(matrix.coordinates.map((coordinate) => compileDeclarativeCase({
    catalog,
    caseId: coordinate.caseId,
    profileId,
    coordinate,
  })));
}
