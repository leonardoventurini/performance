import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'build-manifest.json';
const INPUT_ROOTS = [
  'build', 'cli', 'collectors', 'drivers', 'lib', 'reliability', 'reporters', 'runner',
  'scripts/helpers', 'tests', 'types', 'typescript-tools',
] as const;
const INPUT_FILES = [
  'bench.js', 'bench.ts', 'bench.config.ts', 'meteor-source.ts', 'package.json', 'package-lock.json',
  'playwright.config.ts', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.node.json',
  'tsconfig.hosts.json', 'tsconfig.playwright.json', 'tsconfig.tools.json',
] as const;

/** A content-addressed file recorded by the deterministic root build. */
export interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
}

/** Closed schema used to attest every root runtime input and output. */
export interface BuildManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly inputs: readonly ManifestFile[];
  readonly outputs: readonly ManifestFile[];
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function isManifestFile(value: unknown): value is ManifestFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.path === 'string' && typeof candidate.sha256 === 'string';
}

function parseManifest(value: unknown): BuildManifest {
  if (typeof value !== 'object' || value === null) throw new Error('build manifest is not an object');
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.version !== MANIFEST_VERSION
    || !Array.isArray(candidate.inputs)
    || !candidate.inputs.every(isManifestFile)
    || !Array.isArray(candidate.outputs)
    || !candidate.outputs.every(isManifestFile)) {
    throw new Error('build manifest schema is unsupported');
  }
  return {
    version: MANIFEST_VERSION,
    inputs: candidate.inputs as ManifestFile[],
    outputs: candidate.outputs as ManifestFile[],
  };
}

/** Verifies that each declared manifest file exists beneath its root with unchanged contents. */
export async function verifyManifestFiles(root: string, files: readonly ManifestFile[], kind: string): Promise<void> {
  for (const file of files) {
    const absolutePath = path.resolve(root, file.path);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`${kind} escapes repository: ${file.path}`);
    let contents: Uint8Array;
    try {
      contents = await readFile(absolutePath);
    } catch {
      throw new Error(`${kind} is missing: ${file.path}`);
    }
    if (sha256(contents) !== file.sha256) throw new Error(`${kind} is stale: ${file.path}`);
  }
}

async function listOutputFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
    }
  }
  await visit(root);
  return files.sort();
}

async function listCurrentInputs(repositoryRoot: string): Promise<string[]> {
  const inputs: string[] = [];
  for (const inputRoot of INPUT_ROOTS) {
    const absoluteRoot = path.join(repositoryRoot, inputRoot);
    try {
      const files = await listOutputFiles(absoluteRoot);
      inputs.push(...files.map((file) => `${inputRoot}/${file}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const inputFile of INPUT_FILES) {
    try {
      await readFile(path.join(repositoryRoot, inputFile));
      inputs.push(inputFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...new Set(inputs)].sort();
}

/** Rejects both undeclared current files and declared files absent from the current inventory. */
export function assertSameInventory(actual: readonly string[], declared: readonly ManifestFile[], kind: string): void {
  const declaredPaths = declared.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declaredPaths)) {
    throw new Error(`${kind} inventory does not match its manifest`);
  }
}

/** Rejects absent, malformed, modified, or incomplete emitted build output. */
export async function verifyBuildManifest(): Promise<void> {
  const outputRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repositoryRoot = path.dirname(outputRoot);
  const manifestPath = path.join(outputRoot, MANIFEST_NAME);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
  assertSameInventory(await listCurrentInputs(repositoryRoot), manifest.inputs, 'build input');
  await verifyManifestFiles(repositoryRoot, manifest.inputs, 'build input');
  await verifyManifestFiles(outputRoot, manifest.outputs, 'build output');

  const emittedFiles = (await listOutputFiles(outputRoot))
    .filter((relativePath) => relativePath !== MANIFEST_NAME && !relativePath.endsWith('.tsbuildinfo'))
    .sort();
  assertSameInventory(emittedFiles, manifest.outputs, 'build output');
}
