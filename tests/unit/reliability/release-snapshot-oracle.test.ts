import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { snapshotDigest } from '../../../reliability/oracles/snapshot.js';

describe('release audit snapshot oracle', () => {
  test('normalizes DDP ids and ignores document ordering', () => {
    const mongo = [
      { _id: 'b', value: 2 },
      { _id: 'a', value: 1 },
    ];
    const ddp = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ];
    assert.equal(snapshotDigest(mongo), snapshotDigest(ddp));
  });

  test('detects stale, missing, and corrupted content', () => {
    const expected = [{ _id: 'a', value: { nested: true } }];
    assert.notEqual(snapshotDigest(expected), snapshotDigest([]));
    assert.notEqual(
      snapshotDigest(expected),
      snapshotDigest([{ _id: 'a', value: { nested: false } }]),
    );
  });
});
