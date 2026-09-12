# Fix-delta re-review

Reviewed `git diff c64760a..4317ddef6e136667b8097b2d6e2279f947c4e971` on `main`, on 2026-09-12. Read the full brief, `docs/AGENTS.md`, `CLAUDE.md`, both earlier reviews, and the complete delta; applied the `review-agent` skill directly without delegation. All verification was offline, using synthetic data, injected fetches, or loopback fixtures.

## Verification of the nine claimed fixes

| Claimed fix | Status | Evidence at reviewed HEAD |
| --- | --- | --- |
| 1. Shared-source Turbo cache keys | **FIXED** | `turbo.json:11` adds `^typecheck` edges to `test`, `lint`, and `typecheck`. Independently archived this exact HEAD, ran `turbo run test typecheck lint --dry=json`, and changed each shared entrypoint separately, restoring it between probes. All six server task hashes changed for **each** of `packages/mcp-runtime/src/index.ts` and `packages/session-store/src/index.ts`. The graph includes both shared typechecks for every server quality task. The new regression at `tooling/release/release.test.mjs:191` also passed. |
| 2. Login deadline before lock acquisition | **FIXED** | `packages/infomentor-mcp/src/login.ts:179` creates the deadline before the lock; the same deadline reaches authentication, and the combined signal reaches the session write. Repeated the earlier contention probe with a 50 ms timeout: `LOGIN_TIMEOUT` arrived after **51 ms**, with **zero HTTP requests**, the competing holder still owning the lock, and the prior session byte-for-byte unchanged. Releasing the holder left only the original session and synthetic credentials file. The new contention regression passed on both Bun versions. |
| 3. Cooldown bound before serialization | **PARTIAL** | `packages/infomentor-mcp/src/login.ts:211` prevents the original `Invalid Date` failure. Independently supplied `Retry-After: 9999999999999` and a rotated synthetic cookie: the result was `RATE_LIMITED`, the cookie persisted, the saved pause was exactly 3,600,000 ms, and another client made no request. However, the original client retains the oversized in-memory deadline and re-arms the saved pause after its initial expiry; see finding 1. |
| 4. Root README privacy wording | **FIXED** | `README.md:151` limits the non-disclosure promise to credentials and authentication secrets; `README.md:155` explicitly says requested family data reaches the MCP host and identifies children, schedules, messages, and notifications. This matches successful MCP output at `packages/mcp-runtime/src/index.ts:27` and the successful six-tool Abler round-trip test. |
| 5. Removed README development commands | **FIXED** | `packages/abler-mcp/README.md:207` and `packages/infomentor-mcp/README.md:427` now use supported `check`, `test`, `test:binary`, and `test:installer` commands. Neither package README retains `test:dist` or the removed `turbo run build` command. Independent dry runs resolved the documented task sets for both packages, and the required source/native checks passed. |
| 6. Unsupported InfoMentor library import | **FIXED** | The entire public TypeScript API example, package-name import, and SDK library-compatibility promise have been removed. The development section at `packages/infomentor-mcp/README.md:420` describes standalone executable consumption. No replacement npm/library distribution was introduced. |
| 7. Root README version synchronization | **PARTIAL** | `tooling/release/sync-version.mjs:25` now includes the root README. In an archived copy, changing Abler to `0.3.2` and running its synchronization updated its root pin, preserved InfoMentor's `0.5.0` pin, and passed `--check`. The committed regression also passes. However, both package tasks now read and rewrite that shared file without coordination, so a normal unfiltered Turbo synchronization can undo the update; see finding 2. |
| 8. Phase 3B P1: safe MCP errors | **FIXED** | `packages/mcp-runtime/src/index.ts:32` returns fixed text for unknown and Zod errors, allowing only `SafeError` messages through. Abler's unrestricted `onUnknownError` callback is gone, and `InfoMentorError` extends `SafeError`. Inspected the safe-error construction paths and independently sent four unknown-error cases through an actual in-memory Abler MCP `auth_status` round trip: synthetic bearer, refresh-token, cookie-header, and URL-free body text all produced only the fixed generic error. The shared test additionally verifies safe-message preservation and Zod handling. |
| 9. Phase 3B P2: SIGTERM cancellation and lock release | **FIXED** | `packages/abler-mcp/src/cli.ts:60` connects the shutdown hook; `packages/abler-mcp/src/api.ts:187` tracks active operations and passes its lifecycle signal into locking, and `api.ts:210` merges that signal into every API fetch. `mcp-runtime/src/index.ts:79` awaits cancellation/draining before closing the handle. Re-ran the subprocess SIGTERM test on Bun 1.2.19 and 1.4.2: it observes an in-flight fetch and held lock before signaling, then asserts exit within one second, no remaining lock, and no temporary session artifacts. Both passed. |

## New findings

### [P2] Keep the capped cooldown deadline fixed across retries — packages/infomentor-mcp/src/login.ts:212

The new serialization clamp uses a fresh `now + MAX_RATE_LIMIT_MS` on every save, while `InfoMentorHttp` retains the original oversized deadline (`http.ts:153`) and `InfoMentorClient.saveActive()` retains that same HTTP instance. A rejected read still saves it in `client.ts:175`. Consequently, a retry by the originating MCP process can advance the shared file's deadline without receiving another 429. In an offline probe, after the initial one-hour pause I advanced the clock by 3,600,001 ms and retried the same client: it made **no new HTTP request**, returned `RATE_LIMITED`, and replaced the expired saved deadline with another full hour. Repeated retries can keep other clients paused too. Clamp the live deadline once when accepting the rate-limit response, then persist that stable value. The original serialization exception is fixed; the new moving persisted deadline is the remaining defect.

### [P2] Coordinate the package tasks that rewrite the root README — tooling/release/sync-version.mjs:67

Both `release:sync` tasks now read the shared root README and later write their entire independently transformed copy, including when a package's own pin is already current. Turbo runs these tasks concurrently, so one successful task can restore the other's stale pin. In an archived checkout with **only Abler bumped to 0.3.2**, `turbo run release:sync --force` exited successfully on all five attempts but left the root Abler pin at **0.3.1 on two attempts**. Direct concurrent synchronizations with both package versions bumped lost one update in **11/12 attempts**; both processes exited zero, and the affected package's subsequent `--check` failed. Serialize the shared-file updates or give one task responsibility for updating all root pins, and exercise the concurrent Turbo path in the regression.

## Assessment

**Seven claimed fixes are complete; two are partial.** The original contention, unsafe error-output, documentation, and cache-invalidation reproductions are resolved. The oversized cooldown and single-package root-pin probes also pass their original failure cases, but follow-up probes demonstrate the two defects above. No additional P0, P1, or P3 finding was established in the delta.

Source checks and local native acceptance now pass. The remaining failures are behavior outside the new regressions: expiration on the originating client, and concurrent package synchronization. Passing the forced suite and current-version release checks does not cover either scenario.

## Validation

| Command or check | Result |
| --- | --- |
| `bunx turbo run typecheck lint format:check test --force` | **PASS:** 20/20 Turbo tasks, zero cached. Default Bun **1.2.19**, Node **24.12.0**, Turbo **2.10.12**. Test totals: mcp-runtime 1, session-store 13, Abler 11, InfoMentor 20, release tooling 2; **47 total**. |
| `PATH=${TMPDIR}/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test:binary test:installer --force` | **PASS:** 6/6 tasks, zero cached, Bun **1.4.2**. Both packages were freshly compiled for **darwin-arm64**. Both standalone MCP smokes passed version/help, tool enumeration, missing authentication, and clean protocol. Both installers passed their 12-case piped matrix, truncation check, real archive installation, spaced prefix, reinstall, checksum rejection, previous-command preservation, and installed-executable MCP smoke. |
| `PATH=${TMPDIR}/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test release:check --force` | **PASS:** 10/10 tasks, zero cached. All 47 tests passed with the pinned Bun runtime; both current-version release checks passed. This command also runs dependency typechecks. |
| Independent shared-source cache probe | **PASS:** twelve changed-hash assertions: two independently edited shared entrypoints × six consumer quality tasks. |
| Independent 50 ms contended-login probe | **PASS:** timeout after 51 ms, zero requests, unchanged saved session, clean waiter cleanup. |
| Independent MCP unknown-error probes | **PASS:** four SDK round trips returned only the fixed generic message. |
| Independent oversized-cooldown probe | Initial persistence and second-client suppression **PASS**; original-client expiry **FAIL**, with another hour persisted without another HTTP response. |
| Independent version-bump probes | Selected-package synchronization **PASS**; concurrent root Turbo synchronization **FAIL** in 2/5 single-bump attempts; direct concurrent synchronization **FAIL** in 11/12 two-bump attempts. |
| Package README command dry runs | **PASS:** `check`, `test`, and `test:binary test:installer` resolved for both packages. |
| `git diff --check c64760a..HEAD` | **PASS**. |

The cache/version probes used temporary archives of the exact reviewed commit. Authentication probes used only synthetic private files and injected responses. Temporary probe directories were removed. No live service, actual parent account, public release download, deployment, or administrator action was used. No source or configuration was changed, and no commit was created; this report is the only intentional repository edit. The requested checks regenerated their normal ignored build/cache artifacts.

## Test gaps

- The oversized-header regression at `packages/infomentor-mcp/test/integration.test.ts:1236` checks initial persistence and an immediate second client. It does not advance time, retry the original client, or assert that the persisted deadline stays fixed and eventually permits requests.
- The version regression invokes one package's synchronizer at a time. It does not run both tasks through Turbo against the same root README, including when only one package's version changed.
- The corrected setup-cancellation comment now accurately describes cancellation from the final parent-read callback. It still does not instrument the InfoMentor adapter at the storage rename boundary. The separate session-store commit-abort regression passes; the adapter-specific gap remains.
- The successful six-tool Abler schema round trips close the earlier synthetic success-path coverage gap. SIGTERM coverage uses a source subprocess and an abort-aware injected fetch; native smoke tests do not exercise an authenticated in-flight shutdown, stalled response body, or SIGINT/EOF separately.

## Residual risks

- Native evidence covers this Mac's darwin-arm64 build only. Hosted CI, macOS x64, Linux arm64/x64, public artifacts, and host-specific MCP compatibility were not verified.
- Upstream authentication, real optional/null response shapes, actual account renewal, and challenge flows remain unverified against live Abler or InfoMentor. Synthetic fixture success is not live-provider acceptance.
- `SafeError` is an explicit trust boundary: its safety depends on keeping its messages reviewed and free of arbitrary upstream text. The current inspected call paths satisfy that rule; the class does not sanitize future messages automatically.
- Existing host-local coordination limits still apply: independently copied session files and other machines do not share these locks. This delta review does not claim a fresh audit of unrelated storage or authentication behavior.
