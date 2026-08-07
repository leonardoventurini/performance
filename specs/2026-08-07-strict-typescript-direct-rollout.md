# Strict TypeScript Direct Rollout

## Status

Proposed for direct implementation on `feat/reliability`.

## Goal and scope

Convert every maintained implementation, test, CLI, collector, reliability
component, dashboard module, task-fixture module, and legacy Node helper to
strict TypeScript in one integrated rollout. Preserve the existing benchmark,
audit, dashboard, result, workflow, and application behavior.

The repository currently contains 203 maintained JavaScript, JSX, or CommonJS
files and one TypeScript file. The conversion covers all three execution
contexts:

- the Node 24 ESM benchmark harness, CLI, tests, collectors, Artillery
  processors, Playwright journeys, and legacy Node helpers;
- the Meteor 3.5 task fixture, its React client, local packages, monitors, and
  tests;
- the Meteor 3.4 Blaze dashboard, its server control plane, client modules,
  shared contracts, and tests.

JSON case definitions, YAML Artillery scenarios, HTML templates, CSS, shell
scripts, and package manifests remain in their native data or host formats.
Generated JavaScript under `dist/` and the dashboard build directory is not
source and remains ignored.

“Strict TypeScript” means that all maintained application logic is authored as
`.ts`, `.tsx`, or `.cts`, every maintained source and test is included in a
strict compiler project, and no implementation diagnostic is suppressed.
Consumed `@ts-expect-error` is limited to dedicated negative type fixtures. It
does not mean
renaming host files that their framework requires to be JavaScript. The only
tracked JavaScript source exceptions are:

- `bench.js`, the stable checked-JavaScript compatibility launcher;
- `apps/tasks-3.x/packages/bench-monitors/package.js`, a Meteor package
  descriptor;
- `apps/tasks-3.x/packages/tasks-common/package.js`, a Meteor package
  descriptor;
- `apps/dashboard/rspack.config.js`, a configuration loaded by Node before
  Meteor compilation.

Those four files are small host adapters, contain no domain behavior, and are
included in a strict `checkJs` project with explicit host declarations. Any
other tracked `.js` or `.jsx` file fails the source-inventory gate.

## Non-goals

- Do not change benchmark loads, audit cases, capability claims, metric names,
  result schemas, dashboard persistence, or user-visible behavior.
- Do not introduce a runtime TypeScript loader, Babel path alias, dual source
  tree, committed compilation output, incremental strictness mode, or feature
  flag.
- Do not replace runtime validation with static types. Files, JSON, EJSON, DDP,
  MongoDB, process output, environment variables, and network responses remain
  untrusted at runtime.
- Do not convert shell, JSON, YAML, HTML, or CSS into TypeScript wrappers.
- Do not opportunistically upgrade Meteor, React, Blaze, MongoDB, Artillery,
  Playwright, or the public result contract.

## Evidence and uncertainty

The root is Node 24 ESM and currently executes `node bench.js`, direct
`node --test`, seven spawned collector programs, a spawned fanout program,
Artillery YAML processors, and a CommonJS GC preload. Workflows, the justfile,
documentation, tests, and the dashboard control plane all depend on these
paths. Node-native type stripping or a runtime loader would not govern every
child and third-party loader consistently.

Both Meteor applications already carry the Meteor `typescript` build package,
but neither has a strict no-emit compiler gate or npm type dependencies. Local
Meteor `package.js` descriptors are evaluated by a special host and cannot be
ordinary TypeScript modules. The dashboard Rspack configuration is likewise
loaded before Meteor transpilation.

The main uncertainty is loader compatibility, not syntax conversion. The
highest-risk hosts are Artillery processors, the `--require` GC preload,
Meteor local-package main modules, the dashboard control-plane launcher, and
private Meteor instrumentation hooks. Before bulk renaming, executable probes
must confirm the chosen emitted paths and host adapters. A failed probe changes
the adapter design, not the strictness target or the direct-rollout model.

Risk is high: this migration crosses process, serialization, database,
distributed-audit, application, test, and release-workflow boundaries. A
type-correct behavioral regression could invalidate benchmark or conformance
evidence.

## Architecture decision

### Compiler projects

Use a shared `tsconfig.base.json` for policy and separate projects for
incompatible runtime contexts:

- `tsconfig.json` references the root Node, host-JavaScript, task, and dashboard
  projects and is the repository-wide `typecheck:all` authority after all three
  independent npm installations. `typecheck:node` checks only the root and host
  projects after a root-only install.
- `tsconfig.node.json` compiles the root Node sources and tests with
  `module`/`moduleResolution: NodeNext`, `rootDir: .`, and `outDir: dist`.
- `tsconfig.hosts.json` strictly checks the four JavaScript host files with
  `allowJs`, `checkJs`, and `noEmit`; no migrated implementation enters this
  project.
- each Meteor app has a shared app base plus separate client, server, shared,
  package, and test project references where their DOM, Node, React, Blaze,
  Mocha, Tinytest, and Meteor globals differ.

Each file has one emit owner. Root Node files emit only through
`tsconfig.node.json`; Meteor application implementation files are compiled only
by Meteor. App-local client, server, package, and test projects are no-emit
semantic gates over their owned files. Shared Meteor files have one declared
owner plus two additional no-emit portability checks—one with client libraries
and one with server libraries—so cross-context checking does not create a
second emitted artifact.

All projects enable at least:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "useUnknownInCatchVariables": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noImplicitReturns": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true,
  "forceConsistentCasingInFileNames": true,
  "resolveJsonModule": true
}
```

Production code may not contain explicit or implicit `any`, non-null
assertions, `@ts-ignore`, `@ts-nocheck`, or unsafe double assertions. Dedicated
negative type fixtures may use `@ts-expect-error` only when the following line
must be rejected and the compiler proves that expectation is consumed.

### Build and execution

Compile root TypeScript to a clean, ignored `dist/` and execute emitted
JavaScript. Do not use `tsx`, `ts-node`, or Node type stripping in production,
tests, collectors, Artillery, dashboard launches, or workflows.

`bench.js` remains the stable public command and contains only a checked,
shell-free launcher for `dist/bench.js`. It validates the build manifest,
dynamically imports the emitted module in the same process, and calls its typed
`main({ argv, env, repositoryRoot })` export. Keeping execution in-process
preserves stdin/stdout/stderr, signals, process-group identity, and exact exit
semantics required by dashboard cancellation. It fails with an actionable
message when output is absent or stale.

`npm run build` deletes only the validated repository `dist/` directory,
compiles the Node project, and copies runtime assets while preserving their
relative topology. Its versioned canonical manifest hashes relative paths and
contents for every compiled source, tsconfig, package manifest, lockfile,
build script, host adapter, declaration, JSON/YAML runtime asset, and copied
fixture that is a transitive input to the emitted root runtime. Meteor-only app
sources and app lockfiles are excluded unless the root build copies or consumes
them. The launcher validates the manifest schema and complete transitive input
set, so modification, addition, deletion, or build-policy drift cannot execute
stale output without making unrelated dashboard edits invalidate the root CLI.

The emitted tree contains:

- the CLI, config, runners, drivers, reporters, collectors, reliability
  runtime, and root libraries;
- emitted root tests, Playwright tests, Artillery processors, fanout program,
  and legacy Node helpers;
- `gc-monitor.cjs`, emitted from `collectors/gc-monitor.cts` for Node
  `--require` compatibility;
- copied declarative JSON definitions, Artillery YAML, and any fixtures read at
  runtime.

Source ESM imports use `.js` specifiers under NodeNext so emitted imports
resolve without rewriting. Runtime paths are never derived accidentally from
the source or `dist` directory. A typed repository-layout module resolves the
repository root once from the launcher contract and exposes explicit source,
asset, output, application, collector, and emitted-program paths. This replaces
ad hoc `import.meta.dirname` assumptions in config, drivers, collectors,
catalog loading, and audit execution.

Artillery always receives emitted `.js` processors. Playwright discovers
emitted `.spec.js` tests from a compiled config or runs its TypeScript config
against an explicit emitted test directory. Legacy shell scripts invoke
emitted helper JavaScript through one path resolver. The dashboard validates
and spawns the stable `bench.js` launcher; its tests prove the launcher and
fresh build fingerprint are present.

### Type contract graph

Define shared types before converting implementations:

- `BenchmarkConfig`, `AppDefinition`, and a discriminated `ScenarioDefinition`
  union keyed by driver;
- parsed CLI option and subcommand unions, typed environment readers, and
  exact handler input/result contracts;
- `MeteorSource`, child-process lifecycle/result unions, collector capability
  interfaces, and a typed replacement for the mutable `_io` test seam;
- `BenchmarkResult`, `RuntimeMetadata`, and a closed metric union that keeps
  absence distinct from a measured zero;
- separate recursive `JsonValue`, wire-safe `EjsonValue`, and database
  `BsonValue` types. The BSON union preserves `Date`, `ObjectId`, `Binary`
  subtype, and typed-array semantics without implying those values are valid
  on an EJSON/DDP wire;
- discriminated DDP inbound/outbound frame unions and guarded WebSocket raw
  data normalization;
- exact declarative audit unions for values, steps, queries, mutations,
  transitions, oracles, evidence, plans, artifacts, journals, coordinates,
  statuses, restoration, and negative controls;
- typed MongoDB documents and collections for benchmark runs, baselines,
  audit executions/events, tasks, and reliability documents;
- typed Meteor method/publication inputs and outputs, React component props,
  Blaze template data/helper/event/instance state, and instrumentation adapter
  interfaces.

Every public function, class, interface, type, and constant receives TSDoc
describing the durable contract or reason. Runtime validators accept `unknown`
and return a typed value or throw. `JSON.parse`, EJSON parsing, DDP frames,
journal lines, collector files, result files, settings, method arguments, and
external responses never flow into domain logic without validation.

Private Meteor APIs are isolated behind narrow structural adapters. Capability
guards verify each patched method, session, socket, observer, or multiplexer
shape before use and retain typed restoration handles. Ambient declarations
describe only stable module surfaces; blanket `declare module` declarations
returning `any` are forbidden.

### Dependencies and declarations

Use npm to add TypeScript and exact declaration packages to the owning
workspace and update every lockfile. Add `ejson` as a direct root runtime
dependency because the DDP client imports it; transitive hoisting through
`simpleddp` is not an execution contract. Expected declarations include Node,
React, React DOM, Mocha, Meteor, WebSocket, jQuery, and pidusage. Verify that
the selected Meteor declarations model Meteor 3 asynchronous collection APIs;
augment narrowly in app-local declaration files where they do not.

Create narrow local declarations for packages without trustworthy metadata,
including `simpleddp` or EJSON adapters, based only on methods actually used.
Meteor virtual modules and local packages receive explicit declarations.
HTML side-effect imports receive a non-value `*.html` declaration.
Compile-time API fixtures and runtime smokes must verify installed constructor
options, events/callback payloads, and promise results for every local shim;
the declarations themselves are not accepted as evidence.

## Correctness invariants

- After each independent npm workspace is installed from its lockfile, a clean
  checkout can typecheck all projects, build, test, and execute without a
  globally installed TypeScript runtime loader.
- Every maintained source and test has exactly one emitting/owning project; the
  source-inventory test rejects omissions and unexpected JavaScript. Shared
  Meteor modules additionally enter client- and server-context no-emit
  portability projects, which are excluded from the single emit-owner rule.
- The root Node build never emits Meteor application sources; Meteor owns app
  compilation after the app-local strict no-emit gates pass.
- The public `node bench.js` command and all documented CLI arguments retain
  their behavior and exit semantics.
- Emitted subprocesses, collectors, Artillery processors, the GC preload, and
  legacy helpers are resolved from the current build and cannot fall back to
  source JavaScript or stale output.
- Runtime data remains validated independently of TypeScript. No cast may
  convert untrusted input into a trusted domain type.
- Benchmark result keys, audit schemas, immutable contract/compiled-plan and
  deterministic content digests, capability decisions, dashboard storage,
  MongoDB scope, and cleanup semantics remain byte- and behavior-compatible
  unless an existing canonical serializer already permits irrelevant key
  ordering. Generated identity-derived artifacts self-validate and meet the
  normalized parity contract.
- Browser code cannot import server-only APIs, and server code cannot depend
  on DOM globals. Shared Meteor modules typecheck in both contexts.
- Private Meteor instrumentation fails closed when its guarded capability is
  absent and always restores patched functions.
- The conversion leaves no duplicate JavaScript implementation and no checked
  source importing from `dist/`.

## Risks, abort conditions, and recovery

- If a framework host cannot load emitted output through the four named host
  files, stop and revise this specification with evidence. Do not silently
  expand the allowlist or add a general runtime transpiler.
- If a private Meteor hook cannot be represented by a narrow guarded
  interface, stop that conversion and redesign the boundary. Do not use `any`
  or globally widen Meteor declarations.
- If compilation changes an immutable contract/schema/compiled-plan digest, a
  deterministic content digest, result schema, process lifecycle, cleanup
  behavior, or benchmark load, stop and resolve the semantic difference before
  rollout. Identity-derived artifacts may change only when each self-validates
  and normalized parity remains intact.
- If a compiler project excludes maintained source/tests, a declaration hides
  errors with `any`, or emitted files can become stale, the migration is not
  complete.
- If root, Meteor, Artillery, Playwright, dashboard-control, collector, or live
  audit parity cannot be established, revert the integrated migration commits
  and remove ignored `dist/`. No data rollback is needed because this rollout
  has no persistence migration.

## Verification gauntlet

All checks below are hard gates.

### Static contract sensitivity

- After installing all three workspaces, run `npm run typecheck:all` from the
  root; it builds every project reference and must report zero diagnostics.
- Run a source-inventory test that fails for untracked compiler inputs, an
  unexpected `.js`/`.jsx`, a source import from `dist`, forbidden suppression,
  non-null assertion, unsafe double assertion, or explicit `any`.
- Add compile-only negative fixtures for invalid scenario/metric/audit/DDP
  discriminants, unsafe optional access, client/server imports, and malformed
  Mongo ownership identifiers. Removing the expected compiler error must fail
  the fixture.
- Mutation-test representative runtime guards by bypassing one JSON, DDP, BSON,
  and result validation step; the corresponding unit or integration test must
  fail.

### Clean build and runtime loading

```sh
npm ci
(cd apps/tasks-3.x && meteor npm ci)
(cd apps/dashboard && meteor npm ci)
npm run clean
npm run build
npm run typecheck:node
npm run typecheck:all
npm test
node bench.js list
npx playwright test --list
```

Run the built CLI and an emitted collector from a temporary working directory
outside the repository. Load both Artillery processor families and the fanout
program without starting a remote workload. Inject the emitted GC CommonJS
module into a local Node child and prove it writes the expected bounded metric.
Delete one emitted asset and alter one source after build; the asset/build
integrity checks must reject both states.

### Application and integration parity

```sh
(cd apps/tasks-3.x && meteor npm ci && meteor npm run typecheck && meteor npm test)
(cd apps/dashboard && meteor npm ci && meteor npm run typecheck && meteor npm test)
for file in scripts/*.sh; do bash -n "$file"; done
just dashboard-css-check
```

Build both Meteor applications to temporary output directories to exercise
production compilation and local-package resolution. Run both Playwright
journeys against the task fixture because the shared Artillery/browser helper
is converted. Exercise one bounded benchmark through result generation and
comparison. Run representative collector lifecycle integration tests and the
dashboard audit-control access, launch, cancellation, artifact-correlation,
and cleanup tests.

Finally run the declarative smoke audit against the same preflighted local
Meteor release used by the baseline. Compare exact immutable contract,
catalog, case-definition, and compiled-plan digests; validate every generated
artifact against its own digest; and require the same coordinate set, status,
normalized failure-reason categories, capability decisions, negative-control
outcomes, deterministic payload/content snapshot digests, and restoration
booleans. Exclude run/attempt/case-execution identities, timestamps, durations,
host/process identities, evidence digests derived from those values, and the
expected harness revision change. TypeScript must not turn an existing
truthful `incomplete` result into either a pass or a different failure.

### Workflow and final review

Update all GitHub workflows, the justfile, package scripts, README, repository
guidance, dashboard preflight, and test assertions atomically. Validate every
workflow command against a clean build. Obtain independent reviews focused on:

- untrusted-boundary validation and result/audit compatibility;
- Meteor private-hook typing and restoration;
- loader/path/build freshness across child processes and third-party tools.

The final diff must contain no generated `dist/`, Meteor local output, results,
logs, credentials, or unrelated workspace changes.

## Direct-rollout execution checklist

- [ ] Capture the pre-conversion root, application, Playwright, collector,
  dashboard-control, benchmark-result, and declarative-audit evidence; verify:
  existing repository gates and a preflighted smoke artifact; done when parity
  inputs, normalized outcomes, and only the deterministic contract/plan/content
  digests are recorded.
- [ ] Add TypeScript dependencies, shared strict policy, project references,
  host declarations, type-test harness, source-inventory gate, clean build,
  asset copier, and build fingerprint; verify: negative configuration and stale
  output tests fail for their intended reasons.
- [ ] Define the shared config, CLI, process, metric, result, JSON/EJSON/BSON,
  DDP, MongoDB, and declarative-audit type graph before implementation changes;
  verify: compile-only positive and negative contract fixtures.
- [ ] Convert root libraries, config, CLI, reporters, runners, drivers,
  collectors, reliability runtime, and their unit tests to NodeNext TypeScript;
  verify: zero diagnostics and all converted root tests pass from `dist/`.
- [ ] Convert the GC preload to `.cts`, Playwright journeys to `.ts`, Artillery
  processors and fanout to emitted TypeScript programs, and legacy helpers to
  `.cts`/`.ts`; verify: independent loader probes and subprocess lifecycle
  tests use only current emitted output.
- [ ] Convert the task app, React client, shared task package, monitor package,
  private Meteor adapters, and tests; update Meteor main-module declarations;
  verify: strict app projects, package resolution, Meteor tests, production
  build, and both Playwright journeys.
- [ ] Convert the dashboard shared contracts, typed collections, Blaze client,
  server control plane, and tests; retain and strictly check only its host
  config; verify: strict app projects, Meteor tests, production build, CSS
  identity, and audit-control integration.
- [ ] Switch package scripts, just recipes, workflows, Artillery YAML,
  dashboard preflight, and documentation to the stable build contract in the
  same rollout; verify: a clean checkout cannot execute stale or missing output.
- [ ] Run the complete static, unit, integration, browser, application,
  benchmark, and declarative-audit gauntlet; compare canonical artifacts and
  recovery evidence to the baseline; fix every discrepancy before proceeding.
- [ ] Perform the three independent adversarial reviews, resolve every P0/P1,
  record the shipped compiler/runtime decision under `decisions/`, inspect the
  clean final diff, and commit the integrated direct rollout with signed
  semantic commits.

## Acceptance criteria

The conversion is complete only when:

1. all maintained implementation and test logic is TypeScript, with only the
   four named, strictly checked JavaScript host files remaining;
2. every source and test belongs to an explicit strict compiler project and
   all projects report zero diagnostics;
3. no `any`, non-null assertion, unsafe double assertion, general declaration
   shim, or diagnostic suppression exists in production or test
   implementations; only consumed `@ts-expect-error` directives inside the
   dedicated compile-negative fixture directory are permitted;
4. clean deterministic emission supplies every CLI, child process, collector,
   Artillery, Playwright, GC, dashboard, and legacy-helper runtime;
5. untrusted runtime boundaries validate `unknown` into exact types and retain
   their negative tests;
6. root tests, both Meteor suites/builds, Playwright journeys, loader probes,
   dashboard-control tests, representative benchmark flow, and declarative
   smoke audit satisfy their baseline contracts;
7. public CLI commands, result/metric paths, audit schemas, immutable
   contract/compiled-plan and deterministic content digests, dashboard
   persistence, benchmark loads, process cleanup, and restoration evidence are
   unchanged; generated artifacts self-validate and meet normalized parity;
8. CI and the justfile install each workspace before `typecheck:all`, then
   build before execution, and stale or absent output fails closed;
9. generated artifacts remain ignored and the repository contains no parallel
   JavaScript implementation;
10. the direct rollout is documented in a durable decision after verification.
