import { contractDigest } from '../contracts/digest.js';
import { loadDeclarativeAuditCatalog } from '../declarative/catalog.js';

const catalog = loadDeclarativeAuditCatalog();

export const RELEASE_CAPABILITY_CONTRACT_ID = catalog.contract.id;
export const RELEASE_CAPABILITY_REVIEWED_AT = catalog.contract.reviewedAt;
export const DECLARATIVE_AUDIT_CONTRACT_DIGEST = catalog.digest;
export const DECLARATIVE_AUDIT_INTERPRETER_VERSION = catalog.contract.interpreterVersion;
export const RELEASE_CAPABILITY_REGISTRY = catalog.capabilities;
export const RELEASE_CAPABILITY_CONTRACT_DIGEST = contractDigest({
  id: RELEASE_CAPABILITY_CONTRACT_ID,
  reviewedAt: RELEASE_CAPABILITY_REVIEWED_AT,
  capabilities: RELEASE_CAPABILITY_REGISTRY,
});

function capabilityExpectation(caseId) {
  const expectations = new Set(RELEASE_CAPABILITY_REGISTRY
    .filter(({ requiredCases }) => requiredCases.includes(caseId))
    .map(({ expectation }) => expectation));
  if (expectations.size !== 1) {
    throw new Error(`declarative case ${caseId} has ambiguous capability expectations`);
  }
  return [...expectations][0];
}

function observerContract(observer) {
  if (observer.kind === 'selected') {
    if (observer.driver.kind !== 'literal') {
      throw new Error('release observer identity must compile from a literal driver');
    }
    return { expectedDriver: observer.driver.value };
  }
  return {
    ...(typeof observer.to === 'string'
      ? { expectedDriver: observer.to }
      : { expectedDriverByTopology: Object.freeze({ ...observer.to }) }),
    fallbackFrom: observer.from,
  };
}

/** Exact aggregation contracts projected from each validated case definition. */
export const RELEASE_CASE_CONTRACTS = Object.freeze(Object.fromEntries(
  catalog.cases.map((definition) => [definition.id, Object.freeze({
    caseId: definition.id,
    definitionDigest: contractDigest(definition),
    expectation: capabilityExpectation(definition.id),
    requiredOracleProducers: Object.freeze([...definition.evidence.requiredProducers]),
    requiresObserverEvidence: true,
    requiresTransportIdentity: definition.evidence.transportIdentity === 'required',
    requiresFault: definition.evidence.fault !== null,
    ...observerContract(definition.evidence.observer),
  })]),
));

export const REQUIRED_NEGATIVE_CONTROLS = Object.freeze(catalog.negativeControls.map((control) => Object.freeze({
  controlId: control.id,
  expectedReason: control.expectedReason,
})));

export const NEGATIVE_CONTROL_CONTRACT_DIGEST = contractDigest(REQUIRED_NEGATIVE_CONTROLS);
