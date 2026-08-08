import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  validateReleaseAuditArtifact,
} from '../../../cli/release-audit-validate.js';

describe('release audit artifact validation', () => {
  test('requires an exact manifest path', () => {
    assert.throws(() => validateReleaseAuditArtifact(), /requires --manifest/u);
  });

  test('rejects a missing manifest', () => {
    assert.throws(
      () => validateReleaseAuditArtifact('results/release-audits/missing/manifest.json'),
      /ENOENT/u,
    );
  });
});
