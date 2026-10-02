# Inna parsing and repeated-read verification

Date: 2026-10-02. Scope: Inna 0.1.1 hardening after the initial 0.1.0 preview.
The maintainer authorized publication of 0.1.1 and the public website update.
The manifest, documentation, and installer pins are synchronized for that
release. The preview is published, its four-platform checks passed, and the
English and Icelandic public pages now show 0.1.1. Release and deployment
evidence follows below.

## Findings and changes

| Finding | Change | Verification |
| --- | --- | --- |
| School date strings had no normalized contract. Unzoned JavaScript parsing can depend on the host timezone. | Preserve source values; normalize Icelandic/ISO dates and epoch milliseconds; interpret unzoned timestamps as UTC. Date-only values remain dates. Report parsed, missing, or unrecognized status. | Calendar, leap-year, clock, offset, fractional-second, sentinel, malformed-string, and numeric-boundary cases; subprocess checks in Honolulu, Berlin, and Auckland. |
| Requested inbox row ranges could be mistaken for the number of rows delivered. | Return `nextRowFrom` based on delivered rows. Reject duplicate, overlong, empty nonterminal, and count-inconsistent pages. | A synthetic 41-message inbox delivered in 20/20/1 rows, with malformed-page refusal checks. |
| A browser could switch the student after the initial context check. | Verify account/student/school before and after reads; discard a result on mismatch. Include UTC `retrievedAt` and `timeZone` metadata. | Student switch during a timetable fetch; all 13 read/status tools exercised through MCP. |
| HTTP-date `Retry-After` values were ignored, and long delays were shortened to an hour. | Honor numeric and HTTP-date delays with a minimum one-minute pause, persisted under the existing session lock. | Numeric, HTTP-date, invalid, and two-hour headers; restarted clients make no request before the saved deadline and resume at it. |
| Body reads used only the caller signal, and a stalled stream could wait indefinitely between abort checks. | Pass the combined request deadline and caller signal to the shared body reader. Cancel its pending read on abort and remove the listener afterward. Cancel rejected responses without letting cleanup failure mask their safe error. | Stalled-body cancellation, pre-aborted reads, UTF-8 byte limits, and failed-response cancellation. All MCP consumer checks rerun after the shared change. |
| Absence history parsing discarded trailing date text; leave preflight did not check illness overlap. | Parse complete history dates strictly and check illness overlap for both request kinds. | Malformed history and existing illness block sick and leave requests with zero POSTs. |
| A preview could expire or UTC midnight could pass during submission preflight. | Sample the checked UTC day once and recheck both day and preview expiry before the submitting marker and POST. | Clock advances during preflight; both cases refuse submission and retain a prepared record. |

## Local evidence

- `bun run --cwd packages/inna-mcp check`: TypeScript, Oxlint, and formatting pass.
- `bun run --cwd packages/inna-mcp test`: 21 passing synthetic tests,
  1,865 assertions, no live network requests. Every one of the 15 tools is
  exercised through MCP. Separate write checks cover whole-day sick and
  inclusive leave payloads, explicit confirmation, replay refusal, revoked
  permissions, student changes, expiry, and uncertain responses across restart.
- Shared runtime checks: cancellation and byte-limit regression plus safe
  error/structured-output checks pass.
- `bunx turbo run typecheck lint format:check test release:check --force`:
  39 tasks pass, including all five MCP packages and the shared-source cache
  invalidation regression.
- After the version sync, `bunx turbo run check test release:check --force`:
  all 46 tasks pass. Root `bun audit` reports no known vulnerabilities.
- `bun run --cwd packages/inna-mcp build:binary`: macOS arm64 standalone
  executable and archive built successfully with Bun 1.4.2.
- `bun run --cwd packages/inna-mcp test:binary`: standalone MCP smoke passes,
  including 13 default tools, 15 with write opt-in, missing-session responses,
  version/help, and clean protocol output.
- `bun run --cwd packages/inna-mcp test:installer`: all 12 piped-installer
  cases, old-process handling, truncated scripts, real archive installation,
  spaced prefix, reinstall, checksum rejection, previous-command preservation,
  and installed-binary protocol smoke pass.

## Published release and hosted evidence

- Source commit and immutable release tag: `c443a8907c02b3db095bd301e1a6510dfed810e8`,
  `inna-mcp@0.1.1`.
- [Release CI](https://github.com/olafurns7/family-mcp/actions/runs/37033249086)
  passed both Node 22/24 quality jobs and standalone binary/installer jobs on
  macOS arm64/x64 and Linux arm64/x64. The
  [main CI](https://github.com/olafurns7/family-mcp/actions/runs/37033244778)
  and [landing CI](https://github.com/olafurns7/family-mcp/actions/runs/37033245021)
  also passed for the same source commit.
- All nine draft assets were downloaded and verified before publication:
  four archives, their SHA-256 files, and the installer. Archives had exactly
  the expected regular files/directories, executable permissions, source-matched
  README/LICENSE, sourcemap, and dependency notices. The installer matched the
  tagged source byte-for-byte.
- [Inna 0.1.1 preview](https://github.com/olafurns7/family-mcp/releases/tag/inna-mcp%400.1.1)
  was published at `2026-10-02T16:28:18Z`, with draft false, prerelease true,
  and latest false.
- The public pinned installer installed successfully into a disposable prefix
  containing a space. The installed executable matched the verified CI-built
  macOS arm64 binary and passed standalone protocol smoke, including the
  default and opt-in tool inventories. Temporary installer files were removed.
- `bun run deploy` published the Astro assets to [mcp.olinn.is](https://mcp.olinn.is/),
  Cloudflare version `f6103f31-bdcf-4294-a6d0-362142cd31c8`. Browser verification
  confirmed the English and [Icelandic](https://mcp.olinn.is/is/) pages display
  Inna 0.1.1 and its matching installer, release, and setup links, alongside
  all five services and the preview limitations. No viewport override was used.

The prior landing workflow failed at `bun audit`, after its frozen install and
Astro checks had passed. For the 0.1.1 website update, `devalue` is now 5.9.3 and
Wrangler is 4.147.0, whose Miniflare dependency uses Undici 7.29.1. These replace
versions flagged by the [devalue advisory](https://github.com/advisories/GHSA-j22f-vq7h-c4qm)
and [Undici advisory](https://github.com/advisories/GHSA-w293-vg96-wgc3). The current
landing frozen install, audit (375 packages), Astro check/build, and deployment
dry run pass. This is dependency-gate remediation, not evidence of a vulnerability
being exploited on the static site.

Eight simultaneous synthetic timetable calls were serialized under the shared
session lock. All fetched fresh responses, returned UTC dates, preserved private
session permissions, and issued GET requests only. No cache, background scheduler,
or additional login/session storage mechanism was introduced.

## Proof boundaries

The original preview's owner-authorized live native run verified eID login,
private session reuse after restart, and all 13 read/status tools in one guardian
context. This follow-up uses synthetic providers and does not extend that live
coverage claim. Google browser login and account linking were verified during
the original endpoint investigation.

Real absence submission remains unverified. Test fixtures never send a school
request, and a real check requires an actual approved student, dates, kind,
and reason. A returned creation ID would establish submission, not school
approval.

Nonempty historical final-grade rows, mixed timetable variants, attachment
variants, a live larger inbox boundary, unopened-message read-state behavior,
and longer session lifetime/expiry remain live verification gaps. Unexpected
source shapes fail safely rather than being treated as empty feeds or zero
grades. Unknown date formats are explicitly unavailable.

Inbox offsets are mutable row positions, not stable cursors or an atomic
snapshot. Separate page calls can overlap or miss rows if new messages arrive
between them; agents should deduplicate by `table` and `messagesId` and restart
when counts or membership change. These changes do not claim an incremental
notification feed or deletion detection. Context checks similarly verify
boundaries, without establishing a server-side transaction across requests.
