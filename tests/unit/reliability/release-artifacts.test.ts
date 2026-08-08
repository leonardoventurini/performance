import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  ArtifactPathError,
  resolveArtifactPath,
  writeAtomicJson,
} from '../../../reliability/release-audit/atomic-artifacts.js';

const temporaryDirectories: string[] = [];

async function temporaryRoot() {
  const directory = await mkdtemp(join(tmpdir(), 'release-artifacts-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe('release audit atomic artifacts', () => {
  test('atomically writes JSON and returns its content digest', async () => {
    const artifactRoot = await temporaryRoot();
    const reference = await writeAtomicJson({
      artifactRoot,
      targetPath: 'cases/case-1.json',
      value: { status: 'passed', attempts: 1 },
    });
    const target = join(artifactRoot, 'cases/case-1.json');
    const contents = await readFile(target);

    assert.deepEqual(reference, {
      algorithm: 'sha256',
      digest: createHash('sha256').update(contents).digest('hex'),
      byteLength: contents.byteLength,
      path: 'cases/case-1.json',
    });
    assert.deepEqual(JSON.parse(contents.toString('utf8')), { status: 'passed', attempts: 1 });
    assert.equal((await lstat(target)).isSymbolicLink(), false);
    assert.deepEqual(await readdir(dirname(target)), ['case-1.json']);
  });

  test('replaces an existing regular artifact atomically', async () => {
    const artifactRoot = await temporaryRoot();
    const target = join(artifactRoot, 'manifest.json');
    await writeFile(target, '{"status":"incomplete"}\n');

    await writeAtomicJson({
      artifactRoot,
      targetPath: 'manifest.json',
      value: { status: 'conformant' },
    });

    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
      status: 'conformant',
    });
  });

  test('rejects lexical output escape from the explicit root', async () => {
    const artifactRoot = await temporaryRoot();

    await assert.rejects(
      resolveArtifactPath({
        artifactRoot,
        targetPath: '../outside.json',
      }),
      (error) => error instanceof ArtifactPathError && /escapes/.test(error.message),
    );
  });

  test('rejects an absolute output outside the explicit root', async () => {
    const artifactRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot();

    await assert.rejects(
      writeAtomicJson({
        artifactRoot,
        targetPath: join(outsideRoot, 'manifest.json'),
        value: {},
      }),
      /escapes its explicit audit root/,
    );
  });

  test('rejects symlinked parent directories and final targets', async () => {
    const artifactRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    await symlink(outsideRoot, join(artifactRoot, 'cases'));

    await assert.rejects(
      writeAtomicJson({
        artifactRoot,
        targetPath: 'cases/case-1.json',
        value: {},
      }),
      /must not traverse or replace a symlink/,
    );

    await mkdir(join(artifactRoot, 'evidence'));
    const outsideFile = join(outsideRoot, 'outside.json');
    await writeFile(outsideFile, '{}');
    await symlink(outsideFile, join(artifactRoot, 'evidence/oracle.json'));

    await assert.rejects(
      writeAtomicJson({
        artifactRoot,
        targetPath: 'evidence/oracle.json',
        value: {},
      }),
      /must not traverse or replace a symlink/,
    );
  });
});
