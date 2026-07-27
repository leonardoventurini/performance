# Integrate redesign/v2-blaze-tailwind

## Context

The `italojs:redesign/v2-blaze-tailwind` branch replaces the original
Meteor 2-versus-3 harness with a Node 24 benchmark CLI, a single Meteor 3
fixture, app-local monitoring packages, expanded metrics, automated benchmark
workflows, and a Blaze/Tailwind results dashboard.

The current branch also contained a repository-specific `AGENTS.md` and an
intentional local deletion of `.envrc`. The incoming branch modified `.envrc`
and did not contain the guidance file.

## Decision

Merge the redesign history into `main` without rewriting branch history.
Resolve the sole merge conflict by keeping `.envrc` deleted, retain
`AGENTS.md`, and rewrite that guidance against the merged architecture.

The modern supported workflow is `node bench.js`; the shell scripts remain
documented as legacy operations tools. The new result JSON shape and metric
paths are treated as contracts shared by the harness, tests, and dashboard.

## Consequences

- The repository no longer maintains the Meteor 2 fixture or checked-in
  historical benchmark logs.
- Node 24 and npm become the root development baseline.
- Benchmark changes must preserve CLI, result-schema, instrumentation, and
  dashboard compatibility together.
- Dependency locks were refreshed within declared version ranges after the
  integration exposed security advisories. Breaking `npm audit fix --force`
  remedies are rejected until the Artillery/OpenTelemetry and Rspack upgrade
  contracts can be validated deliberately.
- Dashboard data mutations and benchmark execution require explicit
  operational intent because they reset local state or change external data.
- `.envrc` remains absent; checkout selection is supplied through flags,
  environment variables, or repository configuration without committed
  machine paths.

## Rejected alternatives

- Resetting `main` directly to the fork tip would have discarded the committed
  guidance and hidden the integration history.
- Keeping the old AGENTS guidance would have directed agents toward deleted
  apps, packages, benchmark artifacts, and a superseded Node version.
- Restoring the incoming `.envrc` would have reintroduced a local shell helper
  that the user explicitly chose to remove.
