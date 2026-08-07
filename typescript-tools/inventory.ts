import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from './files.js';

const ALLOWED_JAVASCRIPT = new Set([
  'bench.js',
  'apps/tasks-3.x/packages/bench-monitors/package.js',
  'apps/tasks-3.x/packages/tasks-common/package.js',
  'apps/dashboard/rspack.config.js',
]);

const IGNORED_SEGMENTS = new Set(['.git', '.meteor', '.typescript-tools', '_build', 'dist', 'node_modules', 'playwright-report', 'results']);

/** Fails when maintained JavaScript remains outside the four required hosts. */
export async function verifySourceInventory(repositoryRoot: string): Promise<void> {
  const files = await listFiles(repositoryRoot);
  const unexpected = files.filter((file) => (
    !file.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))
    && /\.(?:c?js|jsx|mjs)$/.test(file)
    && !ALLOWED_JAVASCRIPT.has(file)
  ));
  if (unexpected.length > 0) {
    throw new Error(`unexpected maintained JavaScript:\n${unexpected.map((file) => `- ${file}`).join('\n')}`);
  }
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await verifySourceInventory(repositoryRoot);
console.log('Source inventory contains only the four declared JavaScript hosts.');
