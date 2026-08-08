import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseJson } from '../../lib/data-values.js';

test('task fixture leaves Meteor generated CommonJS launchers outside ESM package scope', () => {
  const packagePath = path.resolve(import.meta.dirname, '../../../apps/tasks-3.x/package.json');
  const parsed = parseJson(fs.readFileSync(packagePath, 'utf8'));
  assert.equal(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'type' in parsed, false);
});
