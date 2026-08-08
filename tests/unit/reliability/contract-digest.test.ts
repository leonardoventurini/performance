import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../../../reliability/contracts/digest.js';

test('canonical JSON reports the exact non-serializable contract path', () => {
  assert.throws(
    () => canonicalJson({ observed: [{ nested: undefined }] }),
    /contract value at \$\.observed\[0\]\.nested must be JSON-serializable/u,
  );
});
