import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyntheticDocument } from '../../reliability/synthetic-data.js';
import {
  buildMutation,
  summarizeCapabilities,
} from '../../reliability/operation-matrix.js';

describe('reliability operation matrix', () => {
  test('cycles through supported update and replacement shapes deterministically', () => {
    let previous = buildSyntheticDocument({
      runId: 'run', sequence: 1, revision: 0, payloadBytes: 256, seed: 7,
    });
    const ids = [];
    for (let revision = 1; revision <= 5; revision += 1) {
      const mutation = buildMutation({ previous, revision, payloadBytes: 256, seed: 7 });
      ids.push(mutation.operationId);
      assert.deepEqual(mutation.write[mutation.operationId === 'replace' ? 'replaceOne' : 'updateOne'].filter, {
        _id: 'run:1',
        runId: 'run',
      });
      previous = mutation.next;
    }
    assert.deepEqual(ids, [
      'update.set', 'update.unset', 'update.increment', 'update.array', 'replace',
    ]);
    assert.equal(previous.revision, 5);
  });

  test('reports supported, fallback, and unsupported capabilities explicitly', () => {
    const matrix = summarizeCapabilities({ insert: 'passed', 'update.set': 'failed', delete: 'passed' });
    assert.equal(matrix.find((item) => item.id === 'insert').audit_status, 'passed');
    assert.equal(matrix.find((item) => item.id === 'replace').audit_status, 'not_exercised');
    assert.equal(matrix.find((item) => item.id === 'ordered_observer').audit_status, 'fallback_expected');
    assert.equal(matrix.find((item) => item.id === 'collection_ddl').audit_status, 'not_supported');
  });
});
