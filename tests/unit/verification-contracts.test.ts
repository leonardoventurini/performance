import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPOSITORY_ROOT = process.cwd();
const WORKFLOW_DIRECTORY = path.join(REPOSITORY_ROOT, '.github', 'workflows');
const WORKFLOW_NAMES = [
  'benchmark-nightly.yml',
  'benchmark-pr.yml',
  'benchmark-runtime-matrix.yml',
  'benchmark-transport.yml',
] as const;
const WORKFLOW_GATE_ORDER = [
  'name: Install root dependencies',
  'name: Install task app dependencies',
  'name: Install dashboard dependencies',
  'name: Type-check all TypeScript workspaces',
  'name: Verify maintained source inventory',
  'name: Build benchmark harness',
  'name: Run ',
] as const;

/** Returns the first offset of a required contract marker after an earlier gate. */
function requiredOffset(source: string, marker: string, after: number, fileName: string): number {
  const offset = source.indexOf(marker, after);
  assert.notEqual(offset, -1, `${fileName} must contain ${marker}`);
  return offset;
}

test('benchmark workflows enforce workspace installs, strict typing, inventory, and build before runtime', () => {
  for (const workflowName of WORKFLOW_NAMES) {
    const source = fs.readFileSync(path.join(WORKFLOW_DIRECTORY, workflowName), 'utf8');
    let previousOffset = 0;

    for (const gate of WORKFLOW_GATE_ORDER) {
      previousOffset = requiredOffset(source, gate, previousOffset, workflowName);
    }

    assert.match(source, /working-directory: apps\/tasks-3\.x/);
    assert.match(source, /working-directory: apps\/dashboard/);
    assert.match(source, /run: npm run typecheck:all/);
    assert.match(source, /run: npm run test:source-inventory/);
    assert.match(source, /run: npm run build/);
  }
});

test('Just verification gates preserve fast and all-workspace TypeScript coverage', () => {
  const source = fs.readFileSync(path.join(REPOSITORY_ROOT, 'justfile'), 'utf8');

  assert.match(
    source,
    /^check: typecheck source-inventory test bench-list playwright-list syntax-check dashboard-css-check$/m,
  );
  assert.match(source, /^check-all: install check typecheck-all test-task test-dashboard$/m);
  assert.match(source, /^typecheck:\n    npm run typecheck:node$/m);
  assert.match(source, /^typecheck-all:\n    npm run typecheck:all$/m);
  assert.match(source, /^source-inventory:\n    npm run test:source-inventory$/m);
});
