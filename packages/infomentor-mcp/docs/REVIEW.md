# Review and verification

## 0.5.0: child selection, collection, and session renewal

`infomentor_select_child` and `client.selectChild({ childId })` select a child
from the authenticated account's overview and return the updated overview.
The child list and switch URL are discovered from each Icelandic parent account;
no personal IDs, credentials, or host paths are built in. Selection changes
session context, not school records. A local queue and a cross-process session
file lock coordinate reads, selection, setup, renewal, and logout.

`infomentor_collect_updates` scans every registered child, complete inbox/sent
message bodies, available timetables, and all notification states. It restores
the original child with a fresh bounded cancellation signal, and rejects an
incomplete or inconsistent scan before returning a cursor. Identical payloads
are grouped by source identity and observed child contexts. Notification identity
includes its pupil source ID. Missing feed references do not imply deletion.

Collection cursors reference immutable private snapshots of account-scoped
fingerprints and identity references, without school text. Reusing an old cursor
replays changes; a caller saves the new cursor after successful handling.
Unchanged scans reuse the cursor. Retention is 90 days since use. Pagination,
response size, and elapsed time are bounded; failures never return a new cursor.

Confirmed authentication expiry can trigger one new sign-in with credentials
configured on the MCP process. The account must match before saving new cookies;
the pre-operation child is restored before retrying. No OAuth refresh token or
silent cookie-only renewal is assumed. Missing sessions require explicit login,
including after logout. Cookie updates are atomic and use the same session lock.

The existing integration flow covers multiple children, a single-child account,
separate account cookies, unknown IDs, unsafe switch URLs, unchanged read state,
queue ordering, and selection followed by a failed timetable request. The URL
checks prove that rejected links are never requested. The earlier child-selection
implementation passed its focused checks, package-consumer checks, and macOS
executable installer. Those results predate the collection/renewal additions.

All 15 automated checks pass for quiet baselines, full-body edits,
cursor replay, contextual missing items, composite notification IDs, pagination,
selection interference, cancellation/restoration, expired or wrong-account
cursors, response limits, renewal, and local session locking. Independent source
reviews covered cursor semantics and authentication/account preservation. Package
installation, public consumer types, publication dry-run, and the standalone
macOS installer/eleven-tool handshake passed. Hosted release checks are recorded
on the release commit.

Live MCP verification on the existing Grok Bot VM deliberately expired a private
copy of the parent cookie. The new source renewed authentication from the
configured private environment, verified the same parent and original child, and
persisted the new session. A quiet all-child baseline completed in 12 seconds;
an unchanged follow-up completed in 11 seconds, returned no updates/missing
references, and reused the cursor. An includeExisting scan returned both children,
both timetables, a full message, and 30 grouped notifications. Observed message
and notification states stayed unchanged. Original selection was restored, a
restarted MCP reused the session, and the verified renewal was saved for the
installed client. No secret values or school content were emitted by the check.

Live MCP calls on the authorized VM switched a two-child account, verified the
selected flag and subsequent timetable, checked notification filtering, and
restored the original child. That check preceded cookie persistence; its saved
session file was unchanged. Messages
remained readable and their IDs did not change for this account; no per-child
message visibility guarantee is inferred. This live check used the built MCP
source through the existing optional WARP connection.

Selection persistence across reconnects and isolation from other clients
sharing a session are not promised.
`selectedChildOnly` notifications follow the current session selection; messages
remain whatever InfoMentor exposes for the account. WARP stays optional and
upgrades preserve the chosen mode.

## 0.4.0: optional WARP installation

The Linux installer can opt into WARP on the validated Debian 13/x64 platform.
Its choice survives upgrades. A separate launcher sets the existing runtime's
proxy environment; the MCP's HTTP transport remains unchanged. The headless
client download is pinned and checksum-verified, and existing WARP installations
are refused rather than reconfigured. No sudo permission is granted.

Installer coverage includes opt-in, retained mode on upgrade, return to direct
mode, and the launcher's proxy environment and argument forwarding. Real-host
installation and restart verification are recorded in the connectivity report.

## 0.3.0: message and notification reads

Three new MCP tools and typed client methods read message lists, message details,
and the current notification feed. They use the existing authenticated HTTP
transport and account queue. Responses are validated; message bodies use the
server's plain-text field. No send/delete/viewed-state endpoint is called.

The existing MCP integration check now covers nine tools, paging/search form
encoding, invalid inputs, malformed upstream data, notification filtering, and
preservation of synthetic unread state. No extra suite or dependency was added.
Source review traced all read callers, redirect/cookie handling, cancellation,
schema exports, and package/installer consumers.

A live MCP handshake and calls on the authorized VM verified all three new
tools with a real account and unchanged observed read states. The VM used its
existing exit route. A subsequent check used the published Linux x64 executable
with `HTTPS_PROXY` pointing to a temporary local WARP proxy. Authentication,
overview, all three new tools, and unchanged observed message states passed.
The WARP tunnel used the native VM interface, independently of the exit node.
The temporary setup was removed. Proxy-free VM TLS remains unresolved; see
[the connectivity investigation](CONNECTIVITY.md) for configuration, measurements,
and evidence limits. No provider trace or VM rebuild was needed.

## 0.2.2: empty authentication cookie fix

`captureSession` now drops empty cookies before validating the saved session.
The cookie library omits `value` for these cookies, so an empty `.ASPXAUTH`
deletion cookie previously caused saving to fail after successful authentication.
Login and session import share this fix.

The existing login integration check reproduces the deletion cookie and verifies
that the authenticated session is saved, reopened, and used for the MCP overview.
The regression failed before the fix. No additional test suite was added.

## 0.2.1: remote login correction

Default login no longer starts the loopback credential form. Credentials come
from the host-injected environment or an existing private file, and username
accepts kennitala. The browser form requires explicit `localForm` / `--local-form`.
This is independent of the agent vendor; a private input UI remains the host
client's responsibility, not a universal MCP capability.

The existing login integration check now covers missing and partial credentials,
secret injection, HTTP authentication, session persistence, and MCP output with
no credential values or loopback URL. Private-file and explicit-form paths remain
covered by the other existing checks. No additional test suite was added.
The actual Grok VM and its secret-injection configuration remain unverified.

## 0.2.0: direct HTTP and a single executable

Playwright and its browser lifecycle, installers, and remote-debugging options
were removed. Authentication now submits InfoMentor's fresh login form, follows
its hidden OpenID form relay, and verifies the explicit session endpoint.

The parent overview parses bootstrap JSON without executing JavaScript and reads
the selected child's timetable endpoint. HTTP cookies use `tough-cookie`; HTML
forms use `htmlparser2`. These replace browser automation, not the MCP SDK or
runtime validation.

The executable uses Bun 1.4.2's single-file compiler. Its runtime and imported
code are embedded. Only the executable is needed at runtime; the archive also
includes documentation and license notices. Working-directory `.env` and
`bunfig.toml` autoloading are disabled.

Five focused checks cover the HTTP login/MCP flow, rejected or unsafe responses,
atomic cancellation during login/import, request cancellation, and the private
loopback credential form. Packaging checks exercise clean npm installation and
consumer types; the native installer check copies the binary away from its
package and uses a PATH without Node or Bun.

Real-account investigation verified password login, the hidden-form relay,
persisted-session reuse, child lists, and timetable retrieval without a browser.
The TypeScript HTTP client also reused that private session successfully.
See [HTTP-AUTH.md](HTTP-AUTH.md) for the observed flow.

## Retained safeguards

- Validate each redirect and form destination before issuing a request.
- Restrict password submission to the observed login origin; never forward a
  POST body across origins through a 307/308 redirect.
- Require a positive authentication response before saving/importing a session.
- Preserve an existing session on failed/cancelled setup, including cancellation
  immediately before its atomic commit.
- Lock account reads/selection/setup and session-file writes across local MCP
  processes, including renewal and logout.
- Verify the same account before automatic renewal commits new cookies; never
  automatically sign in when the saved session is missing.
- Restore the original child before committing a collection cursor and preserve
  old snapshots so failed delivery can retry the last handled cursor.
- Abort network requests when login is cancelled, times out, or the client closes.
- Keep passwords and raw upstream errors out of MCP and log output.
- Limit the credential form to loopback with host/origin checks and a form token.

## Earlier findings

The four lifecycle findings fixed in 0.1.3 included cancellation at session
commit, browser-install child processes, closing sign-in popups, and browser
acquisition deadlines. The session-commit protection remains. Browser-specific
code and its tests were deleted in 0.2.0.

## Remaining limits

The selected child's timetable is an overview, not a complete school record.
The package does not provide homework, attendance, grades, or message sending.
Collection and renewal live validation is in progress. Other apps sharing the
upstream session can interfere despite the local lock and selection readbacks.
Other SSO/MFA paths,
challenge-protected accounts, long-term session lifetime, and direct connectivity
from the Grok VM remain unverified. The npm registry remains unpublished.
