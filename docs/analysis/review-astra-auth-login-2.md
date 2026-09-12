Reviewed `ec7f612bde8c36fe055fb236c877ee561f7a6a96..1f12065ec4eee890e536fdd96990f26b86d7bc7c`, restricted to `packages/abler-mcp`, using the requested `review-agent` skill. HEAD remained unchanged throughout. All nine changed files and the surrounding authentication, CLI, persistence, and release-test call paths were inspected.

**Re-verification of the original five findings**

| Original finding | Status | Current evidence |
| --- | --- | --- |
| P1: signal handlers removed before cleanup finishes | **FIXED** | Repeated the successful-capture probe with the fake browser ignoring `Browser.close` and delaying SIGTERM. Sent the first SIGINT only after browser SIGTERM began, followed by SIGTERM and another SIGINT to the login process. Login exited 1 with `Abler login cancelled.`; browser PID was dead and profile absent. Handlers now remain installed through profile removal (`src/browser-login.ts:936–937, 995–1002`). The committed repeated-signal test also passed. |
| P1: unrelated CDP server on a released port / port substitution | **PARTIAL** | The pinned runtime's ordinary path uses inherited pipes, and the original decoy fixture was never contacted. The old preallocated-and-released port is gone. However, the supported fallback still captured both cookies from a separate process that replaced the listener after successful readiness on the profile-owned browser WebSocket; login returned success. The profile file was not changed. See the remaining P1 below. |
| P1: launcher exits while browser child survives cleanup | **PARTIAL** | A cooperative launcher/child now closes correctly: exit 0, child dead, profile absent. Repeating the same topology with `ABLER_FAKE_IGNORE_BROWSER_CLOSE=1` yielded exit 0 and a returned cookie jar while the child remained alive and its profile was deleted. This uses the committed fixture's existing behavior switches. The new false-success mechanism is N1 below; termination still targets only the launcher PID (`src/browser-login.ts:843–860`). |
| P2: `--keep-browser` keeps the CLI alive | **FIXED** | Independent subprocess probe exited 0 while the fake browser and profile remained alive, using the port transport and printing the retention warning. The committed CLI test additionally verified/saved a synthetic session against loopback and observed CLI exit while the browser remained open. `browser.unref()` and debugging-socket closure are present at `src/browser-login.ts:979–980`. |
| P2: README's login command mismatches installed version | **FIXED** | Package manifest, installer default, package/root README pins, publishing guide, and changelog agree on 0.5.0. The rebuilt native executable printed `0.5.0` and advertised `auth login`; the real local archive installer test passed. The local 0.4.0 tag still lacks login, and the README now directs 0.4.0 users to capture/import. The release consistency checks passed. This is source/local-artifact verification; the 0.5.0 tag and hosted assets were not published or fetched. |

**[P1] Keep fallback cookie capture on the owned CDP channel — packages/abler-mcp/src/browser-login.ts:729**

This remains unresolved from original finding 2, rather than being counted as a new defect. Fallback readiness opens the browser WebSocket named in the private profile and validates `Browser.getVersion`, but cookie capture then discards that channel's identity and calls `captureCookies(httpUrl)`, which independently discovers `/json/list` and connects to a page WebSocket. An offline probe retained the original browser WebSocket, released only its listener, and bound a separate CDP process to the same port. Without touching `DevToolsActivePort`, login accepted both replacement-process cookies and returned successfully; cleanup's `Browser.close` still went to the original browser. Thus even successful readiness does not bind the cookies to that browser. Preserve that binding throughout capture and provide the private access boundary required by the original finding. A private profile file plus an unauthenticated loopback listener is not equivalent to the inherited pipe.

The substitution probe used Bun 1.4.2 and forced the existing fallback by throwing from the first pipe spawn. It ran without `keepBrowser`, so the result is not limited to the intentional retention option. The timing was controlled, not a measured probability of winning a race against real Chromium. No provider verification was performed with the substituted jar.

**NEW defects introduced by this delta**

**[P1] N1: Await the final liveness check before disposing of its CDP connection — packages/abler-mcp/src/browser-login.ts:878**

The final `return debuggingIsGone(...)` returns a promise without awaiting it inside the `try`; `finally` therefore runs while that check is pending. For pipes, `closeDebugging` destroys the local connection and marks it closed. If the launcher has already exited, the pending check now sees both conditions it interprets as browser death, even though the actual child ignored `Browser.close` and is still running. The offline launcher probe returned success with the child alive and profile deleted. A causal control loaded the same module with only this return changed to `return await` in memory: the same fixture then reported the cleanup error instead of success, while the child still survived. Awaiting the check prevents this false result; completing original finding 3 also requires reliable ownership and termination of the actual child. No source file was edited for the control.

**[P2] N2: Rediscover the page after its CDP session detaches — packages/abler-mcp/src/browser-login.ts:141**

The new pipe path caches the first attached page's `sessionId` for the entire login and never clears it on detachment or a missing-session error. If the user closes the initial sign-in tab and completes login in a new Abler tab in the same browser, polling continues against the dead target until timeout. An offline pipe fixture returned an empty first capture, emitted `Target.detachedFromTarget`, and exposed a replacement target with both cookies. The trace contained one `Target.getTargets`, one attachment, and three `Network.getCookies` calls to the old session; login timed out after five seconds. The pre-delta capture path rediscovers tabs on each attempt. Invalidate the cached attachment when its target/session disappears so a subsequent poll can find the replacement.

**[P2] N3: Do not treat a stale DevToolsActivePort file as proof of a live browser — packages/abler-mcp/src/browser-login.ts:436**

The new fallback shutdown check requires both removal of `DevToolsActivePort` and an unresponsive endpoint. A browser killed by the existing SIGKILL fallback cannot execute its file-removal handler, so a stale file keeps this check false even after the directly spawned browser is confirmed dead. An offline fallback fixture supplied both cookies, ignored CDP close and SIGTERM, and left the endpoint file behind when killed. After approximately 15.3 seconds, the browser was dead but login rejected with `A browser process may still be running; its temporary profile was removed.` instead of returning the captured session for verification. Use actual browser/process ownership and liveness evidence; a leftover discovery file cannot establish that a process survived. The committed fixture hides this case by explicitly removing the file on close and even before its delayed SIGTERM exit.

There are **three new findings: one P1 and two P2**. The fallback ownership boundary is a remaining original P1. N1 overlaps the original process-tree finding's symptom and is not an additional independent process-tree issue. No P0 or P3 finding was established.

**Assessment and tag verdict**

**Not ready to tag `abler-mcp@0.5.0`. Request changes.** The blocking P1 issues are fallback cookie provenance/access isolation and reliable browser-child cleanup, including N1's false success. N2 and N3 are additional demonstrated correctness defects to resolve before accepting this hardening change. Passing the current tests does not close these findings.

The delta does fix signal lifetime, intentional subprocess detachment, and version alignment, and it substantially expands offline CLI coverage. Its existing verify-then-commit persistence flow remains intact: browser cleanup precedes verification, failed verification preserves the previous session and retains a candidate, and success promotes the verified candidate. Documentation now correctly describes that ordering and separates readiness from cookie-wait timing. Its browser-closure claim remains too strong for the demonstrated launcher case.

**Validation**

Executed the exact requested gate from the repository root:

```sh
PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH \
  bunx turbo run test test:binary test:installer --filter=abler-mcp --force
```

Result under **Bun 1.4.2 (`744846f84`)**, Turbo 2.10.12:

- **24 tests passed, 0 failed, 167 expectations**, across three test files.
- **7 successful Turbo tasks**, 0 cache hits, **16.619 seconds**.
- Native `darwin-arm64` 0.5.0 archive built successfully.
- Standalone native MCP smoke passed: all six read tools, version/help, missing-authentication response, and clean protocol.
- Installer passed all 12 piped-installer cases, truncated-script handling, real archive installation, spaced prefix, reinstall, checksum rejection, preservation of an existing command, and installed-binary MCP smoke.

Also ran the read-only version/pin check:

```sh
PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH \
  bunx turbo run release:check --filter=abler-mcp --force
```

Both tasks passed, including root README pins and package installer/documentation pins at 0.5.0. No `release:sync` mutation was run.

The gate ran dependency typechecks; it did **not** run Abler's own typecheck, lint, or formatting check. Those are **not_run** in this review.

Additional subprocess probes imported the actual reviewed source and intercepted only browser spawning/timing to use real offline child processes. The N1 causal control additionally used an explicitly identified in-memory module substitution. Each probe used its own isolated `TMPDIR`, so the new sweeper could not inspect or delete existing user login profiles. Fixtures contained only synthetic cookies; no saved user session or live Abler/Google service was accessed. Probe-owned child processes and temporary directories were cleaned up afterward.

| Independent probe | Observed result |
| --- | --- |
| First signal during successful-capture cleanup, followed by repeated SIGTERM/SIGINT | Login exit 1/cancelled; browser dead; profile absent; decoy untouched. |
| Cooperative launcher with separate browser child | Login exit 0; captured both cookie names; child dead; profile absent. |
| Same launcher with child ignoring `Browser.close` | Login exit 0; captured both cookie names; child alive; profile absent. |
| Same ignoring child, N1 in-memory `return await` control | Login exit 1/cleanup error; child alive; profile absent. Confirms false-success cause, not a complete cleanup fix. |
| `keepBrowser: true` | Login exit 0 while browser/profile remain; port transport; retention warning. |
| Fallback port replaced after owned readiness | Login exit 0; both returned cookies came from the substitute PID; original browser received `Browser.close`. |
| Pipe target replaced after first empty poll | Exit 1 after 5.167 seconds; only one discovery/attachment; all three cookie requests used the old session. |
| Fallback SIGKILL with stale endpoint file | Exit 1/cleanup error after 15.302 seconds; browser PID confirmed dead. |
| Rebuilt native binary, partial-cookie login | Native `auth login --timeout 1` used pipes, exited 1 with the expected timeout, closed the browser, and removed its profile. No verification request was reachable. |

For reproducibility, the launcher probes used the checked-in `test/fake-browser.ts` with `ABLER_FAKE_ID_TOKEN=1`, `ABLER_FAKE_EMPTY_POLLS=0`, and `ABLER_FAKE_LAUNCHER=1`; the failing variant adds `ABLER_FAKE_IGNORE_BROWSER_CLOSE=1`. A Bun subprocess called `loginInBrowser({ browser: process.execPath, timeoutSeconds: 4 })`; its spawn interceptor forwarded the supplied stdio descriptors and browser arguments to that fixture under the pinned Bun executable. The supervising process checked the fixture's recorded child PID and profile after the login process exited. For the signal probe, launcher mode was disabled and `ABLER_FAKE_DELAY_SIGTERM=1` was added; the supervisor waited for the fixture's SIGTERM marker before sending cancellation.

For the substitution probe, an owned offline server wrote its own endpoint file and answered browser-WebSocket readiness. Before the first HTTP liveness request, the harness stopped that server's listener while retaining its existing browser WebSocket, started a separate CDP process on the identical port, then resumed login. The substitute served tab discovery and cookie capture. This distinguishes actual port substitution from merely leaving a decoy on an unrelated port.

**Test gaps and residual risks**

The committed coverage establishes ordinary private capture, cooperative launcher shutdown, CLI verification/save, partial-cookie timeout, failed-verification candidate retention, repeated signals with SIGKILL, startup errors, retained-browser exit, and basic old-profile sweeping. Those are meaningful improvements.

It does not cover N1's combination of launcher exit and an uncooperative child, target/session replacement, stale endpoint files after forced shutdown, or substitution between fallback readiness and cookie capture. In the pinned run, ordinary login tests take the pipe path; the fallback is exercised by the retained-browser test, which deliberately bypasses shutdown. The fake port browser's unconditional endpoint-file removal also conceals N3. Add targeted regressions for these demonstrated paths.

Successful login's prior explicit checks for session mode 0600, exactly two saved cookie names, and absence of token values in stdout were removed from this test during refactoring (`test/browser-login.test.ts:354–371`). Shared storage/import behavior remains covered elsewhere, but these login-specific assertions no longer guard that CLI path. This is a coverage gap, not a demonstrated disclosure regression.

Real Chromium-family behavior and interactive provider sign-in are **not_run**. The native partial-cookie probe exercises compiled startup/capture/cleanup, while successful native login with provider verification remains **not_run**. No cross-user attack, hosted CI, hosted release asset, or non-macOS binary was tested. In particular, the port-file finding is established with forced process death; this report does not assume whether every Chromium build removes that file on a cooperative exit.

The new abandoned-profile sweep has only fixture-level evidence for age, endpoint, and SingletonLock behavior. Cross-platform live-browser detection, concurrent sweeps, interrupted removal, and filesystem errors remain unproven. Its PID-reuse limitation can retain a stale profile, as the source explicitly notes. Hard kills, crashes, and power loss can still leave credential-bearing profiles until a later successful sweep; intentional `--keep-browser` retention remains an explicit exception.

The working tree was initially clean and source remained unchanged during all checks. This report is the only authored repository file; generated ignored build/test artifacts came from the authorized validation commands. No commit, tag, push, publication, or code fix was made.

