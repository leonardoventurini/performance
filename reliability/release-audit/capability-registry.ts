import { contractDigest } from '../contracts/digest.js';
import { loadDeclarativeAuditCatalog } from '../declarative/catalog.js';

const catalog = loadDeclarativeAuditCatalog();
type UnknownRecord = Record<string, unknown>;
export interface CapabilityApplicability { readonly topologies: readonly string[]; readonly transports: readonly string[]; readonly observerOrders: readonly (readonly string[])[] }
export interface Capability extends UnknownRecord { readonly id: string; readonly expectation: string; readonly requiredCases: readonly string[]; readonly applicability: readonly CapabilityApplicability[] }
interface CaseContractSource extends UnknownRecord {
  readonly id: string;
  readonly evidence: {
    readonly requiredProducers: readonly string[];
    readonly transportIdentity: string;
    readonly fault: unknown;
    readonly observer: UnknownRecord & { readonly kind: string; readonly driver?: UnknownRecord; readonly to?: unknown; readonly from?: unknown };
  };
}
interface NegativeControl extends UnknownRecord { readonly id: string; readonly expectedReason: string }

function capability(value: UnknownRecord): Capability {
  if (typeof value.id !== 'string' || typeof value.expectation !== 'string' || !Array.isArray(value.requiredCases)
    || !value.requiredCases.every((entry) => typeof entry === 'string') || !Array.isArray(value.applicability)) {
    throw new TypeError('validated capability has an invalid projected shape');
  }
  const applicability = value.applicability.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !('topologies' in entry) || !Array.isArray(entry.topologies) || !entry.topologies.every((item: unknown) => typeof item === 'string')
      || !('transports' in entry) || !Array.isArray(entry.transports) || !entry.transports.every((item: unknown) => typeof item === 'string')
      || !('observerOrders' in entry) || !Array.isArray(entry.observerOrders)
      || !entry.observerOrders.every((order: unknown) => Array.isArray(order) && order.every((item: unknown) => typeof item === 'string'))) {
      throw new TypeError('validated capability has invalid applicability');
    }
    return { topologies: entry.topologies, transports: entry.transports, observerOrders: entry.observerOrders };
  });
  return { ...value, id: value.id, expectation: value.expectation, requiredCases: value.requiredCases, applicability };
}

function caseSource(value: UnknownRecord): CaseContractSource {
  const evidence = value.evidence;
  if (typeof value.id !== 'string' || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || !('requiredProducers' in evidence) || !Array.isArray(evidence.requiredProducers)
    || !evidence.requiredProducers.every((entry) => typeof entry === 'string')
    || !('transportIdentity' in evidence) || typeof evidence.transportIdentity !== 'string'
    || !('observer' in evidence) || !evidence.observer || typeof evidence.observer !== 'object' || Array.isArray(evidence.observer)
    || !('kind' in evidence.observer) || typeof evidence.observer.kind !== 'string') {
    throw new TypeError('validated case has an invalid evidence projection');
  }
  return { ...value, id: value.id, evidence: { requiredProducers: evidence.requiredProducers, transportIdentity: evidence.transportIdentity, fault: 'fault' in evidence ? evidence.fault : null, observer: { ...evidence.observer, kind: evidence.observer.kind } } };
}

function negativeControl(value: UnknownRecord): NegativeControl {
  if (typeof value.id !== 'string' || typeof value.expectedReason !== 'string') throw new TypeError('validated negative control has an invalid projection');
  return { ...value, id: value.id, expectedReason: value.expectedReason };
}

export const RELEASE_CAPABILITY_CONTRACT_ID = catalog.contract.id;
export const RELEASE_CAPABILITY_REVIEWED_AT = catalog.contract.reviewedAt;
export const DECLARATIVE_AUDIT_CONTRACT_DIGEST = catalog.digest;
export const DECLARATIVE_AUDIT_INTERPRETER_VERSION = catalog.contract.interpreterVersion;
export const RELEASE_CAPABILITY_REGISTRY: readonly Capability[] = catalog.capabilities.map(capability);
export const RELEASE_CAPABILITY_CONTRACT_DIGEST = contractDigest({
  id: RELEASE_CAPABILITY_CONTRACT_ID,
  reviewedAt: RELEASE_CAPABILITY_REVIEWED_AT,
  capabilities: RELEASE_CAPABILITY_REGISTRY,
});

function capabilityExpectation(caseId: string): string {
  const expectations = new Set(RELEASE_CAPABILITY_REGISTRY
    .filter(({ requiredCases }) => requiredCases.includes(caseId))
    .map(({ expectation }) => expectation));
  if (expectations.size !== 1) {
    throw new Error(`declarative case ${caseId} has ambiguous capability expectations`);
  }
  const expectation = [...expectations][0];
  if (expectation === undefined) throw new Error(`declarative case ${caseId} has no capability expectation`);
  return expectation;
}

function observerContract(observer: CaseContractSource['evidence']['observer']): UnknownRecord {
  if (observer.kind === 'selected') {
    if (!observer.driver || observer.driver.kind !== 'literal') {
      throw new Error('release observer identity must compile from a literal driver');
    }
    return { expectedDriver: observer.driver.value };
  }
  return {
    ...(typeof observer.to === 'string'
      ? { expectedDriver: observer.to }
      : observer.to && typeof observer.to === 'object' && !Array.isArray(observer.to)
        ? { expectedDriverByTopology: Object.freeze({ ...observer.to }) }
        : {}),
    fallbackFrom: observer.from,
  };
}

export interface ReleaseCaseContract extends UnknownRecord {
  readonly caseId: string;
  readonly definitionDigest: string;
  readonly expectation: string;
  readonly requiredOracleProducers: readonly string[];
  readonly requiresObserverEvidence: true;
  readonly requiresTransportIdentity: boolean;
  readonly requiresFault: boolean;
  readonly expectedDriver?: string;
  readonly expectedDriverByTopology?: Readonly<Record<string, string>>;
  readonly fallbackFrom?: string;
}

function releaseCaseContract(definition: CaseContractSource, definitionDigest: string): ReleaseCaseContract {
  const observer = observerContract(definition.evidence.observer);
  const contract: ReleaseCaseContract = {
    caseId: definition.id,
    definitionDigest,
    expectation: capabilityExpectation(definition.id),
    requiredOracleProducers: Object.freeze([...definition.evidence.requiredProducers]),
    requiresObserverEvidence: true,
    requiresTransportIdentity: definition.evidence.transportIdentity === 'required',
    requiresFault: definition.evidence.fault !== null,
    ...(typeof observer.expectedDriver === 'string' ? { expectedDriver: observer.expectedDriver } : {}),
    ...(observer.expectedDriverByTopology && typeof observer.expectedDriverByTopology === 'object' && !Array.isArray(observer.expectedDriverByTopology)
      ? { expectedDriverByTopology: Object.freeze(Object.fromEntries(Object.entries(observer.expectedDriverByTopology).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))) } : {}),
    ...(typeof observer.fallbackFrom === 'string' ? { fallbackFrom: observer.fallbackFrom } : {}),
  };
  return Object.freeze(contract);
}

/** Exact aggregation contracts projected from each validated case definition. */
const caseContracts: Record<string, ReleaseCaseContract> = {};
for (const catalogDefinition of catalog.cases) {
  const definition = caseSource(catalogDefinition);
  caseContracts[definition.id] = releaseCaseContract(definition, contractDigest(catalogDefinition));
}
export const RELEASE_CASE_CONTRACTS: Readonly<Record<string, ReleaseCaseContract | undefined>> = Object.freeze(caseContracts);

export const REQUIRED_NEGATIVE_CONTROLS = Object.freeze(catalog.negativeControls.map(negativeControl).map((control) => Object.freeze({
  controlId: control.id,
  expectedReason: control.expectedReason,
})));

export const NEGATIVE_CONTROL_CONTRACT_DIGEST = contractDigest(REQUIRED_NEGATIVE_CONTROLS);
