# Strict TypeScript runtime

Date: 2026-08-07

## Decision

All maintained benchmark, reliability, dashboard, task-fixture, test, browser,
collector, Artillery, and legacy Node-helper logic is authored in strict
TypeScript. Root programs compile deterministically to ignored `dist/` output;
Meteor continues to compile its application sources. Runtime TypeScript
loaders are not part of production, test, workflow, or subprocess execution.

Four framework-owned JavaScript hosts remain: the stable `bench.js` launcher,
two Meteor `package.js` descriptors, and the dashboard Rspack configuration.
They contain no domain behavior, are checked with `allowJs`/`checkJs`, and are
the complete source-inventory allowlist.

The public launcher validates a content-addressed manifest before importing
`dist/bench.js` in process. Verification recomputes the complete current input
and emitted-output inventories, checks every digest, and fails closed for
missing `main()`. Collectors, Artillery, Playwright, the GC preload, fanout,
and shell helpers resolve only emitted programs. Playwright discovers emitted
JavaScript, not source TypeScript transformed at runtime.

## Contracts and invariants

- Root, task, dashboard, host, test, and portability compiler projects enable
  strict optional, indexed-access, unused-symbol, switch, return, module, and
  casing checks.
- The inventory gate rejects undeclared JavaScript, unowned TypeScript,
  source-to-`dist` imports, explicit `any`, non-null assertions, unsafe double
  assertions, and diagnostic suppressions. Dedicated negative fixtures may
  use only consumed `@ts-expect-error` directives.
- JSON, EJSON, and BSON have separate recursive value contracts. Parsed
  collector and push-result JSON remains `unknown` until runtime validation;
  metric keys must match their self-declared identity.
- Root emission excludes Meteor implementation sources. Meteor package tests
  stay in their package emit owner and use weak test-only driver dependencies,
  keeping production package selections clean.
- The task app does not declare package-level ESM because Meteor generates a
  CommonJS launcher below the app directory. Its React client provides the
  classic JSX runtime binding required by Meteor even though the standalone
  semantic checker uses automatic JSX.
- Workflows install all three npm workspaces before solution typechecking,
  enforce source inventory, build before execution, and run emitted browser
  tests. The Just gates mirror those contracts.

## Type declaration boundary

The two Meteor projects retain `skipLibCheck`. The installed Meteor declaration
bundle unconditionally references Blaze and jQuery DOM declarations even in
server-only projects. Disabling it either produces third-party missing-DOM
diagnostics or leaks DOM globals into server projects, weakening the more
important client/server separation. Application sources, local ambient
augmentations, and all owned declaration files remain fully checked; the task
package declaration now augments the upstream `PackageAPI` instead of
redeclaring its global namespace.

## Security and dependencies

The root production audit reports zero vulnerabilities. Both Meteor apps use
the current `meteor-node-stubs` 1.2.27, whose bundled `qs` dependency carries
one moderate denial-of-service advisory. `npm audit fix` cannot replace a
bundled dependency, and no newer `meteor-node-stubs` release exists. The app
does not call the affected `qs.stringify` comma-array option; replacement must
come from an upstream Meteor stub release rather than an incoherent lockfile
override.

## Recovery

Rollback is a code revert plus deletion of ignored `dist/`; there is no data
migration. A stale or absent build deliberately prevents CLI startup. The
pre-conversion branch remains recoverable by reverting the signed rollout
commits together because source and emitted-runtime path changes are one
integrated contract.

## Verification evidence

- Root solution and host typechecks completed with zero diagnostics; the root
  Node suite passed 597/597 after trust-boundary, lifecycle, readiness, and
  build-contract regression additions.
- Source inventory reported exactly four JavaScript hosts; clean build,
  manifest verification, missing/added/modified input probes, emitted helper
  syntax, launcher listing, and emitted Playwright discovery passed.
- Task full-app tests passed 2/2, local-package tests passed 12/12, production
  server build passed, and both real Chromium journeys passed against the
  Meteor fixture after exercising reactive and non-reactive task flows.
- Dashboard tests passed 16/16, strict typecheck and production server build
  passed, and Tailwind regeneration is byte-for-byte deterministic.
- Workflow YAML, shell syntax, Just contracts, output whitespace, and signed
  commit checks passed.
- The canonical smoke audit executed 87/87 required coordinates and retained
  its truthful `incomplete` status: 56 cases passed, 31 remained incomplete,
  all document/topology/profiler/network recovery attestations were true, and
  12/13 negative controls matched their exact expected reasons. Only
  `new_session_claimed_resumed` remains undetected because this profile has no
  authenticated DDP fixture, matching the pre-conversion baseline contract.
- Independent adversarial review found build-freshness, trust-boundary,
  workflow, launcher, Playwright, browser-runtime, collector-lifecycle, and
  DDP-readiness gaps; each finding was converted into a regression gate. The
  canonical audit additionally exposed and now guards owner-level teardown,
  fault-witness decoding, cancellation propagation, EJSON signed-zero
  normalization, declarative digest identity, and post-fault election health.
