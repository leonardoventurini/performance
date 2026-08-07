import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { FileHandle } from 'node:fs/promises';

const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EISDIR',
  'EINVAL',
  'ENOTSUP',
  'EPERM',
]);

/**
 * Error raised when an artifact target could escape its explicit audit root.
 */
export class ArtifactPathError extends Error {
  readonly artifactRoot: string | undefined;
  readonly targetPath: string | undefined;
  /**
   * Creates a stable artifact containment failure.
   */
  constructor(message: string, { artifactRoot, targetPath }: { artifactRoot?: string; targetPath?: string } = {}) {
    super(message);
    this.name = 'ArtifactPathError';
    this.artifactRoot = artifactRoot;
    this.targetPath = targetPath;
  }
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const offset = relative(rootPath, candidatePath);
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

async function assertNotSymlink(path: string, artifactRoot: string, targetPath: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new ArtifactPathError('Artifact path must not traverse or replace a symlink', {
      artifactRoot,
      targetPath,
    });
  }
  return true;
}

async function prepareContainedDirectory(rootPath: string, targetDirectory: string, originalRoot: string, targetPath: string): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await assertNotSymlink(rootPath, originalRoot, targetPath);
  const canonicalRoot = await realpath(rootPath);

  const directoryOffset = relative(rootPath, targetDirectory);
  let cursor = rootPath;
  for (const segment of directoryOffset.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const exists = await assertNotSymlink(cursor, originalRoot, targetPath);
    if (!exists) {
      await mkdir(cursor);
      await assertNotSymlink(cursor, originalRoot, targetPath);
    }
  }

  const canonicalDirectory = await realpath(targetDirectory);
  if (!isContained(canonicalRoot, canonicalDirectory)) {
    throw new ArtifactPathError('Artifact directory resolves outside its audit root', {
      artifactRoot: originalRoot,
      targetPath,
    });
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(directoryPath, 'r');
    await directoryHandle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code === undefined || !DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code)) throw error;
  } finally {
    await directoryHandle?.close();
  }
}

/**
 * Resolves an artifact target and rejects lexical escape and symlink traversal.
 */
export async function resolveArtifactPath({ artifactRoot, targetPath }: { artifactRoot: string; targetPath: string }): Promise<string> {
  if (typeof artifactRoot !== 'string' || artifactRoot.length === 0) {
    throw new TypeError('artifactRoot must be an explicit non-empty path');
  }
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new TypeError('targetPath must be a non-empty path');
  }

  const resolvedRoot = resolve(artifactRoot);
  const resolvedTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(resolvedRoot, targetPath);
  if (resolvedTarget === resolvedRoot || !isContained(resolvedRoot, resolvedTarget)) {
    throw new ArtifactPathError('Artifact target escapes its explicit audit root', {
      artifactRoot,
      targetPath,
    });
  }

  const targetDirectory = dirname(resolvedTarget);
  await prepareContainedDirectory(
    resolvedRoot,
    targetDirectory,
    artifactRoot,
    targetPath,
  );
  await assertNotSymlink(resolvedTarget, artifactRoot, targetPath);
  return resolvedTarget;
}

/**
 * Persists bounded JSON through a sibling temporary file and durable rename.
 */
export async function writeAtomicJson({
  artifactRoot,
  targetPath,
  value,
  space = 2,
}: { artifactRoot: string; targetPath: string; value: unknown; space?: number }): Promise<Readonly<{ algorithm: 'sha256'; digest: string; byteLength: number; path: string }>> {
  const resolvedTarget = await resolveArtifactPath({ artifactRoot, targetPath });
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, space);
  } catch (error) {
    throw new TypeError('Artifact value must be JSON serializable', { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError('Artifact value must serialize to JSON');
  }

  const contents = Buffer.from(`${serialized}\n`, 'utf8');
  const targetDirectory = dirname(resolvedTarget);
  const temporaryPath = join(
    targetDirectory,
    `.${basename(resolvedTarget)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryHandle: FileHandle | undefined;
  let temporaryExists = false;
  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    await temporaryHandle.writeFile(contents);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await assertNotSymlink(resolvedTarget, artifactRoot, targetPath);
    await rename(temporaryPath, resolvedTarget);
    temporaryExists = false;
    await syncDirectory(targetDirectory);
  } finally {
    await temporaryHandle?.close();
    if (temporaryExists) {
      await unlink(temporaryPath).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  }

  return Object.freeze({
    algorithm: 'sha256',
    digest: createHash('sha256').update(contents).digest('hex'),
    byteLength: contents.byteLength,
    path: relative(resolve(artifactRoot), resolvedTarget),
  });
}

/** Descriptive alias used by artifact-oriented call sites. */
export const writeAtomicJsonArtifact = writeAtomicJson;
