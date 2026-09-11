# Phase 3A report: native-only distribution and documentation

Completed 2026-09-11 in `.worktrees/terra` on
`phase3/packaging-and-docs`, based on `3627729`. No push, merge, publish,
GitHub repository, or package version bump was performed.

## Scope-change result

The maintainer's scope change superseded the dormant npm plan. The repository
now has only native-archive distribution:

- Removed package `bin`, `files`, `publishConfig`, package build/prepack/
  publish scripts, `test:dist`, `tooling/release/test-dist.mjs`, tarball CI
  artifacts, and release-draft tarball selection/notes.
- Kept all dependencies as `workspace:*`. The private session store stays at
  `0.0.0`; it is not publishable and exposes its TypeScript source only to
  workspace consumers.
- Removed the Turbo `build` task and all build edges. InfoMentor now runs its
  existing tests through Bun, so its Node-externalized test output no longer
  requires the store's emitted JavaScript. Native `bun build --compile` bundles
  the source directly; the binary and installer acceptance suite proved both
  executables resolve the store and run outside the checkout.
- The unused `tsconfig.build.json` files remain untouched because the brief
  assigned only package manifests, docs, tooling, workflows, and root metadata
  to this worktree. No task invokes them, so `dist/` is no longer emitted or
  consumed by the supported workflow.

The default InfoMentor release tool list now contains seven read tools. Native
smokes verify seven without `--allow-setup-tools`; the setup/status/logout tools
remain opt-in server behavior.

## Documentation and review

- Added a root README with native curl installs, host configuration, development
  and release commands, layout, and session-security posture. Codex uses
  `config.toml`, rather than an `mcp.json`; this follows the linked official
  MCP documentation.
- Added root `docs/AGENTS.md`, reduced Abler's package guide to its requested
  pointer, and added a concise root `CLAUDE.md` (35 lines).
- Rewrote the owned release guides for native archives only, corrected review
  records, and removed retired Playwright and tarball ignores. The package
  README files were deliberately not changed: the brief assigns them to Luna,
  and their historical npm wording remains that owner's follow-up.
- Wrote the requested hostile, read-only
  [session-store review](session-store-review.md). Its high finding is the live
  stale-lock expiry window: a suspended/stalled holder can overwrite a newer
  rotating token before it receives `LOCK_LOST`. It also covers ignored refresh
  errors, hard-link aliasing, the handle-check boundary, missing owner and
  in-flight loss tests, and unverified Windows behavior.

## Acceptance

With `/private/tmp/family-mcp-phase1-runtime/node_modules/.bin` first on PATH
(Bun 1.4.2):

```text
bun install --frozen-lockfile                         no changes
bunx turbo run typecheck lint format:check test release:check --force
                                                      18 successful, 18 total
actionlint .github/workflows/*.yml                     passed
git diff --check                                       passed
```

```text
bunx turbo run test:binary test:installer --force     6 successful, 6 total
```

The native checks built macOS arm64 archives, ran Abler's six-tool and
InfoMentor's seven-tool standalone smokes, and exercised all installer cases.
Linux/x64, Windows, public release URLs, hosted Actions, WARP administration,
and live account activity were not run locally.
