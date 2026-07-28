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
  /**
   * Creates a stable artifact containment failure.
   */
  constructor(message, { artifactRoot, targetPath } = {}) {
    super(message);
    this.name = 'ArtifactPathError';
    this.artifactRoot = artifactRoot;
    this.targetPath = targetPath;
  }
}

function isContained(rootPath, candidatePath) {
  const offset = relative(rootPath, candidatePath);
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset));
}

async function assertNotSymlink(path, artifactRoot, targetPath) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
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

async function prepareContainedDirectory(rootPath, targetDirectory, originalRoot, targetPath) {
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

async function syncDirectory(directoryPath) {
  let directoryHandle;
  try {
    directoryHandle = await open(directoryPath, 'r');
    await directoryHandle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error.code)) throw error;
  } finally {
    await directoryHandle?.close();
  }
}

/**
 * Resolves an artifact target and rejects lexical escape and symlink traversal.
 */
export async function resolveArtifactPath({ artifactRoot, targetPath }) {
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
}) {
  const resolvedTarget = await resolveArtifactPath({ artifactRoot, targetPath });
  let serialized;
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
  let temporaryHandle;
  let temporaryExists = false;
  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    await temporaryHandle.writeFile(contents);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;

    await assertNotSymlink(resolvedTarget, artifactRoot, targetPath);
    await rename(temporaryPath, resolvedTarget);
    temporaryExists = false;
    await syncDirectory(targetDirectory);
  } finally {
    await temporaryHandle?.close();
    if (temporaryExists) {
      await unlink(temporaryPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
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
