# Terra phase 6 report

## Delivered

- Moved root README pin ownership to the single `//#release:sync:root` Turbo task.
  Package synchronizers update only their own generated files; the root task derives
  both install URLs from the package manifests. `release:check` now verifies that
  root output first, and the root `bun run release:sync` command runs both package
  tasks through that graph.
- Added tracked-files-only scratch copies, a root-README cache-key assertion for
  both package `release:check` tasks, and a Turbo concurrency regression that bumps
  Abler alone and then both package versions without losing either pin.
- Added `family/safe-error-literal-message`, limiting `SafeError` and
  `InfoMentorError` messages to string literals or expression-free templates.
- Updated release, layout, rate-limit, session-replacement, and Abler test-count
  documentation.

## Luna-owned source findings

The new required rule reports these existing non-literal `InfoMentorError`
messages. Per the brief, no package source was edited:

- `packages/infomentor-mcp/src/client.ts:344`
- `packages/infomentor-mcp/src/http.ts:173`
- `packages/infomentor-mcp/src/http.ts:195`
- `packages/infomentor-mcp/src/http.ts:223`
- `packages/infomentor-mcp/src/http.ts:289`
- `packages/infomentor-mcp/src/http.ts:319`
- `packages/infomentor-mcp/src/collection.ts:457`
- `packages/infomentor-mcp/src/session.ts:293`

The four `LOGIN_REQUIRED` constant sites and the static conditional at `http.ts:195`
are safe by construction but intentionally violate the requested literal-only rule;
the remaining three interpolate existing error text.

## Validation

- PASS: `node --experimental-strip-types --test tooling/oxlint-anti-slop/rules/safe-error-literal-message.test.ts`
- PASS: `node --test tooling/release/release.test.mjs` (three regressions).
- PASS: `bun run release:sync`; `bunx turbo run release:check --force`.
- PASS: `bun run format:root:check`; `actionlint`; `git diff --check`.
- BLOCKED: `bunx turbo run typecheck lint format:check test release:check --force`
  reaches the eight required Luna-owned lint errors above. Turbo cancels the
  concurrently running release test after that failure; its standalone run passes.
