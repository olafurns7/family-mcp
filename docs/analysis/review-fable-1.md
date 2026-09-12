# Fable review 1: full-tree defect review

Reviewed `main` at `02f7de5` on 2026-09-12. That commit differs from the
brief's `4317dde` only by `docs/analysis/review-astra-2.md` (64 added lines,
no source change), so every check and probe below ran against source identical
to HEAD. Scope: the whole current tree (session-store, mcp-runtime, both
servers, release tooling, workflows, docs), not a diff. Read `CLAUDE.md`,
`docs/AGENTS.md`, and the four earlier reports first, then verified each
earlier finding independently at HEAD (table at the end). All work was offline:
injected fetches, loopback fixtures, and archived scratch copies. No live Abler
or InfoMentor service, real account, or public download was touched. This
report is the only repository file written; probe scripts lived under
`/private/tmp` and are removed.

## Findings

### [P2] Clamp the live rate-limit deadline once when it is accepted — packages/infomentor-mcp/src/http.ts:153

Confirmed open; recorded as finding 1 in `review-astra-2.md`. The phase 5B fix
clamps only the *serialized* pause (`login.ts:212`). The `InfoMentorHttp`
instance keeps the unclamped `cooldownUntil`, and `InfoMentorClient.saveActive`
keeps that instance as `this.active` whenever the file it just wrote still
matches (`client.ts:218`). Failure scenario: one `Retry-After: 9999999999999`
response (from InfoMentor itself, or from anything that terminates TLS for it,
such as an inspecting proxy with an installed root certificate) leaves the
originating MCP process refusing every school-data tool
for its entire lifetime, while the file promises other processes at most one
hour. Independent probe with an injected 429: the first call returned
`RATE_LIMITED` with `retryAfterMs = 9999999999999000`; a second call on the
same client returned `9999999999998996` without a request; a fresh client on
the same file returned `3599999`. Astra additionally showed that a retry by the
originating process re-arms the shared file for another hour after expiry.
Fix: apply `Math.min(wait, MAX_RATE_LIMIT_MS)` in `request()` when the 429 is
accepted, persist that fixed instant rather than `now + cap` on every save,
and extend the regression at `integration.test.ts:1236` to advance time and
retry the originating client.

### [P2] Serialize the two release:sync rewrites of the root README — tooling/release/sync-version.mjs:25

Confirmed open; recorded as finding 2 in `review-astra-2.md`. Both packages'
`release:sync` tasks read the shared root `README.md`, transform their own pins,
and write the whole file back (`sync-version.mjs:67`). `turbo.json` gives
`release:sync` no ordering, so the two tasks run concurrently and the later
writer restores the other package's stale pin. Independent probe in an archived
copy with only Abler bumped to 0.3.2: running both synchronizers concurrently
left the root Abler pin at 0.3.1 in 5 of 8 attempts, with both processes
exiting 0; sequential runs were correct every time. Following
`docs/PUBLISHING.md` therefore can ship a release whose root install command
still points at the previous tag, and `release:check` will then fail only if
someone runs it after the race. Fix: give one root task ownership of root README
pins (write only the selected package's URL, never the whole file from a stale
read), or wrap the read-modify-write in `withFileLock`, and add a regression
that runs both tasks through Turbo against one root README.

### [P2] Remove retained `.pending` candidates on `auth logout` — packages/abler-mcp/src/auth.ts:55

A failed import deliberately keeps `session.json.<uuid>.pending` (0600) because
Abler may already have rotated the imported refresh token into it
(`cli.ts:90-101`). Nothing ever ages those files out: `sweepTemp` only matches
`.tmp`, and `prunePendingCandidates` runs only after a *successful* later
import (`cli.ts:104`). `removeSession` deletes only the session file itself.
Failure scenario: a parent's import fails on a transient error after Abler
rotated the token, the candidate now holds the only valid refresh credential,
the parent later runs `abler-mcp auth logout` before handing over or wiping the
machine, and the README (`packages/abler-mcp/README.md:101`) and `--help`
describe that as removing the local session. The live credential stays on disk
indefinitely. Mitigation today: the one-time failure message says to treat both
files as credentials. Fix: have `removeSession` also delete
`<basename>.*.pending` beside the file (under the same lock), mention
candidates in the logout wording, and add a test that a failed import followed
by logout leaves the directory empty.

### [P3] Include the root README in the release:check cache inputs — turbo.json:73

`release:check` runs `sync-version.mjs --check`, which reads the root
`README.md`, but the task's inputs are the package directory plus the global
dependencies; the root README is neither. Probe on an archived copy with
`turbo run release:check check --dry=json`: `abler-mcp#release:check` kept hash
`f355e75f76b0c4a5` and `infomentor-mcp#release:check` kept `a027fb76d557a439`
after appending to the root README. Failure scenario: a developer edits the
root install pin (or the race above stales it), runs `bun run check`, and the
cached pass replays; only `--force` or an uncached CI runner catches it. This is
the same class as the Astra P2 cache-key finding, lower because CI has no
persisted Turbo cache. Fix: add
`"inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/README.md"]` to `release:check`
for both server packages (or a package-scoped override), and extend the
scratch-copy hash regression to cover it.

### [P3] Stop copying untracked checkout contents in the cache-key regression — tooling/release/release.test.mjs:200

The regression copies the entire repository, excluding only top-level `.git`,
`node_modules`, and `.turbo`. It does not honour `.gitignore`, so on this
checkout every run copies `.worktrees/` (655 MB including two more
`node_modules` trees and four 64 MB binaries) and both `packages/*/release/`
directories into a temporary directory, then deletes them. Measured 3.0 s here
on a fast SSD; on a slower disk or with more worktrees the "fast" test becomes
the slowest task, and any local-only file a developer keeps in the checkout
(an ignored `.env`, a session or credentials file used for manual testing) is
duplicated into the temporary tree. The copy is `mkdtemp` (0700), so this is
hygiene rather than exposure. Fix: copy from `git ls-files -z` (tracked files
only) or add `.worktrees`, `packages/*/release`, and `*.env*`/`*session*.json`
to the filter.

### [P3] Keep a contender's lock temporary out of the holder's sweep — packages/session-store/src/lock.ts:71

A waiter's temporary lock directory is `<file>.lock.<pid>-<uuid>.tmp`, which
matches `sweepTemp(file)`'s `<basename>.` prefix and `.tmp` suffix. Both servers
call `sweepTemp` under the lock (`abler auth.ts:35`, `infomentor lock.ts:25`).
The README (`packages/session-store/README.md:66`) says calling the sweep
under the lock keeps a waiter's temporary from being mistaken for an orphan;
in fact only the five-minute age threshold protects it, and `waitMs` is
caller-chosen with no relation to `DEFAULT_SWEEP_AGE_MS`. Probe (age simulated
with `utimes`, so the waiter looked older than five minutes): the holder's
`sweepTemp` removed the waiter's temporary, and the waiter then failed with
`IO: Cannot create the session lock. Check the session directory permissions.`
(cause `ENOENT`) instead of `BUSY`. Realistic triggers are a caller passing
`waitMs` above 300 s, or a waiter suspended for more than five minutes. Impact
is a misleading permissions error plus a false README claim. Fix: place lock
temporaries under a name the sweep never matches (for example
`<file>.lock-tmp.<owner>`), or skip entries whose PID is live in `sweep`, and
correct the README sentence.

### [P3] Bound Abler response bodies before parsing — packages/abler-mcp/src/api.ts:282

Every Abler response is consumed with `response.json()` (also at lines 260 and
291), which buffers the whole body with no size limit; InfoMentor caps bodies
at 8 MiB in `readBody`. The loopback test's "large bodies" case sends an
8 MiB body of zeros and asserts `invalid API response`, which proves that
non-JSON is rejected, not that buffering is bounded. Failure scenario: a
response of hundreds of megabytes from Abler itself, or from a TLS-terminating
proxy the host trusts, is fully buffered inside the long-lived MCP process
before the schema rejects it. Fix: reuse a bounded reader (the InfoMentor
`readBody` logic could move to
`mcp-runtime`) and reject above a small limit such as 4 MiB, with a test that
streams past the limit.

### [P3] Correct stale counts and layout in the docs — packages/abler-mcp/README.md:214

`bun test` in `packages/abler-mcp` now runs 11 tests (10 in
`integration.test.ts`, 1 in `loopback.test.ts`; the forced run reported
`11 pass`), not "the eight offline integration tests". `CLAUDE.md:18-20`
lists the workspace layout without `packages/mcp-runtime`,
`tooling/oxlint-anti-slop`, or `tooling/tsconfig`, although the root README and
`turbo.json` depend on all three. The session-store README sentence covered by
the sweep finding above is the third inaccuracy. Fix: update the count (or
drop it), add the three directories to `CLAUDE.md`, and reword the README.

## Overall assessment

No P0 or P1 defect was found. The security boundaries hold at HEAD: unknown
errors and Zod errors reach MCP callers only as fixed text, `SafeError` is the
only pass-through, and the shared unit test (`mcp-runtime/test/index.test.ts:19`)
pushes four secret-bearing unknown errors through `toolResult` and asserts only
the generic message comes back (review-astra-2 additionally confirmed this
through an in-memory SDK round trip). Session files are read
through `O_NOFOLLOW` handles with mode, owner, hard-link, size, and re-stat
checks, written 0600 via an exclusive temporary and rename, and coordinated
through a directory lock that never age-expires a live PID. Abler refuses all
redirects and sends cookies only to `https://www.abler.io`; InfoMentor follows
redirects manually, validates every hop and form action against
`*.infomentor.is`, never forwards a POST body across origins, and submits the
password only to the `im1.infomentor.is` origin. Setup tools are opt-in, so an
agent reading untrusted school text cannot log the parent out or replace the
account by default. The installer is a well-constructed `curl | sh` script: a
`main` wrapper defeats truncation, downloads are HTTPS-only with TLS 1.2 or
better, the checksum line must match both digest and filename, only named
archive members are extracted to fresh files, the new executable is
version-checked before the symlink swap, and every failure path leaves the
previous command in place (the 12-case fake matrix and the real-archive path
both pass). The release workflow pins actions by SHA, keeps `contents: write`
on the draft job only, requires an existing tag whose version matches the
manifest and installer pin, and verifies exactly four archives plus checksums
before drafting.

The three P2s are operational rather than exploitable: one leaves a single
process stuck after a hostile header, one can ship a stale install pin, and one
leaves a credential on disk after the user asked to remove it. The P3s are
cache-key, hygiene, robustness, and documentation issues.

## Test gaps

- `packages/abler-mcp/test/integration.test.ts:540` and `:550` give the
  subprocess 2 s to start Bun and print `FETCH_STARTED`, then require exit
  within 1 s of SIGTERM. Both are wall-clock windows on a loaded CI runner and
  are the most likely source of a spurious red build.
- The oversized `Retry-After` regression (`integration.test.ts:1236`) never
  advances time or retries the originating client, so the P2 above passes it.
- `tooling/release/release.test.mjs:17` runs one package's synchronizer at a
  time and asserts on the root README after each; the concurrent Turbo path
  that loses updates is untested.
- Nothing asserts that `auth logout` leaves no `.pending` candidate, or that
  a candidate is ever aged out.
- No Abler test streams a body larger than a limit through `AblerClient`; the
  loopback case only proves non-JSON rejection.
- The InfoMentor schema tests use synthetic fixtures with exactly the four
  known notification states and non-null timetable and message fields. A
  fixture with an unknown `state` or a `null` `establishmentName` would show
  whether one odd item hides a whole feed (see residual risks).
- Cache-key regression coverage stops at `test`, `typecheck`, and `lint`;
  `release:check` has no scratch-copy hash assertion.
- Windows branches in session-store remain unexecuted anywhere; the README
  says unsupported, which is the right claim.

## Residual risks

- Live upstream shapes are unverified in this review. Closed enums and
  required strings in `packages/infomentor-mcp/src/session.ts:230` and the
  timetable, message, and notification schemas mean one unexpected value
  (a new notification `state`, a `null` display name) makes the entire
  `infomentor_get_notifications` or `infomentor_collect_updates` result
  unavailable rather than one item. This is a robustness risk with no observed
  failure; per-item tolerance would narrow the blast radius.
- `SafeError` is a trust boundary by convention: every message passed to it
  must stay a reviewed literal. A future `new SafeError(upstreamText)` would
  leak silently; a lint rule restricting the constructor argument to string
  literals would make the boundary mechanical.
- The install script is fetched from a tag URL on `raw.githubusercontent.com`
  and the archive and checksum come from the same GitHub release; a moved tag
  or a compromised release publishes both halves together. Signed checksums or
  a pinned digest in the README would close this.
- `requireSameAccount` allows replacement when the existing session file is
  unreadable (wrong mode, hard link, or too large), not only when it is missing
  or legacy. The README states the refusal unconditionally.
- The Abler `.pending` recovery path and the InfoMentor local form both print a
  path or URL to stderr that other same-user processes can read; the threat
  model already excludes same-user attackers, and the account check limits the
  form's blast radius.
- Native evidence is darwin-arm64 only (Bun 1.4.2). Hosted CI on the four
  runners, public artifacts, and real MCP hosts were not exercised here.
- The WARP integration was reviewed as shell source only; its pinned `.deb`
  digest, root helper, and `sudo -n` launcher behaviour on a real Debian 13
  host were not verified.

## Prior findings verified at HEAD

| Report | Finding | Status at 02f7de5 | Evidence |
| --- | --- | --- | --- |
| phase3b-review | P0 compiled binary crashes on `packageVersion` | Fixed | `server.ts:5` imports `package.json` with `type: 'json'` (bundled); forced `test:binary` built both binaries and `--version` matched. |
| phase3b-review | P1 unknown errors leak tokens | Fixed | `mcp-runtime/src/index.ts:32-37` returns fixed text unless `SafeError`; `test/index.test.ts:19` covers bearer, refresh token, cookie header, URL-free body. |
| phase3b-review | P2 SIGTERM does not cancel Abler fetch or release lock | Fixed | `api.ts:179-202` lifecycle signal merged into lock wait and fetch; `startStdio` awaits `onClose`; test at `integration.test.ts:493` passed in both runs. |
| session-store-review | High: live holder expired by age | Fixed | `lock.ts:208` treats any live PID as busy; no mtime check remains; test `waiters poll ... a live PID never expires by age` passed. |
| session-store-review | Medium: refresh loop swallows non-ENOENT errors | Moot | The keepalive/refresh loop was removed; ownership is a static owner file. |
| session-store-review | Medium: hard links bypass the lock | Fixed | `lock.ts:145-156` and `files.ts:47-50` reject `nlink > 1`; two tests cover it. |
| session-store-review | Low: same-size mutation after handle check | Fixed | `files.ts:128-131` re-stats and compares inode, size, mtime; unit test for `fileChanged`. |
| session-store-review | Low: foreign-owner branch untested | Fixed | `files.test.ts:115` overrides `process.getuid` and asserts `UNSAFE_FILE`. |
| session-store-review | Low: LOCK_LOST only tested at release | Fixed (as far as applicable) | `lock.test.ts:232` replaces the owner mid-work and asserts `LOCK_LOST` without deleting the replacement; no refresh loop exists to test separately. |
| session-store-review | Low: Windows unverified | Open, documented | README calls Windows unsupported and unverified; no CI lane; both server READMEs repeat the caveat. |
| review-astra-1 | P2 shared sources missing from consumer cache keys | Fixed | `turbo.json` `^typecheck` edges; `release.test.mjs:191` regression passed; not re-probed beyond that. |
| review-astra-1 | P2 login deadline not applied during lock wait | Fixed | `login.ts:179-183` creates the deadline before the lock; test `login timeout includes session-lock contention` passed. |
| review-astra-1 | P2 cooldown not bounded before serialization | Partial | `login.ts:212` clamps the saved value; in-memory deadline unbounded (P2 above). |
| review-astra-1 | P2 README promised family data is never returned | Fixed | `README.md:151-159` limits the promise to credentials and names the returned family data. |
| review-astra-1 | P3 removed build/test:dist commands in READMEs | Fixed | Both package READMEs now list `check`, `test`, `test:binary test:installer`; `git grep` finds `test:dist` only in `docs/analysis`. |
| review-astra-1 | P3 unsupported package-import instructions | Fixed | No `import ... from 'infomentor-mcp'` remains outside `docs/analysis`. |
| review-astra-1 | P3 root README pins not synchronized | Partial | `sync-version.mjs:25` includes the root README, but the concurrent rewrite loses updates (P2 above). |
| review-astra-2 | P2 moving capped cooldown deadline | Open, confirmed | Same instance as the first finding; independent numbers above. |
| review-astra-2 | P2 uncoordinated root README rewrites | Open, confirmed | 5 of 8 concurrent runs stale in an independent probe. |

## Validation

| Command or probe | Result |
| --- | --- |
| `bunx turbo run typecheck lint format:check test --force` | Passed: 20 of 20 tasks, 0 cached, default Bun 1.2.19, Node 24.12.0. Tests: mcp-runtime 1, session-store 13, Abler 11, InfoMentor 20, release tooling 2. |
| `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test:binary test:installer --force` | Passed: 6 of 6 tasks, 0 cached, Bun 1.4.2, fresh darwin-arm64 builds of both packages. Both MCP smokes (6 and 7 tools), both 12-case piped installer matrices, truncation checks, real-archive installs, checksum rejection, and installed-binary smokes passed. |
| In-memory cooldown probe (injected 429, `Retry-After: 9999999999999`) | Same client: `retryAfterMs` 9999999999999000 then 9999999999998996 with one upstream call; fresh client: 3599999. |
| Concurrent `sync-version` probe (archived copy, Abler bumped to 0.3.2) | Root Abler pin stale in 5 of 8 concurrent runs; sequential runs correct. |
| `release:check` cache-key probe (archived copy, `--dry=json`) | Both server `release:check` hashes unchanged after editing the root README; `//#format:root:check` also unchanged (expected). |
| Lock sweep probe (waiter age simulated with `utimes`) | Holder's `sweepTemp` removed the waiter's temporary; waiter failed with `IO`/`ENOENT` instead of `BUSY`. |
| `git diff --stat 4317dde..02f7de5` | Only `docs/analysis/review-astra-2.md` changed. |
| Secret scan of tracked files | No session, cookie, credential, or kennitala-like values outside synthetic test fixtures; `.gitignore` covers `*session*.json`, `*.pending`, `*.tmp`, `*.lock/`, `.env*`. |
