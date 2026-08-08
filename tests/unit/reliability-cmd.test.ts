import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditRunValues, runAudit } from '../../cli/audit.js';
import type { BenchmarkResult } from '../../reporters/json-reporter.js';
import type { CaseCoordinate } from '../../reliability/contracts/release-audit.js';

interface TestAuditOutcome {
  readonly coordinate: CaseCoordinate;
  readonly attemptId: string;
  readonly status: 'passed';
  readonly reasons: readonly string[];
}


describe('reliability command', () => {
  test('defaults to the bounded change-stream smoke profile', () => {
    assert.deepEqual(buildAuditRunValues({}), {
      profile: 'smoke',
      observerDriver: 'changeStreams',
      observerOrder: ['changeStreams', 'oplog', 'polling'],
      seed: 42,
    });
  });

  test('maps the extreme oplog profile and preserves explicit environment', () => {
    const values = buildAuditRunValues({
      profile: 'extreme',
      'observer-driver': 'oplog',
      seed: '73',
      env: ['MONGO_OPLOG_URL=mongodb://localhost:3001/local'],
      'allow-remote-mongo': true,
    });
    assert.equal(values.profile, 'extreme');
    assert.equal(values.observerDriver, 'oplog');
    assert.deepEqual(values.observerOrder, ['oplog', 'changeStreams', 'polling']);
    assert.equal(values.seed, 73);
    assert.deepEqual(values.env, ['MONGO_OPLOG_URL=mongodb://localhost:3001/local']);
    assert.equal(values['allow-remote-mongo'], true);
  });

  test('rejects unknown profiles and observer drivers', () => {
    assert.throws(() => buildAuditRunValues({ profile: 'huge' }), /Unknown audit profile/);
    assert.throws(() => buildAuditRunValues({ 'observer-driver': 'polling' }), /Unknown observer driver/);
  });
});

test('audit compiles catalog cases and persists the canonical result envelope', async () => {
  const written: Array<Readonly<{ kind: string; value: BenchmarkResult; output: string }>> = [];
  const definition = {
    id: 'event.insert',
    applicability: [{
      topologies: ['replica_set'],
      transports: ['sockjs'],
      observerOrders: [['changeStreams', 'oplog', 'polling']],
    }],
    steps: [],
  };
  const catalog = {
    contract: { id: 'contract-v1' },
    digest: 'a'.repeat(64),
    cases: [definition],
    casesById: new Map([[definition.id, definition]]),
  };
  const executeCase = async ({ coordinate, attemptId }: Readonly<{ coordinate: CaseCoordinate; attemptId: string }>): Promise<TestAuditOutcome> => ({
    coordinate,
    attemptId,
    status: 'passed',
    reasons: [],
  });
  executeCase.finalize = async () => ({
    negativeControls: [{
      controlId: 'control-1', expectedReason: 'detected', actualReason: 'detected',
      detected: true, evidenceDigest: 'b'.repeat(64),
    }],
    recovery: {
      runDocumentsRemoved: true, topologyRestored: true,
      profilerRestored: true, networkRestored: true, digest: 'c'.repeat(64),
    },
  });
  const result = await runAudit({
    values: { output: 'result.json', tag: 'test-audit' },
    config: {
      apps: { 'tasks-3.x': { path: '/fixture' } },
      results: { dir: 'results', history: 'history' },
    },
    dependencies: {
      resolveMeteorSource: () => ({
        mode: 'release', meteorCmd: 'meteor', releaseArg: '--release=3.5.1-beta.0',
        checkoutPath: null, version: '3.5.1-beta.0', sha: 'release:3.5.1-beta.0',
      }),
      loadCatalog: () => catalog,
      attestReleaseIdentity: () => ({
        requested: '3.5.1-beta.0', actual: '3.5.1-beta.0', harnessDirty: false,
      }),
      createExecutor: () => executeCase,
      writeResult: (value: BenchmarkResult, output: string) => { written.push({ kind: 'result', value, output }); },
      appendToHistory: (value: BenchmarkResult, output: string) => { written.push({ kind: 'history', value, output }); },
    },
  });
  const metric = result.metrics.change_stream_audit;
  assert.ok(metric);
  assert.equal(metric.status, 'passed');
  assert.equal(metric.executed_cases, 1);
  assert.equal(result.scenario, 'change-stream-audit-smoke');
  assert.deepEqual(written.map(({ kind, output }) => ({ kind, output })), [
    { kind: 'result', output: 'result.json' },
    { kind: 'history', output: 'history' },
  ]);
});
