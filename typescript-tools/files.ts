import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DigestedFile } from './contracts.js';

/** Returns stable slash-separated file paths below a directory. */
export async function listFiles(root: string): Promise<string[]> {
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

/** Hashes repository-relative files in canonical path order. */
export async function digestFiles(root: string, relativePaths: readonly string[]): Promise<DigestedFile[]> {
  return Promise.all([...relativePaths].sort().map(async (relativePath) => ({
    path: relativePath,
    sha256: createHash('sha256').update(await readFile(path.join(root, relativePath))).digest('hex'),
  })));
}
