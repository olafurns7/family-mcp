# Release review — 0.3.1

Reviewed on 2026-09-11. Scope: all authentication, HTTP/API, child reporting,
MCP registration, CLI, tests, package metadata, and consumer instructions.
This is a source and executable review, not an Abler security certification.

## Findings addressed

| Finding                                                                                                           | Repair and evidence                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High: two client instances or processes could refresh the same credential concurrently and invalidate one another | A shared file lock now covers the full session operation. A regression test starts three separate processes against a simulated upstream that invalidates each preceding refresh token; all three succeed.                                                          |
| High: logout could race an in-flight request and the request could recreate the deleted credential                | Logout uses the same lock. A separate-process test holds a refresh in flight, starts logout, then proves the request finishes before removal and the file remains absent.                                                                                           |
| Medium: failed import discarded a newly rotated credential when the subsequent verification failed                | Import verifies a private candidate while holding the destination lock, commits only on success, and retains a recoverable candidate on failure. A subprocess test verifies its rotated token, owner-only permissions, redacted error, and untouched previous file. |
| Medium: misspelled child/participant filters were silently stripped, broadening the request                       | MCP and client inputs now reject unknown keys. Empty participant/group/child filters also fail. Tests verify both direct and actual MCP calls.                                                                                                                      |
| Medium: replacing an account between the profile read and child queries could mix accounts in one report          | A whole child report uses one loaded session under one lock. Each child query still uses the upstream participant filter and an independent cursor.                                                                                                                 |
| Medium: copied sessions with broad Unix permissions or symlink paths were silently accepted                       | Loading now requires a regular file, refuses symlinks, and rejects group/world-accessible Unix files. Atomic writes remain mode 0600. Regression checks cover permissions and symlinks.                                                                             |
| Medium: malformed event data or a missing/non-advancing cursor could look like a valid result                     | Core event fields and attendance are validated. Incomplete/stalled pagination and event identity mismatches fail explicitly, with regression checks.                                                                                                                |
| Low: CLI/MCP versions could drift; session status did not identify the account                                    | Both versions now read package metadata. Status verifies Abler and returns the account ID/display name.                                                                                                                                                             |
| Child selection needed an explicit key/value lookup                                                               | `get_profile.childNamesById` maps Abler-assigned child IDs to current display names. The lookup is refreshed from Abler, drives child ID validation, and preserves separate IDs for duplicate names.                                                                |

## Validation record

- Offline suite: **7 tests, 85 expectations**, passing on macOS with Bun 1.4.2.
  Covers HTTP-only cookie refresh, auth retry, redacted failures, date and
  pagination filters, local Chrome capture transport, real MCP stdio, sibling
  identity/attendance, independent cursors, concurrent processes, logout,
  permissions, malformed responses, and failed-import recovery.
- TypeScript check, lint, formatting, and native binary/installer checks: passed.
- Runtime dependency audit: **0 known advisories** in the resolved production
  dependency tree on 2026-09-11. This is a registry advisory snapshot, not proof
  that dependencies are vulnerability-free.
- Authorized live account reads: renewed session, account/profile, groups,
  date-filtered schedule, three separately filtered child schedules, pagination,
  and event lookup worked. The new ID/name map matched Abler's assigned IDs.
  Live proof is separate from synthetic tests; account data is not included here.
- Native checks build the standalone executable, copy it outside the checkout,
  run the MCP stdio smoke, and exercise the piped installer against a real
  archive. Its PATH contains neither Node nor Bun.
- Archive inspection covers the executable, README, LICENSE, and generated
  third-party notices. The release draft contains only four native archives,
  their checksums, and `install.sh`.
- GitHub Actions runs package checks and native installer checks. Check the
  repository's Actions result for the exact commit; this document is not a claim
  about a later commit's CI status.

## Deliberate limits

- Abler's website endpoints are observed, undocumented API behavior. They may
  change. No public OAuth client registration/integration was established.
- First sign-in needs Abler's browser login. Unattended OTP/CAPTCHA handling is
  not implemented. Google is offered by the UI but was not separately tested.
- Browser capture was tested with a synthetic local Chrome protocol server;
  the live investigation exported its session through browser tooling. A full
  manual debugging-profile capture remains a distinct validation gap.
- A lock coordinates one local session path. It cannot coordinate cloned
  credentials on other machines or the browser itself. Use one active copy
  or separate sign-ins. Network filesystems and Windows are unverified.
- Account permissions apply to the credential. The package only exposes reads;
  the underlying credential must still be treated as an account secret.
- Date boundaries and attendance codes retain Abler's semantics. Timezone edge
  behavior and meanings of undocumented attendance codes were not established.
- Page calls are not a server-side snapshot; events may change between pages.
  Agents must follow each cursor, deduplicate by stable IDs, and disclose a
  partial or failed report. No schedule data is cached on disk.
- Only native archives are distributed. Windows and Alpine/musl remain
  unsupported for the standalone executable.
