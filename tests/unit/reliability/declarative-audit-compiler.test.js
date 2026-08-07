import assert from 'node:assert/strict';
import test from 'node:test';

import { contractDigest } from '../../../reliability/contracts/digest.js';
import {
  assertNoDuplicateJsonKeys,
  loadDeclarativeAuditCatalog,
} from '../../../reliability/declarative/catalog.js';
import {
  compileDeclarativeCase,
  compileDeclarativeMatrix,
} from '../../../reliability/declarative/compiler.js';
import { resolveReleaseAuditMatrix } from '../../../reliability/release-audit/matrix.js';

const SHA = 'a'.repeat(64);
const coordinate = {
  caseId: 'event.insert',
  transport: 'sockjs',
  observerOrder: ['changeStreams', 'oplog', 'polling'],
  topology: 'replica_set',
  seed: 42,
};

function definition() {
  return {
    id: 'event.insert',
    applicability: [{
      topologies: ['replica_set'],
      transports: ['sockjs'],
      observerOrders: [['changeStreams', 'oplog', 'polling']],
    }],
    parameters: {
      documents: { type: 'integer', default: 1, minimum: 1, maximum: 10 },
    },
    steps: [{ id: 'seal', kind: 'seal_evidence', onFailure: 'incomplete_case' }],
    budget: {
      maximumSteps: 1,
      maximumDocuments: 10,
      maximumSubscribers: 3,
      maximumPayloadBytes: 1024,
      maximumEvidenceEntries: 100,
      stepTimeoutMs: 1000,
      caseTimeoutMs: 5000,
      maximumRetries: 0,
    },
  };
}

function catalog() {
  const caseDefinition = definition();
  return {
    contract: { id: 'contract-v1' },
    digest: SHA,
    casesById: new Map([[caseDefinition.id, caseDefinition]]),
    profilesById: new Map([['smoke', {
      id: 'smoke',
      parameters: { documents: 2 },
      caseTimeoutMs: 4000,
    }]]),
  };
}

test('JSON scanner rejects duplicate keys at every nesting level', () => {
  assert.throws(
    () => assertNoDuplicateJsonKeys('{"safe":{"id":1,"id":2}}', 'fixture.json'),
    /duplicate JSON object key "id"/u,
  );
  assert.doesNotThrow(() => assertNoDuplicateJsonKeys('{"safe":{"id":1}}', 'fixture.json'));
});

test('compiler resolves bounded profile parameters and is deterministic', () => {
  const first = compileDeclarativeCase({ catalog: catalog(), caseId: 'event.insert', profileId: 'smoke', coordinate });
  const second = compileDeclarativeCase({ catalog: catalog(), caseId: 'event.insert', profileId: 'smoke', coordinate });
  assert.deepEqual(first, second);
  assert.equal(first.resolvedParameters.documents, 2);
  assert.equal(first.budget.caseTimeoutMs, 4000);
  const { digest, ...unsigned } = first;
  assert.equal(digest, contractDigest(unsigned));
});

test('compiler rejects out-of-applicability coordinates and profile overflow', () => {
  assert.throws(() => compileDeclarativeCase({
    catalog: catalog(),
    caseId: 'event.insert',
    profileId: 'smoke',
    coordinate: { ...coordinate, transport: 'uws' },
  }), /does not apply/u);
  const invalid = catalog();
  invalid.profilesById.get('smoke').parameters.documents = 11;
  assert.throws(() => compileDeclarativeCase({
    catalog: invalid,
    caseId: 'event.insert',
    profileId: 'smoke',
    coordinate,
  }), /outside case event\.insert bounds/u);
});

test('checked-in catalog covers and compiles every required default coordinate', () => {
  const loaded = loadDeclarativeAuditCatalog();
  assert.equal(loaded.capabilities.length, 92);
  assert.equal(loaded.cases.length, 88);
  assert.equal(loaded.negativeControls.length, 13);
  const matrix = resolveReleaseAuditMatrix({
    topologyScope: ['replica_set'],
    transportScope: ['sockjs', 'uws'],
    seed: 42,
  });
  const plans = compileDeclarativeMatrix({ catalog: loaded, matrix, profileId: 'smoke' });
  assert.equal(plans.length, matrix.coordinates.length);
  assert.equal(plans.length, 112);
  assert.equal(new Set(plans.map(({ digest }) => digest)).size, plans.length);
});

test('compiler rejects barrier participant counts that cannot release their concurrency group', () => {
  const loaded = loadDeclarativeAuditCatalog();
  const source = loaded.casesById.get('recovery.stream_restart_concurrent_writes');
  const invalidDefinition = structuredClone(source);
  const barrier = invalidDefinition.steps.find(({ kind }) => kind === 'barrier');
  barrier.participants = { kind: 'literal', value: 3 };
  const invalidCatalog = {
    ...loaded,
    casesById: new Map(loaded.casesById).set(invalidDefinition.id, invalidDefinition),
  };
  const matchingCoordinate = resolveReleaseAuditMatrix({
    topologyScope: ['replica_set'],
    transportScope: ['sockjs'],
    seed: 42,
  }).coordinates.find(({ caseId }) => caseId === invalidDefinition.id);

  assert.throws(() => compileDeclarativeCase({
    catalog: invalidCatalog,
    caseId: invalidDefinition.id,
    profileId: 'smoke',
    coordinate: matchingCoordinate,
  }), /participant count does not match its concurrency group/u);
});
