import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest } from './contracts.js';
import { digestFiles, listFiles } from './files.js';

const MANIFEST_NAME = 'build-manifest.json';
const ASSET_ROOTS = ['artillery', 'reliability/definitions', 'tests/unit/fixtures'] as const;
const INPUT_ROOTS = [
  'build', 'cli', 'collectors', 'drivers', 'lib', 'reliability', 'reporters', 'runner',
  'scripts/helpers', 'tests', 'types', 'typescript-tools',
] as const;
const INPUT_FILES = [
  'bench.js', 'bench.ts', 'bench.config.ts', 'meteor-source.ts', 'package.json', 'package-lock.json',
  'playwright.config.ts', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.node.json',
  'tsconfig.hosts.json', 'tsconfig.playwright.json', 'tsconfig.tools.json',
] as const;

async function existingInputFiles(repositoryRoot: string): Promise<string[]> {
  const discovered: string[] = [];
  for (const inputRoot of INPUT_ROOTS) {
    const absoluteRoot = path.join(repositoryRoot, inputRoot);
    try {
      const files = await listFiles(absoluteRoot);
      discovered.push(...files.map((file) => `${inputRoot}/${file}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const inputFile of INPUT_FILES) {
    try {
      await readFile(path.join(repositoryRoot, inputFile));
      discovered.push(inputFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...new Set(discovered)].sort();
}

async function cleanOutput(repositoryRoot: string, outputRoot: string): Promise<void> {
  const resolvedRepository = await realpath(repositoryRoot);
  const resolvedParent = await realpath(path.dirname(outputRoot));
  if (resolvedParent !== resolvedRepository || path.basename(outputRoot) !== 'dist') {
    throw new Error(`refusing to clean untrusted output directory: ${outputRoot}`);
  }
  await rm(outputRoot, { recursive: true, force: true });
}

async function copyAssets(repositoryRoot: string, outputRoot: string): Promise<void> {
  for (const assetRoot of ASSET_ROOTS) {
    const files = await listFiles(path.join(repositoryRoot, assetRoot));
    for (const file of files) {
      const relativePath = `${assetRoot}/${file}`;
      const destination = path.join(outputRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(repositoryRoot, relativePath), destination);
    }
  }
}

/** Produces clean emitted output, copied runtime assets, and a canonical manifest. */
async function build(): Promise<void> {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outputRoot = path.join(repositoryRoot, 'dist');
  await cleanOutput(repositoryRoot, outputRoot);
  execFileSync(process.execPath, [
    path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.node.json', '--pretty', 'false',
  ], { cwd: repositoryRoot, stdio: 'inherit' });
  execFileSync(process.execPath, [
    path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.playwright.json', '--pretty', 'false',
  ], { cwd: repositoryRoot, stdio: 'inherit' });
  await copyAssets(repositoryRoot, outputRoot);

  const inputs = await existingInputFiles(repositoryRoot);
  const outputs = (await listFiles(outputRoot))
    .filter((file) => file !== MANIFEST_NAME && !file.endsWith('.tsbuildinfo'));
  const manifest: BuildManifest = {
    version: 1,
    inputs: await digestFiles(repositoryRoot, inputs),
    outputs: await digestFiles(outputRoot, outputs),
  };
  await writeFile(path.join(outputRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

await build();
