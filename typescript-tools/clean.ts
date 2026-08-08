import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Deletes only the repository's validated generated TypeScript directories. */
async function clean(): Promise<void> {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const resolvedRoot = await realpath(repositoryRoot);
  for (const name of ['dist', '.typescript-tools']) {
    const target = path.join(repositoryRoot, name);
    if (path.dirname(target) !== resolvedRoot || path.basename(target) !== name) {
      throw new Error(`refusing to clean untrusted path: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

await clean();
