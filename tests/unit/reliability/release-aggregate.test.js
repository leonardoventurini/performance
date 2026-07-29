import assert from 'node:assert/strict';
import test from 'node:test';

import { contractDigest } from '../../../reliability/contracts/digest.js';
import { coordinateKey } from '../../../reliability/contracts/release-audit.js';
import { aggregateReleaseAudit } from '../../../reliability/release-audit/aggregate.js';
import {
  NEGATIVE_CONTROL_CONTRACT_DIGEST,
  RELEASE_CASE_CONTRACTS,
  REQUIRED_NEGATIVE_CONTROLS,
} from '../../../reliability/release-audit/capability-registry.js';
import { resolveReleaseAuditMatrix } from '../../../reliability/release-audit/matrix.js';

const SHA = 'b'.repeat(64);
const SCOPE = {
  topologyScope: ['replica_set', 'standalone'],
  transportScope: ['sockjs', 'uws'],
  seed: 17,
};

function release(overrides = {}) {
  return {
    requested: '3.5.1-beta.0',
    actual: '3.5.1-beta.0',
    sourceRevision: 'release:3.5.1-beta.0',
    fixtureRelease: 'METEOR@3.5.1-beta.0',
    packageVersionsDigest: SHA,
    settingsDigest: SHA,
    harnessRevision: 'c'.repeat(40),
    harnessDirty: false,
    executionEnvironment: 'node-24-test',
    ...overrides,
  };
}

function caseResult(coordinate, attemptId = 'attempt-1') {
  const contract = RELEASE_CASE_CONTRACTS[coordinate.caseId];
  const expectedDriver = contract?.expectedDriverByTopology?.[coordinate.topology]
    || contract?.expectedDriver
    || 'changeStreams';
  const fallback = contract?.expectation === 'fallback_required';
  return {
    schemaVersion: 2,
    coordinate,
    attemptId,
    status: 'passed',
    release: release(),
    mongo: {
      serverVersion: '8.0.0',
      featureCompatibilityVersion: '8.0',
      topology: coordinate.topology,
      topologyName: coordinate.topology === 'standalone' ? 'standalone' : 'audit-rs',
      members: [{ id: 'mongo-1', role: 'primary' }],
    },
    observerEvidence: [{
      cursorId: `cursor-${attemptId}`,
      requestedOrder: coordinate.observerOrder,
      actualDriver: expectedDriver,
      ...(contract?.fallbackFrom ? {
        fallbackFrom: contract.fallbackFrom,
        fallbackReason: 'query_not_supported',
      } : {}),
    }],
    oracles: [
      {
        oracleId: 'mongodb-state',
        producer: 'mongodb',
        digest: SHA,
        assertions: 1,
        passed: true,
        failures: [],
      },
      {
        oracleId: 'ddp-content',
        producer: 'ddp_client',
        digest: SHA,
        assertions: 1,
        passed: true,
        failures: [],
      },
      {
        oracleId: 'transport-identity',
        producer: 'meteor_probe',
        digest: contractDigest({ transport: coordinate.transport }),
        assertions: 1,
        passed: true,
        failures: [],
      },
      ...(coordinate.faultId ? [{
        oracleId: 'fault-witness',
        producer: 'fault_controller',
        digest: contractDigest({
          activationEvidenceDigest: SHA,
          restorationEvidenceDigest: SHA,
        }),
        assertions: 2,
        passed: true,
        failures: [],
      }] : []),
    ],
    ...(coordinate.faultId ? {
      faultWitness: {
        faultId: coordinate.faultId,
        kind: 'bounded_fault',
        activationEvidenceDigest: SHA,
        restorationEvidenceDigest: SHA,
        restored: true,
      },
    } : {}),
    diagnostics: {},
    reasons: fallback ? [] : [],
  };
}

function controls() {
  return REQUIRED_NEGATIVE_CONTROLS.map(({ controlId, expectedReason }) => ({
    controlId,
    expectedReason,
    actualReason: expectedReason,
    detected: true,
    evidenceDigest: contractDigest({ controlId, expectedReason }),
  }));
}

function aggregationInput() {
  const matrix = resolveReleaseAuditMatrix(SCOPE);
  const recoveryState = {
    runDocumentsRemoved: true,
    topologyRestored: true,
    profilerRestored: true,
    networkRestored: true,
  };
  return {
    ...SCOPE,
    release: release(),
    caseResults: matrix.coordinates.map((coordinate) => caseResult(coordinate)),
    negativeControls: controls(),
    negativeControlContractDigest: NEGATIVE_CONTROL_CONTRACT_DIGEST,
    recovery: { ...recoveryState, digest: contractDigest(recoveryState) },
    progress: {
      firstSequence: 1,
      lastSequence: 100,
      digest: SHA,
    },
  };
}

test('complete valid evidence is conformant and preserves explicit exclusions', () => {
  const manifest = aggregateReleaseAudit(aggregationInput());
  assert.equal(manifest.status, 'conformant');
  assert.ok(manifest.capabilities.every(({ status }) => (
    ['passed', 'verified_fallback', 'out_of_scope'].includes(status)
  )));
  assert.equal(manifest.cases.length, aggregationInput().caseResults.length);
});

test('removing one required case makes the release incomplete', () => {
  const input = aggregationInput();
  const removed = input.caseResults.shift();
  const manifest = aggregateReleaseAudit(input);
  assert.equal(manifest.status, 'incomplete');
  const capability = manifest.capabilities.find(({ coordinates }) => (
    coordinates.some((coordinate) => coordinateKey(coordinate) === coordinateKey(removed.coordinate))
  ));
  assert.equal(capability.status, 'incomplete');
  assert.deepEqual(capability.reasons, ['required_coordinate_missing']);
});

test('a failed attempt cannot be erased by a later passing retry', () => {
  const input = aggregationInput();
  const coordinate = input.caseResults[0].coordinate;
  input.caseResults[0] = {
    ...input.caseResults[0],
    status: 'failed',
    reasons: ['content_digest_mismatch'],
  };
  input.caseResults.push(caseResult(coordinate, 'attempt-2'));
  const manifest = aggregateReleaseAudit(input);
  assert.equal(manifest.status, 'non_conformant');
  assert.ok(manifest.capabilities.some(({ status }) => status === 'failed'));
});

test('duplicate coordinate and attempt identity is rejected', () => {
  const input = aggregationInput();
  input.caseResults.push(structuredClone(input.caseResults[0]));
  assert.throws(() => aggregateReleaseAudit(input), /duplicate coordinate and attemptId/);
});

test('unknown case evidence and dirty harness can never conform', () => {
  const unknown = aggregationInput();
  unknown.caseResults.push(caseResult({
    ...unknown.caseResults[0].coordinate,
    caseId: 'unknown.case',
  }, 'unknown-attempt'));
  assert.equal(aggregateReleaseAudit(unknown).status, 'incomplete');

  const dirty = aggregationInput();
  dirty.release = release({ harnessDirty: true });
  dirty.caseResults = dirty.caseResults.map((result) => ({
    ...result,
    release: dirty.release,
  }));
  assert.equal(aggregateReleaseAudit(dirty).status, 'incomplete');
});

test('wrong fallback driver is a behavioral failure despite passing content', () => {
  const input = aggregationInput();
  const index = input.caseResults.findIndex(({ coordinate }) => (
    coordinate.caseId === 'fallback.ordered_observer'
  ));
  input.caseResults[index].observerEvidence[0].actualDriver = 'changeStreams';
  const manifest = aggregateReleaseAudit(input);
  assert.equal(manifest.status, 'non_conformant');
  assert.equal(
    manifest.capabilities.find(({ id }) => id === 'fallback.ordered_observer').status,
    'failed',
  );
});

test('Change Stream unavailability resolves exact fallback per topology', () => {
  const input = aggregationInput();
  const cases = input.caseResults.filter(({ coordinate }) => (
    coordinate.caseId === 'fallback.change_stream_unavailable'
  ));
  assert.equal(cases.length, 2);
  assert.equal(
    cases.find(({ coordinate }) => coordinate.topology === 'replica_set')
      .observerEvidence[0].actualDriver,
    'oplog',
  );
  assert.equal(
    cases.find(({ coordinate }) => coordinate.topology === 'standalone')
      .observerEvidence[0].actualDriver,
    'polling',
  );
  const manifest = aggregateReleaseAudit(input);
  assert.equal(
    manifest.capabilities.find(({ id }) => id === 'fallback.change_stream_unavailable').status,
    'verified_fallback',
  );
});

test('negative-control, recovery, and progress gates fail closed', () => {
  const missingControl = aggregationInput();
  missingControl.negativeControls.pop();
  assert.equal(aggregateReleaseAudit(missingControl).status, 'incomplete');

  const failedRecovery = aggregationInput();
  failedRecovery.recovery.topologyRestored = false;
  assert.equal(aggregateReleaseAudit(failedRecovery).status, 'incomplete');

  const invalidProgress = aggregationInput();
  invalidProgress.progress.lastSequence = 0;
  assert.throws(() => aggregateReleaseAudit(invalidProgress), /positive safe integer/);
});

test('one self-asserted oracle cannot satisfy an ordinary capability', () => {
  const input = aggregationInput();
  const eventInsert = input.caseResults.find(
    ({ coordinate }) => coordinate.caseId === 'event.insert',
  );
  eventInsert.oracles = [eventInsert.oracles[0]];
  const manifest = aggregateReleaseAudit(input);
  assert.equal(manifest.status, 'incomplete');
  assert.deepEqual(
    manifest.capabilities.find(({ id }) => id === 'event.insert').reasons,
    ['oracle_producer_missing:ddp_client'],
  );
});

test('fault evidence must be linked to an independent controller oracle', () => {
  const input = aggregationInput();
  const recoveryCase = input.caseResults.find(({ coordinate }) => coordinate.faultId);
  recoveryCase.oracles.find(({ producer }) => producer === 'fault_controller').digest = SHA;
  const manifest = aggregateReleaseAudit(input);
  assert.equal(manifest.status, 'incomplete');
  assert.deepEqual(
    manifest.capabilities.find(({ id }) => id === recoveryCase.coordinate.caseId).reasons,
    ['fault_witness_oracle_mismatch'],
  );
});
