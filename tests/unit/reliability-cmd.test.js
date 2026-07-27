import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditRunValues } from '../../cli/audit.js';

describe('reliability command', () => {
  test('defaults to the bounded change-stream smoke profile', () => {
    assert.deepEqual(buildAuditRunValues({}), {
      scenario: 'change-stream-audit-smoke',
      env: ['METEOR_REACTIVITY_ORDER=changeStreams'],
      scriptArgs: ['--observer-driver', 'changeStreams'],
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
    assert.equal(values.scenario, 'change-stream-audit-extreme');
    assert.deepEqual(values.env, [
      'MONGO_OPLOG_URL=mongodb://localhost:3001/local',
      'METEOR_REACTIVITY_ORDER=oplog',
    ]);
    assert.deepEqual(values.scriptArgs, [
      '--observer-driver', 'oplog',
      '--seed', '73', '--allow-remote-mongo',
    ]);
  });

  test('rejects unknown profiles and observer drivers', () => {
    assert.throws(() => buildAuditRunValues({ profile: 'huge' }), /Unknown audit profile/);
    assert.throws(() => buildAuditRunValues({ 'observer-driver': 'polling' }), /Unknown observer driver/);
  });
});
