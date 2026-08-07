// Prints every scenario, every app, and the resolved Meteor source.
// Pure: takes config and a resolved source as inputs, writes to stdout.

import type { BenchmarkConfig, MeteorSource } from '../lib/benchmark-types.js';

interface ListInputs { readonly config: BenchmarkConfig; readonly source: MeteorSource; }

/** Prints all configured scenarios, applications, and the resolved Meteor source. */
export function runList({ config, source }: ListInputs): void {
  console.log('\nAvailable scenarios:');
  for (const [name, s] of Object.entries(config.scenarios)) {
    console.log(`  ${name.padEnd(20)} ${s.description}`);
  }
  console.log('\nAvailable apps:');
  for (const [name, a] of Object.entries(config.apps)) {
    console.log(`  ${name.padEnd(20)} ${a.description}`);
  }
  console.log(`\nMeteor source: ${source.mode}`);
  if (source.mode === 'checkout') console.log(`  Checkout: ${source.checkoutPath}`);
  console.log(`  Version: ${source.version}  SHA: ${source.sha}\n`);
}
