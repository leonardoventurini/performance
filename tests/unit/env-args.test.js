import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of splitEnvArgs in bench.js. Duplicated rather than imported because
// bench.js runs top-level CLI dispatch on import (parseArgs + switch on positionals).
// Once cli/run.js exists (commit 10), this test will import from there and the
// duplicate can be deleted.
function splitEnvArgs(rawEnvArray) {
  const out = {};
  if (!rawEnvArray) return out;
  const list = Array.isArray(rawEnvArray) ? rawEnvArray : [rawEnvArray];
  for (const e of list) {
    const idx = e.indexOf('=');
    if (idx > 0) out[e.slice(0, idx)] = e.slice(idx + 1);
  }
  return out;
}

test('multiple KEY=VALUE pairs', () => {
  assert.deepEqual(splitEnvArgs(['A=1', 'B=2']), { A: '1', B: '2' });
});

test('single pair as string (not array)', () => {
  assert.deepEqual(splitEnvArgs('FOO=bar'), { FOO: 'bar' });
});

test('single pair in array', () => {
  assert.deepEqual(splitEnvArgs(['FOO=bar']), { FOO: 'bar' });
});

test('empty value after = is preserved', () => {
  assert.deepEqual(splitEnvArgs(['A=']), { A: '' });
});

test('splits on first = so values may contain =', () => {
  assert.deepEqual(splitEnvArgs(['A=B=C']), { A: 'B=C' });
});

test('entries without = are skipped', () => {
  assert.deepEqual(splitEnvArgs(['NOEQUALS']), {});
});

test('entries starting with = are skipped (idx must be > 0)', () => {
  assert.deepEqual(splitEnvArgs(['=value']), {});
});

test('empty array yields empty object', () => {
  assert.deepEqual(splitEnvArgs([]), {});
});

test('null input yields empty object', () => {
  assert.deepEqual(splitEnvArgs(null), {});
});

test('undefined input yields empty object', () => {
  assert.deepEqual(splitEnvArgs(undefined), {});
});

test('mixes valid and skipped entries', () => {
  assert.deepEqual(
    splitEnvArgs(['A=1', 'NOEQ', 'B=2', '=skipme']),
    { A: '1', B: '2' }
  );
});
