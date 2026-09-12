No findings.

**Verdict: Ready to tag `abler-mcp@0.5.0` within this review's scope.** The pipe-only change removes both the remaining fallback ownership defect and the CDP-reported PID termination defect. No NEW actionable regression was established. The required local gate passed. This verdict does not claim successful interactive provider login, hosted CI, or cross-platform release testing.

Reviewed `706a8225e421c72b577f0aa2a9ee8692a263ee91..b3951ba74ce0fb851d16b68b207c6d54aeaf4745`, restricted to `packages/abler-mcp`, using the requested `review-agent` skill. Inspected the complete seven-file diff, browser lifecycle, CLI callers, cookie filtering and verification/storage, fixtures, previous review reports, and release task definitions. The checkout began clean and HEAD remained unchanged. This report is the only authored repository file; no code changes or commits were made.

**Requested verification**

| Item | Result | Evidence at reviewed HEAD |
| --- | --- | --- |
| No TCP debugging path in `auth login` | **PASS** | `spawnBrowser` always supplies `--remote-debugging-pipe` and `stdio: ['ignore', 'ignore', 'ignore', 'socket-fd', 'socket-fd']` (`src/browser-login.ts:619–647`). The only `node:net` connections wrap inherited descriptors (`113–115`); the `port: 0` argument does not create a TCP endpoint in the exercised Bun runtime. No login HTTP discovery, WebSocket, debugging-port flag, or endpoint-file reader remains. Independent probes observed no TCP sockets for the login/fixture PIDs with `lsof`, no fetch/WebSocket calls, and zero requests to an available loopback decoy. |
| Termination ownership | **PASS** | Destructive signals target only `-browser.pid` or `browser.kill(signal)` (`567–585`), using the subprocess returned by `Bun.spawn`. The SingletonLock PID is used only for signal-0 liveness checks during sweeping (`409–424`). `SystemInfo.getProcessInfo` and its PID parser/caller are removed. |
| Before-readiness substitution | **CLOSED / original transport no longer applicable** | Rejecting the pipe spawn produced exactly one spawn attempt, exit 1, and the capture/import/`--browser` recovery message; there was no port retry. A separate real-subprocess fixture placed a valid decoy `DevToolsActivePort` file before readiness and returned invalid pipe readiness. Even with `keepBrowser: true`, login exited 1 in **0.465 s**, terminated its own process group, removed the profile, and never contacted the decoy. The old listener-handoff probe has no login TCP listener/address to substitute. |
| PID spoof | **CLOSED** | An independent pipe fixture included a separate supervisor-owned sentinel PID in the version response and an unsolicited process-info message, and could answer a process-info request. No such request occurred. After the fixture ignored `Browser.close`, login signaled only its spawned group, returned the owned synthetic cookies, and left the unrelated sentinel alive (**5.511 s**). |
| N1: exited launcher, escaped child ignores close | **PASS: fails closed** | The committed real-subprocess regression passed: exit 1 with the cleanup error, no verified-session success, profile absent, escaped child still alive until test cleanup (`test/browser-login.test.ts:797–832`). The final peer/liveness check remains awaited before local disposal (`src/browser-login.ts:613–615`). This does not claim termination of a child that escaped the owned group. Cooperative launcher success and timeout cleanup also passed. |
| N2: replaced/detached target | **PASS** | The committed detach-event test passed. An independent missing-session probe omitted the event: the old session returned `-32001`, login rediscovered and reattached to the replacement, captured both cookies, and removed the profile with the browser dead (**4.520 s**). Trace showed two discoveries and two attachments. |
| N3: stale endpoint file after SIGKILL | **PASS / port dependency removed** | An independent pipe fixture left a decoy endpoint file in its profile and ignored both `Browser.close` and SIGTERM. The file still existed when SIGTERM arrived. Login escalated to SIGKILL, returned the captured jar with exit 0, and removed the profile (**10.506 s**). Both destructive signals targeted the spawned group; the decoy received zero requests. |
| Repeated signals through cleanup | **PASS** | The committed delayed-SIGTERM/SIGKILL regression passed. Signal handlers remain installed through profile removal (`src/browser-login.ts:719–726`). |
| `--keep-browser` | **PASS, with real-browser scope below** | Committed CLI verification/save and exit passed while the pipe fixture/profile remained alive. An independent fixture returned in **0.407 s** with no destructive signals. An additional offline real Chromium probe through the unchanged `loginInBrowser` function completed its deliberate one-second cookie timeout, emitted the retention warning, let the owning Bun process exit, and left the Chromium process/profile alive one second later. |
| Abandoned-profile sweep | **PASS for committed coverage** | The age/live-lock regression passed: remove the old abandoned profile; preserve the recent profile and the old profile whose SingletonLock names a live PID. Sweeping no longer performs endpoint HTTP probes. |
| Successful-login assertions | **PASS** | The executed CLI test still checks profile mode 0700, session mode 0600, exactly `id_token` and `refreshToken`, verified replacement values, and absence of captured/verified token values in stdout (`test/browser-login.test.ts:345–368`). Verification is observed after browser/profile cleanup. |
| README / CHANGELOG | **PASS** | The changed text accurately describes pipe-only login, removal of the port fallback, recovery alternatives, and the retention exception. Pipe disposal occurs during cleanup, before verification, so it is already closed by CLI exit. Package/root README, installer, publishing reference, manifest, changelog, and local native artifact agree on 0.5.0. |

The TCP statement is scoped to `auth login`. The separate, explicitly selected `auth capture` command intentionally still uses loopback HTTP/WebSocket CDP (`src/cli.ts:126–127`, `src/auth.ts:197–308`); login neither calls it nor falls back to it.

**Validation**

Executed from the repository root under **Bun 1.4.2 (`744846f84`)**, **Node v24.12.0**, and **Turbo 2.10.12**:

```sh
bunx turbo run test test:binary test:installer --filter=abler-mcp --force
```

- **27 tests passed, 0 failed, 184 expectations**, across three files.
- **7/7 Turbo tasks successful**, zero cache hits, **30.763 s**.
- Built the **0.5.0 darwin-arm64** native archive with the pinned Bun runtime.
- Standalone native MCP smoke passed: six tools, version/help, missing authentication, and clean protocol.
- Installer passed all 12 piped cases, truncated-script handling, real archive installation, spaced prefix, reinstall, checksum rejection, existing-command preservation, and installed-binary MCP smoke.

Additional read-only checks:

```sh
bunx turbo run typecheck lint format:check release:check --filter=abler-mcp --force
git --no-pager diff --no-ext-diff --no-textconv --check 706a822..HEAD -- packages/abler-mcp
rg -n 'remote-debugging|DevToolsActivePort|SystemInfo|getProcessInfo|WebSocket|createConnection|connect\(' packages/abler-mcp/src
```

All **9/9** additional Turbo tasks passed, zero cache hits, **466 ms**. Abler's own typecheck, lint, formatting and release pins passed; diff whitespace check passed.

**Independent evidence and limits**

The six synthetic probes ran inline via `bun run -`, importing the unchanged reviewed source and substituting only browser spawning with real disposable pipe subprocesses. They asserted the supplied argv, descriptors, detached option, single spawn attempt, signal targets, result, process liveness, profile removal/retention, and sentinel survival. They blocked login fetch/WebSocket use and offered a real loopback decoy. TCP sampling used:

```sh
/usr/sbin/lsof -nP -a -p <login-pid>,<fixture-pid> -iTCP
```

No matching sockets were observed. Fixture browser PIDs for the five spawned cases were **56347, 56358, 56421, 56475, and 56605**; only the last intentionally remained alive before supervisor cleanup. No synthetic cookie values were included in the reported output.

The real-browser check used the locally installed **Chrome for Testing 151.0.7922.34**, revision `782af9cb30a53f54487e5d2e44738645a8ec457c`, with a new temporary profile and `about:blank` replacing the Abler URL. It ran headlessly under an outer macOS sandbox denying outbound IP networking; `--no-sandbox` disabled Chromium's incompatible nested sandbox only in this probe. Earlier attempts failed because of the workspace/nested sandbox, and were not counted as product failures or retention evidence.

A direct transport control received `Browser.getVersion`, observed Chromium alive before closing both inherited pipe sockets, then observed it alive 2.5 seconds afterward without sending `Browser.close` (PID **60993**). The unchanged-function control then exercised the actual keep branch (PID **62210**): expected cookie timeout, retention warning, owning process exit, browser alive and profile present. That harness deliberately caught the expected timeout, so its outer exit 0 is a harness result, not successful authentication. These checks prove bounded headless transport/retention behavior; they do not prove a visible browser window or successful real-provider capture.

Every probe isolated `TMPDIR`, so sweeping could touch only probe-created profiles. Probe-owned processes and temporary directories were cleaned up. No user browser profile, saved session, live Abler/Google service, credentials, or external messages were used. Ignored native/test artifacts came from the authorized gates.

Interactive provider sign-in, successful real-browser cookie capture and verification, headed Chrome/Brave/Edge behavior, real-browser sweep behavior across supported platforms, Linux/non-macOS native artifacts, hosted CI, and hosted release assets are **not_run**. The existing SingletonLock PID-reuse limitation can preserve a stale profile; hard termination can leave profiles until a later sweep. These are coverage/residual limits, not newly demonstrated defects.

No tag, version bump, push, publication, or merge was performed.

