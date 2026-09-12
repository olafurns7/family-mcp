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

## Phase 4 fixes

- **Item 0 — native binary startup:** Both servers now statically import their
  own `package.json` and pass its name/version to `McpServer`. The runtime's
  filesystem-based package-version lookup is removed. The pinned binary smoke
  tests prove both standalone servers start and report their versions.
- **High — live owner expiry:** Removed `staleMs` and the owner-mtime refresh
  loop. Live PIDs remain busy regardless of owner-file age; dead PIDs still
  recover. Tests: `waiters poll for a busy lock and a live PID never expires by
  age` (mtime set ten minutes back) and `locks exclude live owners, recover dead
  owners safely, and release only their own token` (dead owner plus concurrent
  recovery).
- **Medium — owner refresh failures:** The refresh loop and `utimes` call no
  longer exist, so the refresh-error path is moot and has no separate test.
- **Medium — hard links:** Both `readPrivateFile` and `withFileLock` reject
  multi-link files with `UNSAFE_FILE`. Tests: `rejects hard-linked session
  files` and `rejects hard-linked session targets before running work`.
- **Low — file mutation during reads:** The open handle is re-statted after the
  read and its inode, size, and mtime are compared. The
  `detects inode, size, and modification-time changes between read stats` test
  covers each comparison; the private-file readback test covers the unchanged
  path.
- **Low — foreign owner:** `rejects files owned by another user` mocks
  `process.getuid()` and verifies `UNSAFE_FILE`.
- **Low — in-flight `LOCK_LOST`:** `reports in-flight lock loss without
  deleting the replacement owner` replaces ownership while work is held, then
  checks the error after work completes and verifies the replacement remains.
- **Windows:** Existing platform branches remain. The session-store and
  InfoMentor READMEs state that Windows is unsupported and unverified; Windows
  was not tested.

## Phase 4 verification

The final acceptance command passed with both Bun versions:

```sh
bunx turbo run typecheck lint format:check test --force
PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run typecheck lint format:check test --force
```

Each run completed with 20/20 Turbo tasks. The required pinned native checks
also passed:

```sh
PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test:binary test:installer --force
```

All six binary and installer tasks passed under Bun 1.4.2.
