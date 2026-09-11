# Review: publication and MCP setup

Reviewed 2026-09-11. Scope: login, session persistence, browser lifecycle, tool
contracts, cancellation, credential boundaries, dependencies, installation, and
release contents. This is a source and automated-test review, not live acceptance
of the Icelandic InfoMentor account flows.

## Findings addressed

| Finding                                                                                          | Change                                                                                                                                             | Verification                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account setup was CLI-only; a human login could exceed MCP request timeouts.                     | MCP now starts bounded background setup and exposes progress/cancellation. CLI and MCP share the login/import/installer implementations.           | Real MCP calls with browser fixtures cover login, import, timeout, cancellation, concurrent-start rejection, and disconnect cleanup.                                         |
| A running MCP connection could retain an authenticated browser after local logout.               | Logout cancels setup, drains reads, closes the connection's browser, and removes the file. Setup blocks account-data reads during account changes. | Logout during login and after authenticated reads leaves no saved session or connected browser in that client.                                                               |
| A security check returning HTTP 403 could close the initial login page.                          | Recognized checks remain open for human completion; no automatic retry is performed.                                                               | Synthetic 403 check completes in a real browser with exactly one request.                                                                                                    |
| A read could remain blocked waiting for a frame body.                                            | Frame-text reads have an explicit deadline; cancellation remains active across navigation and extraction.                                          | Browser integration checks cover the read lifecycle, challenges, rate limits, and recovery.                                                                                  |
| Browser-installer stdout would corrupt stdio MCP if the CLI implementation were reused directly. | The shared installer captures output; only the CLI sends diagnostics to stderr.                                                                    | Real stdio MCP browser installation and protocol checks use already-installed compatible builds.                                                                             |
| Source-only installation and missing release metadata prevented a useful pre-npm distribution.   | Added MIT/repository metadata, prebuilt npm checks, native-runtime archives, checksum verification, and a user-prefix shell installer.             | Clean npm install with scripts disabled; CLI/API/MCP/type checks; native installer with no Node/Bun in PATH, spaces in the prefix, reinstall, and bad-checksum preservation. |

Credential checks also cover host lookalikes, non-HTTPS InfoMentor URLs, insecure
remote CDP endpoints, unrelated-cookie filtering, HttpOnly/local-storage/IndexedDB
restoration, private POSIX file modes, malformed imports preserving saved state,
and absence of credentials in MCP output. Read requests reuse a browser, serialize
access, retain rotated cookies in memory, and honor HTTP 429 cooldowns.

Oxlint now enforces base correctness/suspicious checks, explicit-any rejection,
accumulating-spread checks, and all 18 generic Anti-Slop rules. A deliberate
violation probe confirmed base, TypeScript, and plugin diagnostics. The lint
cleanup replaced an open MCP result dictionary with the concrete result union
and parses saved-session JSON directly at its boundary. Oxfmt replaced Prettier.
Browser, package, and installer checks passed again after these changes.

A later Chromium release check exposed a cancellation race: a queued read could
inspect a page whose previous request was still closing it. The shared read path
now awaits cancellation cleanup before releasing its queue. The browser regression
check holds page closure open deliberately and fails without this fix.

The release run also exposed a Chromium test-profile cleanup race after the
browser assertions had passed. Cleanup now uses Node's bounded filesystem retries
after waiting for the spawned browser process to exit.

The follow-up review found four more lifecycle issues, fixed in 0.1.3:

| Finding                                                                                         | Change                                                                                                                                                                      | Verification                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cancelling during a pending session write could replace the previous account.                   | Login and import pass cancellation through the shared writer; it checks again immediately before the atomic rename.                                                         | Real login/import tests pause a filesystem write, cancel setup, then verify the old file is unchanged and temporary files are removed.                                                                                                     |
| Cancelling the installer could leave its subprocesses running and release the setup lock early. | The installer owns a process group on macOS/Linux, stops that group on cancellation, and waits for process/output closure. Windows uses the native taskkill tree operation. | A real parent/grandchild process test holds inherited output open and ignores SIGTERM; cancellation escalates, drains the processes, and keeps concurrent setup blocked until completion. No system package installation runs in the test. |
| A sign-in popup closing during inspection could abort login while the parent was still open.    | The login loop skips closed pages and ignores inspection failures only when that page closed.                                                                               | A real browser popup closes during inspection after signing in the parent; login resolves to the parent.                                                                                                                                   |
| Browser startup and CDP connection ignored cancellation and the login deadline.                 | The shared acquisition path races cancellation, prevents further browser fallback, and closes a browser that arrives after cancellation.                                    | Delayed local/CDP acquisitions exercise both cancellation and timeout, with real late-arriving browsers checked for closure.                                                                                                               |

## Remaining limits

- Real-account login detection still uses signed-out/signed-in page controls.
  The saved parent landing page, redirect hosts, actual session lifetime,
  cross-machine transfer, and InfoMentor bot-protection behavior need live proof.
- The overview is visible page text, not a complete child record. No structured
  child selection, schedule, homework, attendance, or grades endpoints are verified.
- Logout does not revoke credentials on InfoMentor or terminate other MCP
  processes. The saved session file remains a bearer credential in plaintext.
- Firefox/WebKit tests use their Playwright builds. Arbitrary Chromium variants,
  Windows, Alpine/musl, and remote TLS browser providers are not covered by the
  native-release matrix.
- Linux browser system libraries may require host-administrator provisioning.
  Bundling the Node runtime does not bundle a browser or a graphical display.

These limits are disclosed in the README and preview release notes. npm
publication remains a separate decision; a successful dry-run is not publication.
