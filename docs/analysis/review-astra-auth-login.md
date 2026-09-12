**[P1] Keep cancellation handlers installed until cleanup finishes — packages/abler-mcp/src/browser-login.ts:269**

The `finally` block removes both signal handlers before awaiting browser shutdown and profile removal. A first Ctrl-C/SIGTERM during successful-login or timeout cleanup, or a second signal after cancellation, therefore terminates the CLI before `rm(profile)` runs. The window can last five seconds while `closeBrowser` waits for SIGTERM. An offline subprocess probe supplied both cookies, delayed the fake browser's SIGTERM exit, and sent one SIGINT when shutdown began: the login process exited with status 130 while both the browser and its profile remained. Keep the handlers active through the entire cleanup, including profile removal, and make repeated cancellation safe.

**[P1] Use a private CDP channel tied to the launched browser — packages/abler-mcp/src/browser-login.ts:86**

`freeLoopbackPort` releases its listener before launching the browser, and `waitForDebugging` accepts any successful response on that port without establishing who owns it. Loopback and an OS-assigned port do not provide authentication or exclusive attachment: the port is exposed in the browser's arguments, and discovery/capture needs no secret. An offline probe claimed the released port with an unrelated CDP server before returning a live subprocess that never served CDP; `loginInBrowser` accepted that unrelated server's cookies. Verification later checks whether a session works, not whether it came from the browser the user signed into. Use a private inherited CDP transport or an equivalent ownership and access boundary; merely selecting another ephemeral port does not address this.

**[P1] Close the owned browser process tree before deleting its profile — packages/abler-mcp/src/browser-login.ts:188**

Shutdown signals and waits for only the PID returned by `Bun.spawn`, including its SIGKILL fallback. An executable supplied through `--browser`/`ABLER_BROWSER`, or found on PATH, can be a launcher that starts the actual browser as a child. When the launcher exits, `closeBrowser` returns and the profile is deleted while the browser remains alive. An offline launcher/child probe reproduced this: the launcher exited and the profile disappeared, but its child still answered CDP requests and exposed both synthetic authentication cookies after cleanup. Own and terminate the browser process tree, or establish and close the actual browser with a reliable fallback. Waiting for the launcher PID alone does not satisfy the cleanup contract.

**[P2] Release the child-process reference when keeping the browser — packages/abler-mcp/src/browser-login.ts:272**

The `keepBrowser` branch leaves the subprocess referenced. Under the required Bun 1.4.2 runtime, that keeps the CLI alive after `loginInBrowser` returns and the subsequent verification/save work can finish. An offline subprocess probe observed successful return from `loginInBrowser`, no process exit while the browser remained open, and immediate exit with status 0 after closing the browser. This turns the debugging option into a command that cannot finish while retaining the browser. Release the child reference on this intentional retention path so the CLI can return control to the terminal.

**[P2] Match the quick-start login command to the installed release — packages/abler-mcp/README.md:14**

The final HEAD's quick start installs the `abler-mcp@0.4.0` release and immediately tells the user to run `auth login`. The locally available release tag points to `c2b889705ff22c3d84ab394c37a84ea8edbbcb93`; its installer defaults to 0.4.0, and its CLI has no login action, so the tagged implementation prints help and exits 1 for this command. The feature remains under `Unreleased` in the changelog. Keep the published-version setup on capture/import, or clearly separate unreleased source instructions until the installer targets a release containing login. This finding is grounded in the local release tag and installer source; hosted release assets were not downloaded.

**Assessment**

Request changes: three P1 findings and two P2 findings. No P0 or P3 finding. The ordinary single-process paths pass, but the claimed cleanup and CDP isolation guarantees do not hold across the demonstrated scenarios.

Reviewed the complete requested diff from `a79e845cb52b01cedf19e02e994a4de96671ebb4`, restricted to `packages/abler-mcp` and `packages/mcp-runtime`. The initial HEAD was `4f2c5ae6a436e43ba3d4fa1251cb8448d885bce3`; another actor advanced HEAD to `e5bf1794754af9ea747c897fe4aa8ae8e8e2633c` during the review with documentation changes. Refreshed the complete in-scope README delta and applicable guidance at that final HEAD. The login source and tests are identical between those heads, so the existing test/probe evidence still applies. There are eight changed files in the final requested scope and no `mcp-runtime` changes. Read the surrounding authentication, CLI, API verification, shared error boundary, and relevant tests. This report is the only authored file; no code fixes or commits were made.

The change reuses the existing verify-then-commit flow: save a private candidate, force refresh and an authenticated read, rename on success, retain the candidate on verification failure, and prune old candidates after success. Moving that flow into `saveVerifiedSession` preserves its prior behavior. Browser cleanup actually finishes before this verification begins (`browser-login.ts:264–280`, `cli.ts:121–145`), so an ordinary verification failure does not leave the temporary browser running. The retained `.pending` file is deliberate recovery behavior, not a temporary-profile leak.

Browser arguments are passed as an argv array without a shell; spaces and shell metacharacters are not interpolated into a command. Explicit browser selection takes precedence over discovery. `mkdtemp` creates a unique profile followed by an explicit `0700` chmod. The executable check uses `stat` and `access`, so it follows symlinks and does not pin the executable's identity between checking and spawning. No additional exploitable executable/profile symlink race was demonstrated under a trusted executable/PATH and ordinary private or sticky OS temporary directory; this should not be mistaken for protection from a same-user attacker controlling those inputs.

The new launch suppresses browser stdout/stderr and replaces spawn failures with fixed text. Login polling catches CDP failures instead of printing their bodies; the existing import filters retain only the two Abler cookie names, and verification failure emits a recovery path rather than the upstream error. No new cookie-value disclosure through application diagnostics was demonstrated. The CLI's generic `Error.message` printer predates this diff and is not the shared MCP `SafeError` allowlist: newly reachable filesystem exceptions can still expose local paths. Do not claim that the login CLI universally enforces that allowlist.

**Validation**

Executed the requested command from the repository root with the locally installed pinned runtime:

```sh
PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH \
  bunx turbo run test --filter=abler-mcp --force
```

Result: **16 tests passed, 0 failed, 125 expectations**, across three test files under **Bun 1.4.2 (`744846f84`)**. Turbo reported **4 successful tasks**, no cache hits, in **5.128 seconds**. Its dependency typechecks passed; this command did not run the Abler package's own typecheck, lint, binary, installer, or release checks. The default shell Bun was 1.2.19, so it was not used for the reported acceptance run.

Additional probes ran from inline Bun scripts against the unchanged source. They intercepted only browser spawning to supply real offline subprocesses and the repository's synthetic CDP fixture. No real browser, Abler/Google service, or saved user session was used. Probe-owned processes and profiles were cleaned up afterward.

| Probe | Observed result | Evidence limit |
| --- | --- | --- |
| SIGINT after successful capture, during delayed browser shutdown | CLI exit 130/SIGINT; browser alive; profile still present | Real signal/process behavior with a delayed fake browser; no real browser cookies |
| Launcher with a separate browser child | Launcher exit 0; profile removed; child alive; both synthetic cookie names readable through CDP afterward | Demonstrates the supported launcher topology, not that every discovered browser uses it |
| Unrelated server claims the released port | Login returned both cookie names from the unrelated CDP server | Demonstrates the ownership gap; did not perform live account verification or an OS-wide port scan |
| `keepBrowser: true` after capture | Login function returned; owning process stayed alive; exited 0 when browser closed | Bun 1.4.2 subprocess behavior; provider verification was not part of this probe |
| Browser exits with code 23 before CDP readiness | Login rejected the early exit; profile removed | Confirms cleanup for a direct subprocess crash during startup |

**Test gaps**

The new file contains four tests: discovery, successful login, timeout, and one Ctrl-C while polling. Its fake browser is one Bun process that promptly stops its server and exits on SIGTERM (`test/browser-login.test.ts:57–60`). Checking that PID and the profile is useful evidence for those paths, but that fixture cannot prove process-tree cleanup, real Chromium shutdown, or resistance to signals during cleanup. Its server also binds to `127.0.0.1` independently of the supplied address flag, so these tests would still pass if the browser's loopback flag were removed.

Missing committed coverage includes delayed/ignored SIGTERM and the SIGKILL fallback; SIGTERM and repeated signals during cleanup; browser descendants and launcher exit; exclusive CDP access and port substitution; browser spawn/readiness failures; capture failure with partially signed-in cookies; login-specific verification failure and rotated-candidate retention; `--keep-browser` process exit; and hostile diagnostic payloads. The existing failed-import test exercises the shared persistence path, but does not by itself exercise the new browser lifecycle around it. The inline probes above identify several of these failures; they are not additions to the committed test suite.

**README accuracy and residual risks**

For the current source implementation, the package README correctly documents the command, default 300-second cookie wait, browser override/environment variable, private profile mode, and the credential-retention warning for `--keep-browser`; its installed-release mismatch is the fifth finding. Its unconditional success/timeout/cancellation cleanup claim (`README.md:95–99` at final HEAD) is contradicted by the first and third findings. The README and new changelog also imply verification before browser removal; the implementation removes the browser/profile after capture and before verification/save. Clarify that ordering when fixing the lifecycle issues. The 300 seconds covers cookie polling; browser readiness has a separate 15-second budget and verification/cleanup add further time.

Actual Chromium-family launch compatibility, listening address, process shutdown, and native-binary behavior remain **not_run** in this review. Existing historical live observations in the README are not proof of this new login implementation. Multi-user CDP access was not exercised using another OS account; the local unauthenticated transport and wrong-owner acceptance are established from source and the offline substitution probe.

`--keep-browser` intentionally retains the profile and its credentials, including on a failed login once spawning has succeeded. That explicit opt-in is not itself a finding. Hard termination such as SIGKILL, a runtime crash, or power loss cannot execute the JavaScript `finally`; the new code has no later sweep for abandoned `abler-login-*` profiles. Filesystem deletion failure can also leave a profile behind. These remain limits of the cleanup guarantee even after the actionable signal and process-ownership defects are fixed.
