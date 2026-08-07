#!/usr/bin/env node

/**
 * Stable Node entry point for the compiled benchmark CLI.
 * Domain behavior belongs to `bench.ts`; this host adapter only rejects a
 * missing or stale build before loading it in the current process.
 */

import { pathToFileURL } from 'node:url';

const STALE_BUILD_EXIT_CODE = 1;

try {
  const verifierUrl = pathToFileURL(`${import.meta.dirname}/dist/build/runtime-manifest.js`).href;
  const verifierModule = await import(verifierUrl);
  if (typeof verifierModule.verifyBuildManifest !== 'function') {
    throw new Error('compiled build verifier is missing');
  }
  await verifierModule.verifyBuildManifest();

  const benchmarkModule = await import(pathToFileURL(`${import.meta.dirname}/dist/bench.js`).href);
  if (typeof benchmarkModule.main === 'function') {
    await benchmarkModule.main({
      argv: process.argv.slice(2),
      env: process.env,
      repositoryRoot: import.meta.dirname,
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Unable to start the benchmark CLI: ${message}`);
  console.error('Run `npm run build` and retry.');
  process.exitCode = STALE_BUILD_EXIT_CODE;
}
