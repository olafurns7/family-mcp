**[P1] NEW: Verify process ownership before signaling a CDP-reported PID — packages/abler-mcp/src/browser-login.ts:1016–1018**

The port fallback takes `SystemInfo.getProcessInfo` from an unauthenticated endpoint, accepts any positive browser PID (`browserProcessId`, lines 802–815), and sends SIGTERM/SIGKILL to it without establishing that it belongs to the launched browser. If a different process replaces the listener before the first readiness connection, it can nominate an unrelated process that the CLI user can signal. An independent offline probe supplied the PID of a separate, supervisor-owned sentinel in its own process group. Login terminated that sentinel with **SIGTERM**, then exited **0** with the substitute's synthetic cookies and no profile left. The sentinel was neither the launcher nor its descendant. This OS-level effect is introduced by this delta: `c08c237` signals only the subprocess returned by `Bun.spawn` and does not request a PID through CDP. Establish ownership independently before allowing a network response to select a process to terminate; an inherited private transport or verified OS ownership must precede this operation.

**[P1] REMAINING: Establish ownership before accepting fallback readiness — packages/abler-mcp/src/browser-login.ts:742–751**

Keeping capture on the readiness WebSocket fixes replacement **after** readiness, but `debugging.owned = true` still follows only a syntactically valid `Browser.getVersion` response. A private `DevToolsActivePort` file identifies an address, not the current process serving that address. An independent probe let the owned fixture write the file, released its listener, and bound a separate process to the same port before login connected. The substitute never modified or read the private file. Readiness, target discovery, capture, and `Browser.close` all reached the substitute; login returned both substitute cookie names with exit **0** after terminating the original fixture. This is the unresolved original ownership/access-boundary finding, **not a second new defect**. The new PID-signaling consequence above shares this prerequisite but introduces a distinct destructive operation.

**Verdict: Do not tag `abler-mcp@0.5.0`. Request changes.** The named post-readiness race and N1–N3 regressions are repaired, and all local gates pass. The original fallback ownership boundary remains incomplete, and the new unverified-PID termination is a demonstrated P1 regression. There is **one NEW P1 finding** and **one remaining original P1**; no other new actionable defect was established in the five-file delta.

Reviewed `c08c237ba375eb44d51a2d33452b81830fd15be3..34713f79c72577039ceb90c7a6275129ee4e04f9`, restricted to `packages/abler-mcp`, using the requested `review-agent` skill. Inspected the complete diff, surrounding browser lifecycle, authentication filtering/storage, CLI verification/save flow, fixtures, and release task definitions. HEAD remained unchanged. This is a read-only review; this report is the only authored repository file.

**Requested re-verification**

| Item | Status | Evidence at reviewed HEAD |
| --- | --- | --- |
| Original P1: fallback provenance, listener replaced after readiness | **FIXED for the exact after-readiness probe; PARTIAL for the original finding overall** | A real second process acquired the released listener while the existing browser WebSocket remained open. Login returned the owned fixture's two cookies, exit 0, in **0.272 s**. The substitute received only `/json/version` liveness traffic, no target/cookie commands or `/json/list`. All CDP capture commands and `Browser.close` stayed on the original socket (`capturePortCookies`, lines 821–856). The before-readiness control above still returned substitute cookies, exit 0, in **5.200 s**. |
| N1: launcher exits, child ignores `Browser.close` | **FIXED** | Independent escaped-child fixtures withheld their PID and ignored `Browser.close`. Both **pipe and port** login processes exited **1** with the cleanup error, removed the profile, and returned no jar: **10.087 s** and **10.178 s**. The child remained alive until supervisor cleanup, exactly the failure condition the brief requires reporting. `closeBrowser` now awaits the final check before local disposal (line 1063); liveness uses process/group evidence and peer closure (lines 960–978). |
| N2: target replaced after first empty poll | **FIXED** | With `Target.detachedFromTarget`, the trace showed two discoveries and attachments, followed by a cookie request to the replacement session; exit 0 in **2.219 s**. A second probe omitted the event and returned the missing-session error on the old session; rediscovery still succeeded, exit 0 in **4.206 s**. The reset paths are lines 202–208 and 316–320. Both browsers were dead and profiles absent. |
| N3: stale `DevToolsActivePort` after SIGKILL | **FIXED** | An independent port fixture ignored both `Browser.close` and SIGTERM and never removed the endpoint file itself. The supervisor observed that file when SIGTERM arrived. Login escalated to SIGKILL, returned the captured jar with exit 0 in **10.300 s**, and removed the profile. The fixture PID was dead. The shutdown check no longer requires discovery-file deletion as proof of exit (lines 969–978). |
| Restored successful-login assertions | **FIXED** | The committed CLI test now checks session mode **0600**, exactly `id_token` and `refreshToken`, and absence of both captured and verified synthetic token values in stdout (`test/browser-login.test.ts:362–373`). These assertions executed and passed in the required gate; verification/save uses the existing private-candidate flow. |

The N1 status concerns the brief's explicit fail-with-profile-removed requirement. It does **not** mean every detached process can be killed. A control that exposed the actual detached child PID did terminate that child via SIGTERM and returned the owned jar, exit 0 in **5.208 s**, with profile absent. An escaped child whose PID is unavailable remains a documented cleanup failure; it no longer produces false success. The committed cooperative-launcher test also passed.

**Validation**

Executed exactly from the repository root, using global **Bun 1.4.2 (`744846f84`)** and **Turbo 2.10.12**:

```sh
bunx turbo run test test:binary test:installer --filter=abler-mcp --force
```

- **28 tests passed, 0 failed, 197 expectations**, across three files; **7/7 Turbo tasks successful**, 0 cache hits, **40.051 s**.
- Built the native **0.5.0 darwin-arm64** archive with Bun 1.4.2.
- Standalone executable smoke passed: six read tools, version/help, missing authentication, and clean MCP protocol.
- Installer passed all 12 piped cases, truncated-script handling, real archive installation, spaced prefix, reinstall, checksum rejection, preservation of an existing command, and installed-binary MCP smoke.

Also closed the prior report's package-check gap and verified the release pins without synchronizing or bumping versions:

```sh
bunx turbo run typecheck lint format:check release:check --filter=abler-mcp --force
git --no-pager diff --no-ext-diff --check c08c237..HEAD -- packages/abler-mcp
```

All **9/9 Turbo tasks passed**, 0 cache hits, **480 ms**; the Abler typecheck, lint, formatting, installer/documentation pins, and root checks passed. Diff whitespace check passed. No further test rerun was needed because no source changed.

The required gate also passed the existing repeated-signal cleanup, retained-browser CLI exit, partial-cookie timeout with previous-session preservation, verification-failure candidate retention, startup failures, and abandoned-profile sweep tests. Those are local synthetic tests, not new live-browser proof.

**Independent probe evidence and reproduction**

The temporary harness is `/private/tmp/astra-auth-login-3-X2w2vs/probes.ts`; each named case has `result.json` and `trace.jsonl` beneath that directory. It can be rerun while the scratch directory remains available:

```sh
bun /private/tmp/astra-auth-login-3-X2w2vs/probes.ts
bun /private/tmp/astra-auth-login-3-X2w2vs/probes.ts --before-ready
bun /private/tmp/astra-auth-login-3-X2w2vs/probes.ts --pid-spoof
```

The first command passed seven independent cases. The last two passed their assertions that the remaining/new defects reproduce; their exit 0 is **not** product acceptance.

All probes imported the actual reviewed source. They intercepted browser spawning to forward the actual argv/stdio/detached options into real offline subprocesses; port probes forced the existing fallback by rejecting the first pipe spawn. Each login had an isolated `TMPDIR`, preventing the sweeper from touching existing login profiles, and blocked non-loopback fetches. No real cookies, user session, live Abler/Google service, or interactive browser was used. The independent jar-return probes stop before provider verification; the committed CLI tests supply separate loopback verification/save evidence.

The after-readiness handoff used `Bun.Server.stop(false)` to release the original listener while retaining its established WebSocket. A separate process then bound the identical port before the `SystemInfo.getProcessInfo` response released login into cookie polling. The substitute was stopped when the original fixture received `Browser.close`, isolating cookie provenance from the separate conservative HTTP-liveness behavior. Recorded original/substitute PIDs were **80580/80583**. Only the original PID handled `Target.getTargets`, `Target.attachToTarget`, `Network.getCookies`, and `Browser.close`.

The before-readiness control held the spawn interceptor's return until the listener handoff completed; this controls scheduling without changing login source. The original fixture wrote `DevToolsActivePort` once, then released the listener; the substitute did not access that file. Recorded PIDs were **83964/83965**. Every CDP request reached **83965**, and the returned jar's `fromOwned` assertion was **false**. The CLI later sent SIGTERM to **83964** during cleanup. This demonstrates acceptance of the wrong server, not a measured likelihood of winning a race against Chromium.

For the NEW PID probe, original browser **85776** and substitute **85777** used the same handoff. The substitute reported **85773**, a separate sentinel started by the supervisor with `detached: true`. After login returned success in **5.200 s**, the supervisor observed `aliveAfterLogin: false` and `signalCode: "SIGTERM"` for that sentinel. Only disposable probe-owned processes were targeted. All probe-owned browser, substitute, launcher, and sentinel processes were cleaned up; runtime profile directories were removed. Scratch scripts and synthetic traces remain for review.

**Limits and remaining coverage**

The committed substitution test changes `/json/list` responses inside one mock server; it does not replace a listening process. It now correctly guards against returning to HTTP tab discovery, and the independent handoff supplies the stronger after-readiness evidence. Neither it nor the other committed tests covers wrong-owner readiness or an unrelated process ID in `SystemInfo.getProcessInfo`.

The supported fallback still exposes an unauthenticated loopback debugging listener. Retaining one WebSocket prevents a later HTTP discovery response from redirecting capture; it does not establish initial owner identity or exclusive access. No cross-user experiment was run. The demonstrated failure requires a controlled local listener substitution; it is not a remote-network exploit or evidence that ordinary Chromium returns a false PID. The new PID finding is supported by the real subprocess signal result, not merely by that residual access concern.

Real Chromium-family startup/shutdown and interactive provider sign-in are **not_run**. Successful native browser login with provider verification, Linux/non-macOS binaries, hosted CI, tagging, and hosted release assets are **not_run**. The native smoke validates the built CLI/MCP/installer, not a real browser login. Hard crashes and intentional `--keep-browser` retention retain their documented limits.

No code fix, commit, tag, push, publication, or external message was made. Generated ignored artifacts came from the authorized local gates. The release verdict is based on the demonstrated remaining/new P1 defects, independently of these unrun environments.
