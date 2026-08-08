# Add a Just command surface

## Context

The redesigned repository has three npm workspaces, a Node benchmark CLI,
Meteor application commands, generated Tailwind output, Playwright discovery,
and several legacy shell utilities. The authoritative commands were spread
across manifests and guidance, making routine verification easy to run
incompletely or from the wrong directory.

## Decision

Add a root `justfile` as a thin, typed-by-convention command surface over the
existing npm, Meteor, Playwright, Tailwind, and benchmark CLI contracts.

The default and routine recipes are read-only or local-development oriented.
Benchmark recipes require an explicit scenario or expose their default, while
release and checkout variants make the Meteor source visible in the command.
External dashboard mutations, deployment, legacy remote monitoring, and
cleanup commands are intentionally omitted because convenience aliases would
weaken the repository's target-resolution safeguards.

After `just install`, `check` remains credential-free and does not require a
running Meteor server or implicit package downloads.
`check-all` adds both Meteor application suites and therefore requires the
Meteor CLI. Browser execution similarly requires an already-running task app;
the recipe accepts its exact URL.

## Consequences

- `just` becomes the preferred discoverable entry point for routine local
  commands, while underlying commands remain directly usable and authoritative.
- Lockfile installation does not download Chromium automatically; browser
  installation remains an explicit environment setup concern.
- Tailwind reproducibility is checked through a temporary file, so validation
  cannot silently rewrite the tracked CSS.
- Destructive or external operations continue to require their explicit
  low-level commands and repository safety review.
