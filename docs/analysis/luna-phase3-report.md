# Luna phase 3 report

Written 2026-09-12 in `.worktrees/luna` on `phase3/runtime-and-tests`, based on
`3627729`. This branch follows the scope change to use the curl installers and
native Bun binaries, and drops the `test:node` path.

## Changes

- Added private `@family-mcp/mcp-runtime` `0.0.0` with shared tool results,
  redaction, annotation presets, stdio shutdown handling, and package-version
  lookup. Both servers use it.
- Added strict Abler output schemas and validated `structuredContent` for all
  six tools. `list_groups` now strips unknown upstream fields.
- Converted InfoMentor tests to `bun test` with injected fetch, session-write,
  and browser-open seams. Added the requested loopback HTTP fixtures to both
  packages; they cover login/relay redirects, cookies, 429 integer/date forms,
  and oversized responses where each client supports them.
- Added the targeted Abler and InfoMentor tests from the phase brief and widened
  the two timing-sensitive lock tests.
- Completed stretch #23: a validated parent-page read now serves as the auth
  check, and collection consumes that fresh read once instead of fetching the
  same parent page again while the session lock is held.
- Removed the package-specific lint migration overrides and fixed the findings.
- Updated both package READMEs for Bun-only distribution, output schemas, test
  commands, and InfoMentor upgrade notes.

## Verification

Package test tallies under Bun 1.4.2:

| Package | Command | Result |
| --- | --- | ---: |
| `@family-mcp/mcp-runtime` | `bun test` | 2 passed |
| `abler-mcp` | `bun test` | 9 passed |
| `infomentor-mcp` | `bun test` | 18 passed |
| `@family-mcp/session-store` | `bun test` | 8 passed |

Each package also passed its TypeScript typecheck, type-aware Oxlint, and Oxfmt
format check. The exact repository acceptance command is:

```sh
bunx turbo run build typecheck lint format:check test --force
```

It passed with the global Bun 1.2.19 and with Bun 1.4.2 first on `PATH`.

## Lint debt

The inherited migration overrides reported the following findings before this
phase. After removing the overrides and fixing the source/tests, the scoped
type-aware lint command reports zero findings.

| Scope | Before | After |
| --- | ---: | ---: |
| `abler-mcp` | 214 | 0 |
| `infomentor-mcp` | 384 | 0 |

No live login, merge, or push was performed. No `abler-mcp` or `infomentor-mcp`
version was changed.
