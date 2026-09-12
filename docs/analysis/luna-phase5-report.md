# Luna Phase 5B report

Implementation commits on phase5/luna:

- 6c257b7 — harden MCP error output and Abler shutdown
- d90d468 — enforce InfoMentor login deadlines and cooldown cap
- 06f9bce — make the session-store sweep test deterministic

## Findings and fixes

1. **Phase 3B P1 — MCP error leakage.** mcp-runtime now returns a fixed message for unknown errors and a fixed message for Zod errors; only SafeError messages pass through. InfoMentorError uses that safe type. Abler API and auth failures with reviewed messages now use SafeError, and status-specific or arbitrary upstream exception text is not returned. The test `packages/mcp-runtime/test/index.test.ts` verifies that bearer and refresh tokens, Set-Cookie text, and a response body without a URL all produce the fixed error output.

2. **Phase 3B P2 — Abler shutdown.** startStdio awaits its shutdown hook before closing the MCP handle. AblerClient shares a lifecycle AbortSignal with every fetch and session-lock wait, tracks active operations, and drains them on close. The `SIGTERM aborts an in-flight Abler fetch and releases its session lock` test in `packages/abler-mcp/test/integration.test.ts` injects an abort-aware pending fetch and verifies prompt process exit, lock release, and no temporary session file.

3. **Astra P2 — login deadline.** InfoMentor login starts its deadline before acquiring the session lock and carries the combined signal through authentication, account checks, and the session write. Deadline expiry maps to LOGIN_TIMEOUT. The `login timeout includes session-lock contention and makes no HTTP request` test in `packages/infomentor-mcp/test/integration.test.ts` uses a 1 ms deadline, verifies rejection in under one second, confirms no HTTP request occurred, and checks that the saved session remains intact.

4. **Astra P2 — excessive Retry-After.** InfoMentor caps rateLimitedUntil at one hour before serializing it. The `an oversized Retry-After is capped with rotated cookies and honoured by another client` test in `packages/infomentor-mcp/test/integration.test.ts` sends Retry-After: 9999999999999, then verifies RATE_LIMITED, the capped persisted cooldown and cookie, and that a second client honors the pause without another upstream request.

5. **Astra test gaps.** In `packages/infomentor-mcp/test/integration.test.ts`, the setup-cancellation test comment now accurately says cancellation is triggered from the final parent-read callback and that the test does not instrument the session-store adapter’s rename check; the test still verifies the previous session is preserved and no temporary file remains. The `all six Abler tools complete MCP round trips with optional and null upstream fields` test in `packages/abler-mcp/test/integration.test.ts` calls every tool through the SDK’s output schemas using nullable and optional upstream fields.

6. **Deterministic temp-sweep test.** The `sweeping removes only old temporaries that belong to the target` test in `packages/session-store/test/files.test.ts` now gives the fresh temporary a known-old mtime before testing the zero-age sweep threshold, avoiding filesystem timestamp-boundary flakiness.

## README implications

No README files were changed, as required. The Abler README already says authentication errors omit original causes and MCP never returns tokens; fixed generic output is consistent with that guidance. The InfoMentor README’s 1–3600 second login timeout and shared saved rate-limit pause remain accurate; the timeout now also covers lock contention and commit. The README does not state the new one-hour ceiling, which can be documented when README edits are in scope.

## Validation

- Global Bun 1.2.19: `bunx turbo run typecheck lint format:check test --force` — 20/20 Turbo tasks passed; 46 tests passed across Abler (11), InfoMentor (20), session-store (13), mcp-runtime (1), and release-tooling (1).
- Pinned Bun 1.4.2: `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run typecheck lint format:check test --force` — 20/20 Turbo tasks passed; the same 46 tests passed.
- Pinned Bun 1.4.2: `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test:binary test:installer --force` — 6/6 Turbo tasks passed. Both standalone binaries passed MCP smoke checks (six Abler tools and seven InfoMentor tools); each installer passed 12 piped cases, truncation checks, and archive-install checks.
- `git diff --check` passed. No live login, deployment, or push was performed.

The worktree started from c64760a. Local main has since advanced four commits; this branch was left isolated and was not rebased or merged.
