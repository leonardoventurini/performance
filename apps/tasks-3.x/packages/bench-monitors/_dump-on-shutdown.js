// Shared shutdown-dump pattern for every monitor in this package.
// Each monitor accumulates samples in-memory and needs to flush them
// to a file synchronously on SIGTERM/SIGINT/beforeExit (Meteor's grace
// is short, async writes risk loss). All three monitors did this
// inline before — extracted here once the third caller landed.
//
// `getDump` is called at shutdown time, NOT at install time, so the
// caller can keep mutating its samples Map up to the last moment.
// `label` namespaces the error message if the write fails — read it
// in stderr to know which monitor lost data.

import fs from 'node:fs';

export function installDumpOnShutdown(outputPath, getDump, label) {
  if (!outputPath) return;
  const dumpOnce = (() => {
    let dumped = false;
    return () => {
      if (dumped) return;
      dumped = true;
      try {
        fs.writeFileSync(outputPath, JSON.stringify(getDump()));
      } catch (err) {
        process.stderr.write(`[${label}] dump failed: ${err.message}\n`);
      }
    };
  })();
  process.on('SIGTERM', dumpOnce);
  process.on('SIGINT', dumpOnce);
  process.on('beforeExit', dumpOnce);
}
