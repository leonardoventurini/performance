import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createReleaseCaseExecutor } from '../../../cli/release-audit.js';

describe('release audit CLI case adapter', () => {
  test('exposes only independently qualified bounded CRUD coordinates', () => {
    const executeCase = createReleaseCaseExecutor({
      values: {},
      config: {},
      releaseName: '3.5.1-beta.0',
      releaseIdentity: {},
    });
    assert.equal(executeCase.supports({
      caseId: 'event.insert',
      topology: 'replica_set',
      transport: 'sockjs',
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    }), true);
    assert.equal(executeCase.supports({
      caseId: 'session.resume.within_grace_period',
      topology: 'replica_set',
      transport: 'sockjs',
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    }), false);
    assert.equal(executeCase.supports({
      caseId: 'event.insert',
      topology: 'standalone',
      transport: 'sockjs',
      observerOrder: ['changeStreams', 'oplog', 'polling'],
    }), false);
  });
});
