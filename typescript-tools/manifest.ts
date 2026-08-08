import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Shape required from the emitted runtime manifest verifier. */
interface RuntimeManifestModule {
  verifyBuildManifest(): Promise<void>;
}

function isRuntimeManifestModule(value: unknown): value is RuntimeManifestModule {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Readonly<Record<string, unknown>>).verifyBuildManifest === 'function';
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'dist/build/runtime-manifest.js')).href;
const runtimeModule: unknown = await import(moduleUrl);
if (!isRuntimeManifestModule(runtimeModule)) throw new Error('compiled manifest verifier is missing');
await runtimeModule.verifyBuildManifest();
console.log('Build manifest and emitted inventory are current.');
