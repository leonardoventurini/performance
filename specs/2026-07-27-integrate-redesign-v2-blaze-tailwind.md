# Integrate redesign/v2-blaze-tailwind

## Goal and scope

Integrate `italojs:redesign/v2-blaze-tailwind` into the current `main` branch
as one direct rollout. Preserve the committed root `AGENTS.md` and the local
deletion of `.envrc`. Accept the redesign branch's repository architecture,
including its benchmark CLI, dashboard, monitoring packages, workflows, and
removal of obsolete fixtures and historical artifacts. Do not push.

## Evidence and uncertainty

- The fetched target is `47e69ea938ebe4447811032311e2e0acff63db82`.
- The common ancestor is `131e39e5b07e6c48e83e42a9caf923a79f46e07f`.
- The target changes 232 paths and replaces the original dual-app harness with
  a CLI-driven benchmark system and Blaze/Tailwind dashboard.
- `.envrc` and `.gitignore` overlap local uncommitted work. The user explicitly
  chose to keep `.envrc` deleted, keep `AGENTS.md`, and otherwise apply the
  redesign.
- The main uncertainty is whether the target branch is internally green in
  this environment after its large dependency and architecture change.

Stop if integration reveals conflicts beyond `.envrc` or if verification
requires production credentials, destructive remote state, or a scope choice
not represented by the target branch.

## Contracts and decisions

- Merge the target history rather than rewriting or force-moving `main`.
- Preserve all target files except `.envrc`, which remains absent.
- Keep `AGENTS.md`, then rewrite it against the merged repository rather than
  retaining obsolete Meteor 2/3 guidance.
- Treat target tests and workflow definitions as safeguards; do not weaken or
  rebaseline them to obtain a passing run.

## Risks and recovery

- Integration conflict → incomplete target state. Detect with
  `git diff --name-only --diff-filter=U`; abort the merge if conflicts exceed
  the agreed `.envrc` resolution.
- Lost local intent → `.envrc` reappears or `AGENTS.md` disappears. Detect with
  path assertions after the merge; recover from the pre-merge commits.
- Dependency or test regression → target architecture is not runnable. Detect
  with lockfile installation and the repository's unit/static checks; diagnose
  rather than changing test thresholds.
- Production side effect → remote benchmark, push, Galaxy, or deployment runs.
  Prevent by limiting verification to local, non-destructive commands.

## Verification gauntlet

- Hard gate: target ancestry. `git merge-base --is-ancestor
  refs/remotes/italojs/redesign/v2-blaze-tailwind HEAD` must succeed.
- Hard gate: preservation. `test ! -e .envrc && test -f AGENTS.md` must succeed.
- Hard gate: clean integration. `git diff --name-only --diff-filter=U` must
  produce no paths.
- Hard gate: dependency and unit contracts. Run the scripts declared by the
  merged root `package.json` after `npm ci`; all blocking checks must pass.
- Hard gate: guidance accuracy. Cross-check commands and architecture in
  `AGENTS.md` against `package.json`, `README.md`, `scripts/SCRIPTS.md`, app
  manifests, workflows, and structural searches.
- Diagnostic: locally inspect the dashboard when its required runtime can be
  started without credentials.

The conflict-list gate is sensitive by construction: it reports `.envrc`
during the merge until that explicit resolution is staged.

## Execution checklist

- [ ] Preserve the chosen local state — files: `.envrc`, `.gitignore`, this
  spec; verify: `git status --short`; done when `.envrc` is committed deleted
  and `.gitignore` no longer carries the superseded local edit.
- [ ] Merge the redesign — verify: ancestry and unmerged-path gates; done when
  target history is integrated, `.envrc` is absent, and `AGENTS.md` remains.
- [ ] Remap architecture and rewrite guidance — file: `AGENTS.md`; verify
  against repository manifests, docs, workflows, and syntax-aware searches.
- [ ] Validate locally — verify with lockfile install, repository unit/static
  commands, and safe dashboard inspection where available.
- [ ] Review and commit — independently challenge preservation and command
  accuracy, stage only task-owned paths, and create semantic signed commits.

## Verification and rollout

The rollout is the current branch merge plus refreshed guidance. No push or
remote deployment is included. Recovery before push is a normal revert of the
integration and documentation commits; do not use destructive history
rewrites when a revert preserves auditability.
