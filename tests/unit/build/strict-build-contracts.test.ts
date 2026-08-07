import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSameInventory,
  verifyManifestFiles,
  type ManifestFile,
} from '../../../build/runtime-manifest.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Hashes fixture content using the manifest's canonical digest. */
function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

test('manifest inventory rejects additions and deletions', () => {
  const declared: readonly ManifestFile[] = [{ path: 'a.ts', sha256: digest('a') }];
  assert.throws(() => assertSameInventory(['a.ts', 'b.ts'], declared, 'build input'), /inventory/);
  assert.throws(() => assertSameInventory([], declared, 'build input'), /inventory/);
});

test('manifest file verification rejects modified content and missing files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-build-manifest-'));
  await writeFile(path.join(root, 'input.ts'), 'modified', 'utf8');
  const declared: readonly ManifestFile[] = [{ path: 'input.ts', sha256: digest('original') }];
  await assert.rejects(verifyManifestFiles(root, declared, 'build input'), /stale/);
  await assert.rejects(verifyManifestFiles(root, [{ path: 'missing.ts', sha256: digest('') }], 'build input'), /missing/);
});

test('source inventory rejects unsafe TypeScript escape hatches and emitted imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-source-inventory-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/unsafe.ts'), [
    "import '../dist/runtime.js';",
    'declare const value: any;',
    'declare const optional: { id: string } | undefined;',
    'void optional!.id;',
    'void (value as unknown as string);',
    '// @ts-ignore forbidden suppression',
  ].join('\n'), 'utf8');

  assert.throws(() => execFileSync(process.execPath, [
    path.join(repositoryRoot, '.typescript-tools/inventory.js'), root,
  ], { encoding: 'utf8', stdio: 'pipe' }), (error: unknown) => {
    assert.ok(error instanceof Error && 'stderr' in error);
    const stderr = String(error.stderr);
    assert.ok(stderr.includes(`explicit ${'any'} is forbidden`));
    assert.match(stderr, /non-null assertions are forbidden/);
    assert.match(stderr, /double type assertions are forbidden/);
    assert.match(stderr, /source imports from dist are forbidden/);
    assert.match(stderr, /@ts-ignore is forbidden/);
    return true;
  });
});

test('stable launcher fails closed when the emitted CLI omits main', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strict-launcher-'));
  await mkdir(path.join(root, 'dist/build'), { recursive: true });
  await copyFile(path.join(repositoryRoot, 'bench.js'), path.join(root, 'bench.js'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
  await writeFile(
    path.join(root, 'dist/build/runtime-manifest.js'),
    'export async function verifyBuildManifest() {}\n',
    'utf8',
  );
  await writeFile(path.join(root, 'dist/bench.js'), 'export const invalid = true;\n', 'utf8');

  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'bench.js')], {
    encoding: 'utf8',
    stdio: 'pipe',
  }), (error: unknown) => {
    assert.ok(error instanceof Error && 'stderr' in error);
    assert.match(String(error.stderr), /compiled benchmark entry point is missing main\(\)/);
    return true;
  });
});
