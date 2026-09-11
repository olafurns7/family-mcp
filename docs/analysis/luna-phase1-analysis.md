# Luna phase 1: analysis of abler-mcp and infomentor-mcp

Written 2026-09-11 against commit `7deb778` on `main`. Every `file:line` reference below was
re-checked against that commit (the Abler quote-style reformat in `732a8a8` did not move any
line). Path shorthand: `abler/` = `packages/abler-mcp/`, `info/` = `packages/infomentor-mcp/`.

Method and limits:

- Read every file in both packages: `src`, `test`, `scripts`, `docs`, `install.sh`, workflows,
  `package.json`, lint/format/TS configs, and the vendored lint plugin's provenance.
- Ran `tsc --noEmit` for both packages (read-only): both pass under the shared base config,
  which already enables `exactOptionalPropertyTypes` (`tooling/tsconfig/base.json`, commit `60e687b`).
- Inspected the installed SDKs directly: `@modelcontextprotocol/server@2.0.0`, `client@2.0.0`,
  `core@2.0.0` (`.d.mts` declarations), `@modelcontextprotocol/sdk@1.30.0`, and
  `proper-lockfile@4.1.2`; cross-checked the v2 API with the upstream migration guide via
  context7 (`/modelcontextprotocol/typescript-sdk`, `docs/migration/upgrade-to-v2.md`) and Bun's
  executables documentation.
- Did not run either test suite (infomentor's `test` script writes `dist/` and `.test-build/`;
  this task was limited to `docs/analysis/`). Terra's report (`docs/analysis/terra-phase1-report.md`)
  records both suites passing at `7b6c315`: 8 Abler tests, 15 InfoMentor tests including subtests.
- No live accounts, no packaging, no network calls to Abler or InfoMentor.

Both session files are equivalent to the parent's login to a child's school or sports system.
Every finding is weighed through that lens.

---

## 1. Per-package review

### 1.1 abler-mcp 0.3.1

**Architecture.** Four source files, 789 LOC, on `@modelcontextprotocol/server` v2.

| File | LOC | Role |
| --- | ---: | --- |
| `abler/src/cli.ts` | 98 | `serve` → `serveStdio(() => createServer())` (`cli.ts:51`); `auth capture / import / status / logout`. Import verifies a `.pending` candidate under the destination lock and renames only on success (`cli.ts:73-86`). |
| `abler/src/server.ts` | 105 | Six read tools on `McpServer`; `result()` wrapper turns thrown errors into `isError` text (`server.ts:8-28`); `ZodError` collapsed to a generic message (`:19-20`). No `outputSchema` / `structuredContent`. |
| `abler/src/auth.ts` | 251 | XDG session path (`:13-17`), `withSessionLock` on proper-lockfile (`:20-41`), cookie import and validation (`:61-101`), guarded load with `O_NOFOLLOW`, regular-file and mode checks (`:103-131`), atomic 0600 save with `fsync` (`:133-169`), Chrome DevTools Protocol capture over a loopback WebSocket (`:172-251`). |
| `abler/src/api.ts` | 335 | `AblerClient`: GraphQL over `fetch` to `https://www.abler.io` only, `redirect: 'error'`, 20 s timeout (`:125-135`); refresh via `POST /oauth/token` when `id_token` is missing or has < 60 s TTL (`:175`); one retry on 401 / `UNAUTHENTICATED` (`:179-187`); rotated cookies persisted on every `Set-Cookie` while the lock is held (`:140-148`). The constructor's `request` parameter is the test seam (`:111`). |

Runtime targets: Node ≥ 22 (npm tarball, `dist/cli.js` with a node shebang) and a Bun single-file
executable (`abler/scripts/build-native.sh`).

**Tool surface.** All six tools carry `readOnlyHint`, `idempotentHint`, `openWorldHint`
(`server.ts:38-43`). Authentication is CLI-only; no tool mutates anything.

| Tool | Input | Returns |
| --- | --- | --- |
| `auth_status` | `{}` | `{ authenticated: true, account: { id, displayName } }` after a live `me` query (`api.ts:200-212`). |
| `get_profile` | `{}` | `{ id, displayName, children[], childNamesById }` (`api.ts:218-232`). |
| `list_groups` | `{}` | `userAgeGroups[]` forwarded as unvalidated records (`api.ts:243`). |
| `list_schedule` | `from, to, types, groupIds, participantIds, first, after` | `{ events[], pageInfo }`; core fields validated, all other upstream fields pass through (`api.ts:76-85`); stalled cursors rejected (`:271-275`). |
| `list_child_schedules` | `from, to, types, groupIds, first, childIds, afterByChild` | `{ children: [{ child, events[{ …, attendance }], pageInfo }] }`; one upstream page per child with the participant filter, attendance narrowed to that child (`api.ts:294-309`). |
| `get_event` | `eventId, ageGroupId` | One event; identity mismatch rejected (`api.ts:326-331`). |

**Auth and session flow.**

1. Acquire a session with `auth capture URL` (CDP `Network.getCookies` for two Abler URLs; loopback
   only; the WebSocket host must equal the HTTP host, `auth.ts:172-205`) or `auth import FILE|-`.
   Only `refreshToken` and `id_token` survive; they are re-homed as Secure + HttpOnly host-only
   cookies for `www.abler.io` (`auth.ts:61-101`).
2. Verify-then-commit: under the destination lock, write a `.pending` file (0600), run
   `status(true)` which forces a refresh (rotating the token upstream), rename on success; on
   failure keep both the previous file and the candidate (`cli.ts:73-86`, tested at
   `abler/test/integration.test.ts:470-516`).
3. Every tool call: `withSessionLock` → `loadSession` → refresh if needed → query → save on any
   `Set-Cookie` → release (`api.ts:114-116`). The lock is held across all network I/O.
4. `auth logout` is lock + `rm` (`auth.ts:43-45`).

**Error handling.** Every message is a literal or contains only an operation name, HTTP status or
a local path (`api.ts:137,156,188,193`); upstream bodies are never echoed (`api.ts:190-194`); the
CLI prints `error.message` only (`cli.ts:96`). Weak spots:

- The `serveStdio` handle is discarded (`cli.ts:51`): no SIGINT/SIGTERM close. The v2 fixtures
  recommend `handle.close()` on signals; the transport still closes on stdin EOF, so this is
  cosmetic for MCP hosts and matters only for interactive runs.
- proper-lockfile's default `onCompromised` throws inside its refresh timer
  (`node_modules/proper-lockfile/lib/lockfile.js:213`). If `session.json.lock` is removed or its
  mtime cannot be refreshed while a request is in flight, the process dies with an uncaught
  exception. The README tells users not to remove an active lock (`abler/README.md:117,206`) but
  nothing catches the failure.
- Usage errors are thrown as `new Error(help)` (`cli.ts:54,92`), so the full help text lands on
  stderr with exit 1. Harmless, but not an error message.

**Test coverage honesty.** 8 tests, 81 `expect()` calls (terra's run), plus `test/pack-smoke.ts`
which is not a `bun test` file and runs only in CI.

Real: Bun `fetch`, `Set-Cookie` parsing and the file lock across three real processes against a
loopback `Bun.serve` upstream (`integration.test.ts:348-435`); a real stdio MCP handshake by
spawning `bun src/cli.ts` with the v2 client (`:195-230`); a real WebSocket CDP mock (`:150-193`);
a real `/bin/sh install.sh` with fake `curl`/`uname`/`mv` but real `tar` and `sha256sum` across 12
failure modes (`abler/test/install.test.ts:10-158`); a real CLI subprocess for the failed-import
path (`integration.test.ts:491-513`); real permission and symlink rejection (`:443-448`).

Mocked: the injected `request` function for the API tests, so GraphQL semantics are asserted
against hand-written JSON.

Not exercised: `groups()` / `list_groups` success path (only present in the `listTools` name list,
`:212`); `event()` success path (only the mismatch case, `:461-464`); `auth capture`, `auth status`
and `auth logout` through the CLI (the functions are tested directly); `--help`/`--version` (only
in pack-smoke); proper-lockfile stale recovery and the compromised-lock path; the API client under
Node (only the stdio handshake of `dist/cli.js` runs under Node, via pack-smoke in
`.github/workflows/ci.yml`).

**Notable bugs and smells.**

1. Unbounded lock hold versus a 30 s wait: `childSchedules` performs 1 + N requests, each up to
   20 s, under one lock (`api.ts:279-312`), while a second process retries for at most 30 × 1 s
   (`auth.ts:29`) and then fails "busy". The README states the 30 s rule (`README.md:117`) but not
   the consequence for a scheduled reporter colliding with an interactive host.
2. Compromised-lock crash (above), `auth.ts:25-30`.
3. Passthrough outputs: `eventSchema.passthrough()` (`api.ts:85`) and the unvalidated
   `list_groups` payload (`api.ts:243`) forward every upstream field to the model. Documented as
   untrusted data, but unbounded.
4. Orphan `*.tmp` on SIGKILL between `open` and `rename` (`auth.ts:156-168`); never swept.
   `.gitignore:11` covering `*.tmp` suggests the author has seen them.
5. `saveSession` fsyncs the file (`auth.ts:161`) but not the directory; rename durability on
   power loss is not guaranteed. Minor.
6. `build-native.sh:9` appends `-baseline` for x64. Bun's executables documentation now states the
   `-baseline`/`-modern` suffixes "are still accepted for backward compatibility and resolve to the
   same binary" (x64 builds target Nehalem and select AVX2 paths at runtime). The line is a no-op,
   not a bug.
7. The npm tarball ships `docs/` (maintainer guides plus the 701-line
   `THIRD_PARTY_NOTICES.txt`, `package.json` `files`). Harmless bloat; the notices file is also
   hand-maintained (infomentor generates its equivalent at build time).

**Contradictions with its own docs.**

- `abler/docs/REVIEW.md:1` reviews "0.3.0" while the package is 0.3.1; `:23` cites "7 tests, 105
  assertions … Bun 1.2.19" whereas the suite is now 8 tests and Bun is pinned to 1.4.2
  (`package.json` `packageManager`). `:41` "exactly the ten allowed package files" cannot be
  verified without packing; with the notices file it is likely eleven.
- `abler/README.md:215` says maintainers need "Node.js 22.12+" while `engines` says `>=22`.
- README (`:5-58`) and `docs/AGENTS.md` (`:6-74`) duplicate install and host-config text, each
  pinning `v0.3.1` URLs that the monorepo will change; `docs/PUBLISHING.md:14-16` lists four places
  to bump by hand, of which only `install.sh` is checked by a test (`install.test.ts:15,31`).

### 1.2 infomentor-mcp 0.5.0

**Architecture.** Ten source files, 2,709 LOC; 1,523 LOC of tests; on `@modelcontextprotocol/sdk`
v1.30. Unlike abler it is also a published TypeScript library (`main`/`types`/`exports`,
`info/src/index.ts`).

| File | LOC | Role |
| --- | ---: | --- |
| `info/src/cli.ts` | 208 | argv; `serve` → `McpServer.connect(new StdioServerTransport())` with stop on stdin EOF / SIGINT / SIGTERM (`:94-104`); `login` (env secrets, `--credentials`, `--local-form`, `--import`), `status`, `logout`. Human output on stderr. |
| `info/src/server.ts` | 191 | Eleven tools, each with `inputSchema` and `outputSchema`, returning `structuredContent` (`:38`); `result()` maps `InfoMentorError.message` or a generic string (`:32-47`); `server.server.onclose` closes the client (`:59-61`). |
| `info/src/client.ts` | 535 | `InfoMentorClient`: per-connection queue plus cross-process lock (`:98,111`); re-verifies authentication and re-reads the parent bootstrap on every read (`:123-124`); account-ID pinning (`:126-130`); one-shot renewal with configured credentials (`:137-170`); setup state machine (`:414-507`); logout (`:508-527`). |
| `info/src/http.ts` | 389 | `fetch` with `redirect: 'manual'`, ≤ 10 hops, `trustedUrl` on every hop (`:77-127`), 30 s deadline (`:70`), 8 MiB body cap (`:310-337`), 429 cooldown (`:129-147`), Cloudflare-challenge detection (`:152-160`); `parseParent` extracts `IMHome.home.homeData` JSON without `eval` (`:350-389`); child switch via a validated `/Account/PupilSwitcher/SwitchPupil/<n>` link (`:254-283`). |
| `info/src/login.ts` | 190 | ASP.NET form login, OpenID relay, `isauthenticated` check (`:27-85`); credential precedence `credentialsFile` → env → `localForm` → error (`:110-134`). |
| `info/src/credentials.ts` | 200 | 0600-checked JSON credentials file ≤ 16 KiB (`:14-53`); loopback HTML form with random path, CSRF token, Origin/Host checks and CSP (`:56-200`), auto-opened via `open`/`xdg-open`/`rundll32`. |
| `info/src/session.ts` | 302 | `InfoMentorError` and codes; `trustedUrl` (`:45-68`); v2 session schema (cookies + `accountId` + `selectedChildId`); read/write (tmp + rename, 0600, 0700 dir, no fsync, `:246-294`); all output schemas. |
| `info/src/lock.ts` | 128 | Dependency-free directory lock: `<pid>-<uuid>` owner file, PID liveness, realpath'd path, fail-fast. |
| `info/src/collection.ts` | 522 | All-children scan with SHA-256 fingerprints; snapshots in `<session>.collections/` (0700/0600, 90-day retention); restores the original child in `finally` with a fresh 20 s signal (`:422-453`). |
| `info/src/index.ts` | 44 | Public API: `createServer`, `InfoMentorClient`, `login`, `importSession`, schemas and types. |

**Tool surface.** Eleven tools (`server.ts:63-188`).

| Tool | Input | Returns / side effects | Annotations |
| --- | --- | --- | --- |
| `infomentor_session_status` | `{}` | `{ authenticated, nextStep? }`; performs `isauthenticated` + parent read. | read-only |
| `infomentor_get_overview` | `{}` | `{ title, text (≤ 40 000 chars), truncated, retrievedAt, children[{ id, name, selected }], timetable[] \| null }`. | read-only |
| `infomentor_select_child` | `{ childId }` | The overview after switching the upstream selection; changes shared server-side session state. | `readOnlyHint: false` |
| `infomentor_get_messages` | `folder, search, page, pageSize` | `{ items[], more, page, pageSize, folder, retrievedAt }`. | read-only |
| `infomentor_get_message` | `{ id }` | `{ message { …, messageBodyPlainText, toUsers }, retrievedAt }`. | read-only |
| `infomentor_get_notifications` | `selectedChildOnly, includeCleared` | `{ notifications[], selectedChildOnly, includeCleared, retrievedAt }`. | read-only |
| `infomentor_collect_updates` | `cursor?, includeExisting, maxMessagePages` | `{ baseline, cursor, retrievedAt, children[], updates[], missing[] }`; switches children and restores; writes snapshot files. | `readOnlyHint: false` |
| `infomentor_login` | `importFile?, credentialsFile?, localForm?, timeoutSeconds` | Setup status; starts a background login or import; `localForm` opens a browser on the host. | destructive, not idempotent |
| `infomentor_setup_status` | `{}` | `{ state, operation?, message, loginUrl? }`. | local, read-only |
| `infomentor_cancel_setup` | `{}` | Setup status after cancellation. | local write |
| `infomentor_logout` | `{}` | `{ authenticated: false, nextStep }`; deletes the session file. | destructive |

**Auth and session flow.**

1. Login (`login.ts:155-162`): lock → fetch the login form → POST credentials to the form action,
   which must stay on the `im1.infomentor.is` origin (`:44-50`) → follow the relay form → check
   `isauthenticated` → read the parent page → `writeSession`. Password copies are blanked
   afterwards (`:59-60,138,151`); see §2 item 12 for why that is cosmetic.
2. Read (`client.ts:89-183`): queue → lock → `readSession` → reuse the `InfoMentorHttp` unless
   the file changed → `requireAuthentication` + `readParent` (two requests) → account check →
   save rotated cookies → the actual read → save again in `finally`.
3. Renewal: only on `LOGIN_REQUIRED` and only when credentials are configured on the process; the
   new login must return the same `currentUser.id` (`client.ts:156-160`), the previous child is
   re-selected, and the read is replayed once.
4. Import (`login.ts:177-190`): read a v2 session file, verify upstream, rewrite.
5. Logout (`client.ts:508-527`): cancel setup, drain the queue, lock + `rm`. Snapshots under
   `.collections` are kept.

**Error handling.** `InfoMentorError` with eleven codes; every message is a literal
(`session.ts:28` states the policy); upstream bodies and URLs are never forwarded, and tests assert
it (`info/test/integration.test.ts:535,566,861`). Smells: `readSnapshot` turns any I/O error into
"cursor invalid" (`collection.ts:215-217`), so a transient `EACCES` reads as an expired cursor;
`pruneSnapshots` swallows errors (documented, `:257-259`); `.catch(() => {})` on close
(`server.ts:60`) and the browser-opener `error` handler (`credentials.ts:186`) are acceptable.

**Test coverage honesty.** 15 tests including 7 subtests.

- Every upstream interaction is `mock.method(globalThis, 'fetch', …)`
  (`integration.test.ts:100,656,836,876,963`). No real socket, TLS, undici redirect or cookie
  behaviour is exercised; the `redirect: 'manual'` contract is asserted on the mock's arguments,
  never against a server.
- MCP runs in-process over `InMemoryTransport` (`:323`), not stdio. Stdio handshakes exist only in
  `info/scripts/package-smoke.mjs` (Node, installed `dist/cli.js`) and
  `info/scripts/test-installer.mjs` (Bun binary), which run in the CI package and standalone jobs,
  not in `bun run test`.
- The only real loopback traffic is the credential-form test (`:1001-1049`).
- The lock test spawns a real child for dead-owner recovery (`info/test/lock.test.ts:23`) but the
  "concurrent" contention is 12 promises in one process (`:59`); multi-process serialisation of
  rotating cookies, which abler tests, is not tested.
- Collection tests use a fully synthetic `CollectionSource` (`info/test/collection.test.ts:20-145`).
  The real wiring in `client.ts:230-279` (endpoint paths and field names) is covered only by the
  single `collect_updates` call in the integration test (`:591-613`) and the renewal test
  (`:738-747`).
- `mock.method(fs, 'writeFile')` + `syncBuiltinESMExports()` (`:914-927`) and
  `mock.method(childProcess, 'spawn')` (`:1004`) are Node-runner specific.
- Not exercised: `readSession` on world-readable or symlinked files (no check exists); the 8 MiB
  HTTP body cap (only the collection output cap, `collection.test.ts:291-298`); `Retry-After` as an
  HTTP date (`http.ts:137-138`; only the integer form at `integration.test.ts:849`); `parseParent`
  against a missing or malformed bootstrap; the form's 413 and CSRF-mismatch branches
  (`credentials.ts:108-123`); CLI argument handling (`cli.ts:34-90`; only `--version`/`--help` via
  package-smoke); the WARP scripts beyond fake `sudo`/`id` (`test-installer.mjs:62-123`); the
  Windows branches in `lock.ts`.

**Notable bugs and smells.**

1. No ownership, mode or symlink check when reading the session file (`session.ts:246-258`) or an
   import file (`login.ts:184`), unlike the credentials file (`credentials.ts:23-27`) and unlike
   abler (`auth.ts:106-111`). See §2 item 2.
2. `writeSession` and `saveSnapshot` never `fsync` (`session.ts:285-287`, `collection.ts:239-241`).
   Power loss after the rename can leave an empty or partial `session.json`, which surfaces as
   `INVALID_SESSION` and forces a login (or a renewal when credentials are configured). Low.
3. The lock is fail-fast: three immediate attempts, then `OPERATION_IN_PROGRESS`
   (`lock.ts:53-116`). A five-minute `collect_updates` (`client.ts:227`) in one process makes every
   read in another process fail instantly with "Retry after its operation finishes"
   (`lock.ts:6-10`). Inside one process the queue hides this; a scheduled collector plus an
   interactive host on one machine will collide often. Abler waits up to 30 s.
4. PID-reuse false-busy: a crashed owner's PID reused by any long-lived process keeps the lock
   busy until that process exits (`lock.ts:104-108`, "reused PIDs fail safely closed"). No manual
   recovery is documented.
5. Every read costs two extra requests (`client.ts:123-124`); `infomentor_session_status` alone
   is two requests, and `collect_updates` adds parent reads per child (`collection.ts:333,410,413`).
   Deliberate (account pinning), but a parent-page cache scoped to one lock hold would halve
   traffic.
6. Persisted cookies are every cookie in the jar for `*.infomentor.is` (`session.ts:83,227-233`),
   not only authentication cookies; abler whitelists two names (`auth.ts:12,134-135`). Harmless,
   but the file grows with whatever the site sets.
7. Orphans on SIGKILL: `session.json.<uuid>.tmp` (`session.ts:282`),
   `.collections/<cursor>.json.<uuid>.tmp` (`collection.ts:236`) and `session.json.lock.<owner>.tmp`
   directories (`lock.ts:45-48`); never swept.
8. The 429 cooldown lives in the `InfoMentorHttp` instance (`http.ts:54,141`); a restarted process,
   a second process, or a session-file change that rebuilds the instance (`client.ts:114-118`)
   retries immediately.
9. `index.ts:1` exports `createServer`, whose return type is the v1 `McpServer`, so the SDK is part
   of the public library API (relevant to §4).
10. `info/.github/workflows/release.yml` is stranded: GitHub only discovers workflows under the
    repository root, and it still assumes the old layout (`uses: ./.github/workflows/ci.yml` at
    `:26`, the `INFOMENTOR_VERSION` install-pin check at `:22`). Terra's report notes the same.
11. An empty, untracked `info/tools/` directory remains after the anti-slop plugin moved to
    `tooling/oxlint-anti-slop` (commit `7e10cf3`).

**Contradictions with its own docs.**

- `info/docs/REVIEW.md:188` says "Collection and renewal live validation is in progress" while
  `:47-56` of the same file describes that live validation as completed on the VM.
- `info/docs/RELEASING.md:18,51` still use `v0.2.0` and `infomentor-mcp-0.2.0.tgz` as examples at
  version 0.5.0.
- `info/.gitignore:6-8` keeps Playwright-era entries (`playwright-report/`, `test-results/`,
  `.auth/`) although Playwright was removed in 0.2.0 (`docs/REVIEW.md:132-135`).
- `info/README.md:77-78` presents the npm package as usable on Windows; `lock.ts` has Windows
  branches (`:72-73,91`) but nothing has run on Windows, and `README.md:340` defers permissions to
  ACLs. "Unverified" would be accurate.
- `info/docs/HTTP-AUTH.md:48-51` cites "Abler MCP" as the reference for the renewal policy: the two
  packages were already designed together, which strengthens the shared-store case in §3.

---

## 2. Security pass

Ranked by severity. "Both" means the same pattern exists in both packages.

| # | Severity | Package | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | Medium | infomentor | Session-mutating tools are reachable by the model. `infomentor_logout`, `infomentor_login` (host-path `credentialsFile` / `importFile`, and `localForm`, which opens a browser on the host), `infomentor_select_child` (changes shared upstream state) and `infomentor_collect_updates` (writes snapshots) are all callable by an agent that has just ingested untrusted school text. The `instructions` string (`server.ts:53-54`) is guidance, not enforcement. A prompt-injected agent can log the parent out (forcing re-entry of secrets), trigger a credential form popup, or flip the selected child so later reads describe the wrong kid. Abler keeps authentication CLI-only. | `info/src/server.ts:140-188` | Gate `login`/`logout` (and `localForm`) behind an explicit opt-in such as `--allow-setup-tools`; keep `select_child` but say in its description that reads after it are context-dependent. `destructiveHint` alone is not a control. |
| 2 | Medium | infomentor | The session file is read without ownership, mode or symlink checks; a copy transferred with `0644` or a symlink is accepted silently. The credentials file is checked; abler refuses both cases. | `info/src/session.ts:246-258`, `login.ts:184` vs `credentials.ts:23-27`, `abler/src/auth.ts:106-111` | Reuse abler's guarded open (`O_NOFOLLOW`, `isFile`, `mode & 0o077 === 0`); first deliverable of the shared session store (§3.1). |
| 3 | Medium (opt-in) | infomentor | Root execution from a `curl \| sh` install. `install.sh --with-warp` runs `sudo sh <archive>/libexec/warp.sh install` (`install.sh:51-55`): a script from the downloaded archive, verified only by a SHA-256 published on the same release, runs as root, installs a pinned `.deb` (`warp.sh:80-88`, checksum verified), adds `ip rule`s and a systemd unit (`warp.sh:23,94-112`). `warp-launcher.sh:8` runs `sudo -n … start` on every MCP launch when the tunnel is unhealthy, so the MCP host's process path escalates. Documented as opt-in (`README.md:45-66`). | `info/install.sh:49-57`, `info/scripts/warp-launcher.sh:7-12`, `info/scripts/warp.sh` | Keep it opt-in; sign release assets (item 4); move WARP setup out of the MCP installer into a separate, separately documented admin script; never call `sudo` from the launcher (fail with instructions instead). |
| 4 | Medium | both | Release integrity is checksum-only: the archive and its `.sha256` come from the same GitHub release, and the downloaded binary is executed (`--version`) before it is installed. This defends against corruption and truncation, not against a compromised GitHub account or CI runner. | `abler/install.sh:43-49,60`; `info/install.sh:25-34,39` | Publish provenance (`actions/attest-build-provenance` and verify with `gh attestation verify` when available) or a minisign signature; verify in `install.sh` when the tool exists, otherwise warn. |
| 5 | Low | abler | A failed import keeps a `.pending` candidate holding a possibly rotated refresh token beside the session (0600). Documented (`README.md:112,209`) and tested (`integration.test.ts:470-516`), but there is no expiry or cleanup, so candidates accumulate. | `abler/src/cli.ts:74-85` | Prune candidates on a later successful import; add an `auth logout --all`. |
| 6 | Low | both | Temp-file orphans after a hard crash. All are 0600, but they hold credentials outside the documented file. | `abler/src/auth.ts:156-168`; `info/src/session.ts:282-293`, `collection.ts:236-244`, `lock.ts:45-48` | Sweep `<session>.*.tmp` and `.lock.*.tmp` older than a few minutes under the lock. |
| 7 | Low | abler | proper-lockfile "compromised" handler defaults to `throw` in a timer: removing the lock directory during a request kills the MCP process with an uncaught exception. No secret leaks (stack only). | `abler/src/auth.ts:25-30`; `node_modules/proper-lockfile/lib/lockfile.js:213` | Pass `onCompromised` that fails the current operation, or replace the lock (§3.1). |
| 8 | Low (opt-in) | infomentor | `localForm` login can be hijacked by any local process that learns the URL: it is printed on stderr (`cli.ts:143-147`) and returned via `infomentor_setup_status.loginUrl`; a `GET` yields the CSRF token, and a `POST` with attacker-chosen credentials is accepted (`credentials.ts:66-145`). An explicit login has no previous-account check (only renewal does, `client.ts:156-160`), so the MCP silently switches to the attacker's account. Same-computer only. | `info/src/credentials.ts:56-200` | Refuse to replace a session whose `accountId` differs unless the caller passes `allowAccountChange`; stop exposing `loginUrl` through MCP (stderr is enough). |
| 9 | Low | infomentor | Collection snapshots (`<session>.collections/*.json`: fingerprints, message IDs, child IDs, folder names) survive logout for up to 90 days. Metadata, not content, and documented (`README.md:297-298`). | `info/src/client.ts:517-519`, `collection.ts:129` | Remove the directory on logout. |
| 10 | Low | infomentor | The 429 cooldown is per process, so several scheduled processes can ignore InfoMentor's `Retry-After`. | `info/src/http.ts:54,141` | Persist `retryAfter` next to the session under the lock. |
| 11 | Low | infomentor | `install.sh` executes top-level statements while `curl \| sh` is still streaming; abler wraps everything in `main()` invoked on the last line so a truncated download cannot run a partial script. | `info/install.sh:1-65` vs `abler/install.sh:5,78` | Same wrapper. Also prefer single-member extraction (`tar -xOzf … member > file`, `abler/install.sh:58`) over `tar -xzf` of the whole archive (`info/install.sh:38`); the path check at `:36-37` inspects names, not member types. |
| 12 | Info | both | Secrets in logs, errors and tool outputs: verified clean. Abler messages are literals (`api.ts:137-194`, `auth.ts:33-129`), the CLI prints messages only (`cli.ts:96`), and tests assert that rotated tokens and upstream messages never appear (`integration.test.ts:111,131,502`). Infomentor never forwards upstream bodies or URLs (`session.ts:28`, `http.ts:110-188`) and tests assert no password in status, file or output (`integration.test.ts:357,366,795`) and no upstream values (`:535,566,861`). `no-console` is enforced outside the CLIs by the root lint config. Passwords stay in `process.env` for the process lifetime by design (`login.ts:113-118`), and blanking string copies (`login.ts:59-60,138,151`) cannot zero JavaScript strings; document that rather than rely on it. | | |
| 13 | Info | both | Network egress. Abler: only `https://www.abler.io/{oauth/token,graphql}` with `redirect: 'error'` (`api.ts:125-127`) plus loopback CDP (`auth.ts:174-181`). Infomentor: only `https://*.infomentor.is` on every hop (`session.ts:45-68`, `http.ts:115`); `Referer`/`Origin` carry only the previous InfoMentor URL (`http.ts:82,92`); the loopback form; `open`/`xdg-open` spawned with a loopback URL (`credentials.ts:179-184`); the WARP launcher routes via `HTTPS_PROXY=http://127.0.0.1:18443` (`warp-launcher.sh:13`). No telemetry in either. | | |
| 14 | Info | both | Cookie jars. Abler re-homes imported cookies as Secure + HttpOnly host-only for `www.abler.io` and forces `secure` on response cookies (`auth.ts:82-93`, `api.ts:143`); it persists only `id_token` and `refreshToken`. Infomentor keeps the jar as received, ignores malformed `Set-Cookie` (`http.ts:103`), restricts persisted domains to `infomentor.is` (`session.ts:83`), and drops empty deletion cookies (`session.ts:232`). | | |
| 15 | Info | both | MCP tool outputs. Infomentor outputs pass strict zod output schemas, so unknown upstream keys are stripped (`switchPupilUrl` never leaves the process; `integration.test.ts:439`). Abler forwards unknown upstream fields (`api.ts:85,243`): untrusted text reaches the model unfiltered by design, and the `list_groups` payload is entirely unvalidated. | | Add output schemas to abler (§7). |
| 16 | Info | both | Installers: HTTPS-only `curl` (`--proto '=https' --tlsv1.2`), no `PATH` or shell-rc edits, atomic replace, previous install preserved on failure (tested: `install.test.ts`, `test-installer.mjs:125-132`). Infomentor honours `INFOMENTOR_VERSION` from the environment (`install.sh:4,8`), charset-validated before use in the URL. Both CI workflows pin actions by SHA. Abler's capture flow relies on a Chrome debugging port; the README correctly requires a separate profile bound to loopback and closing it afterwards (`README.md:67-85`). | | |

---

## 3. Shared-package candidates

| Candidate | Would move | API | Extraction risk | Verdict |
| --- | --- | --- | --- | --- |
| `@family-mcp/session-store` | abler `auth.ts:20-45` (lock, remove; 26 LOC), `auth.ts:103-168` (guarded load, atomic save; 66). infomentor `lock.ts` (128), `session.ts:246-294` (49), `credentials.ts:14-53` (40), `collection.ts:220-245` (26). ≈ 335 LOC today → ≈ 200 shared, plus `info/test/lock.test.ts` (160) and abler's three-process test (`integration.test.ts:348-435`) as the acceptance suite. | `withFileLock(path, { signal?, waitMs? })`; `readPrivateFile(path, { maxBytes })` (`O_NOFOLLOW`, regular file, no group/other bits); `writePrivateFile(path, data, { fsync: true })` (`wx` 0600 temp + fsync + rename); `ensurePrivateDir(path)`; `sweepTemp(path)`. | Medium. The two locks differ: proper-lockfile = mtime-stale after 120 s, bounded 30 s wait, self-heals after PID reuse, crashes on compromise, external dependency. Hand-rolled = PID liveness, immediate failure, symlink-safe, dependency-free, false-busy on PID reuse. Whichever base wins, abler's README promises (`:117,206`) must be re-worded. | **Yes.** Highest security value: one audited implementation instead of two. Base it on infomentor's lock (no dependency, tested), add an optional bounded wait (poll every 250 ms up to `waitMs`) to keep abler's behaviour, and an owner-file mtime fallback to bound the PID-reuse case. |
| `@family-mcp/mcp-runtime` | abler `server.ts:8-28,38-43` + `cli.ts:51` (≈ 30). infomentor `server.ts:23-47` + `cli.ts:91-107` (≈ 45). ≈ 40 LOC after dedup. | `toolResult(work, { onUnknownError })`; `READ_ONLY` / `LOCAL_WRITE` annotation presets; `startStdio(factory, { onClose })` handling signals and stdin EOF; `packageVersion(import.meta.url)`. | Low technically, but blocked until infomentor is on v2: `CallToolResult`, `ToolAnnotations` and the handler context type differ between SDK generations. | **Yes, but small and only after §4.** Its value is enforcing conventions (always `outputSchema` + `structuredContent`; one redaction policy), not code volume. Do not create it for two SDK generations. |
| `@family-mcp/http-client` | abler `api.ts:118-150` (cookie-jar ↔ fetch glue; 33). infomentor `http.ts:53-191` (139) + `readBody` (`:310-337`, 28). Genuinely shareable: jar glue (≈ 15), abort/timeout composition (≈ 5), `Retry-After` parsing (≈ 15), body cap (≈ 25). ≈ 60 LOC. | `cookieFetch(jar, url, init)`, `withDeadline(signal, ms)`, `parseRetryAfter(header)`, `readBounded(response, maxBytes)`. | Medium: the two transports are different animals (GraphQL JSON with `redirect: 'error'` versus ASP.NET forms with manual redirects and HTML scraping). | **No, not now.** A 60-line helper does not earn a package. Write the shared rules down (never echo upstream bodies; cap bodies; honour `Retry-After`) and copy `readBounded` into abler if wanted. Revisit if a third scraping server appears. |
| `@family-mcp/release-tooling` (root `tooling/release/`, private) | Build: `abler/scripts/build-native.sh` (22) vs `info/scripts/build-binary.mjs` (119: Bun-version pin, metafile-driven notices). Installer: `abler/install.sh` (78) vs `info/install.sh` (65), ≈ 80 % identical logic. Installer tests: `abler/test/install.test.ts` (158, 12 failure modes with fake `curl`/`uname`/`mv`) vs `info/scripts/test-installer.mjs` (160, real archive, checksum rejection, reinstall, binary handshake). MCP smoke: `abler/test/pack-smoke.ts` (68) vs `info/scripts/package-smoke.mjs` (136: pack allowlist, install, CLI, handshake, consumer types, publish dry-run) + `test-installer.mjs:134-153`. Notices: adopt infomentor's generator; delete abler's committed 701-line file. ≈ 600 LOC → ≈ 350 shared. | `build-binary.mjs --package <dir>` (adds `--sourcemap` and the `--no-compile-autoload-*` flags from both, per-package extra files and `libexec` hooks); `render-install.sh --package <dir>` from one template (abler's `main()` wrapper and single-member extraction, infomentor's versioned dirs, symlink, `<NAME>_VERSION` override and optional post-install hook); `installer-test.mjs` with both fixture modes; `mcp-smoke.mjs --bin … --expect-tools …` using the v2 client (it speaks to a v1 server over stdio without changes). | Low to medium: user-facing installers, so keep both test harness modes green; needs the URL scheme from §6 first. | **Yes.** Best value for effort and independent of the SDK split. |
| `@family-mcp/config-paths` | abler `auth.ts:13-17` (XDG); infomentor `session.ts:70-72` (`~/.infomentor-mcp`). | `defaultSessionPath(appName, { legacy })`. | Changing infomentor's default breaks existing installs. | **No.** Ten lines and a convention; if the session store exists, add the helper there and keep the legacy path as a fallback. |
| Shared test fixtures / fake upstreams | — | — | — | **No.** Different upstreams; nothing to share beyond the loopback-server pattern. |
| Root tsconfig, Oxc config, anti-slop plugin, root CI | Already extracted by terra (`60e687b`, `7e10cf3`, `7b6c315`). | | | Done. Delete the empty `info/tools/` directory. |

---

## 4. The SDK divergence

**Facts, verified against the installed packages and the upstream migration guide.**

- Installed: `@modelcontextprotocol/sdk@1.30.0` (infomentor); `@modelcontextprotocol/server@2.0.0`,
  `client@2.0.0`, `core@2.0.0` (abler). v2 requires `zod ^4.2.0` (`server/package.json`);
  infomentor already ships zod 4.6.2 and imports `zod`, whose root export is v4, so `zod` versus
  `zod/v4` (abler) is a style choice, not a blocker.
- v2 package split: `@modelcontextprotocol/server` (server, `InMemoryTransport`, and the types
  `CallToolResult`, `ToolAnnotations`, `ServerContext`, `Implementation` re-exported from the root;
  verified in `dist/index.d.mts`), `@modelcontextprotocol/server/stdio` for `StdioServerTransport`
  and `serveStdio(factory, options?) → StdioServerHandle { close() }` (synchronous return,
  `dist/stdio.d.mts`), `@modelcontextprotocol/client` (+ `/stdio` for `StdioClientTransport`), and
  `@modelcontextprotocol/core` for the raw zod `*Schema` constants.
- `registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, icons?,
  _meta? }, cb)` has the same config shape as v1.30 (`dist/createMcpHandler-*.d.mts:3300-3308`);
  `RegisteredTool` keeps `outputSchema` (`:3461-3475`). The handler is `(args, ctx: ServerContext)`
  and the abort signal moved: v1 `extra.signal` → v2 `ctx.mcpReq.signal` (`:2145`).
- `McpServer` still exposes `readonly server` (`:3177`) whose `Protocol` base has `onclose?`
  (`:2264`), so `server.server.onclose = …` keeps working; `McpServer.close()` exists (`:3215`);
  the constructor `(Implementation, { instructions?, capabilities? })` is unchanged
  (`:2762-2777`).
- `InMemoryTransport` is exported by both `server` and `client`; both halves of a linked pair
  must come from the same package (migration guide).
- The guide documents an upstream codemod (`@modelcontextprotocol/codemod`, v1-to-v2 import map)
  for the mechanical part.
- v2 deprecates `ctx.mcpReq.log`, `elicitInput` and `requestSampling` (2026-07-28 protocol);
  neither package uses them.

**Migration map for infomentor.**

| File | Lines | Change |
| --- | --- | --- |
| `info/package.json` | deps | `@modelcontextprotocol/sdk` → `@modelcontextprotocol/server ^2.0.0`; add dev `@modelcontextprotocol/client ^2.0.0` for tests and scripts. zod unchanged. |
| `info/src/server.ts` | `:2` | `import { McpServer } from '@modelcontextprotocol/server'`. |
| | `:3` | `import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server'`. |
| | `:72, 83, 94, 105, 116, 127, 138` | `(_, extra) => … extra.signal` → `(_, ctx) => … ctx.mcpReq.signal` (seven sites). |
| | `:59-61`, eleven `registerTool` configs | Unchanged. `result()` still returns `CallToolResult`, which remains assignable to the v2 callback's `CallToolResult \| InputRequiredResult`. |
| `info/src/cli.ts` | `:4` | `@modelcontextprotocol/server/stdio`. |
| | `:91-107` | Either keep `server.connect(new StdioServerTransport())` (still supported) or use `serveStdio(() => createServer(options))` and call `handle.close()` from the stop handler. |
| `info/src/index.ts` | `:1` | `createServer` now returns the v2 `McpServer`; consumers typed against the v1 SDK break. The package was never published to npm, so this is a changelog note. |
| `info/test/integration.test.ts` | `:10-11` | `import { Client, InMemoryTransport } from '@modelcontextprotocol/client'` (one package for the pair). `callTool`, `structuredContent`, `listTools` usage unchanged. |
| `info/scripts/package-smoke.mjs` | `:65-66` and the generated `check.mjs` string | `@modelcontextprotocol/client` and `@modelcontextprotocol/client/stdio`. |
| `info/scripts/test-installer.mjs` | `:16-17` | Same. |
| `info/README.md` | `:414-415` | Mention the SDK generation for library consumers. Notices regenerate automatically from the metafile. |

Estimate: six files, about 25 import and call-site lines plus seven signal sites; S (half a day)
with the existing 15 tests, `test:package` and `test:installer` as the regression net.

Risks:

1. 2.0.0 is a fresh major. Abler is the in-house proof that `serveStdio`, `registerTool` and
   annotations work, but abler uses neither `outputSchema` nor `structuredContent`, so infomentor
   would be the first package here to exercise v2 output validation. Re-run the integration test's
   `isError` and `structuredContent` assertions and confirm that error results without
   `structuredContent` are still accepted.
2. `serveStdio` pins one instance from the factory per connection; `createServer(options)` builds
   an `InfoMentorClient` per call, which is fine for stdio (one connection) as long as the factory
   stays cheap.
3. Anything that reads `extra.sessionId` or `extra.requestId` would move too; nothing here does.

**Recommendation and ordering.** Migrate infomentor to v2 now, and before any MCP-facing shared
code is written: a bootstrap package that has to serve two SDK generations would be two packages.
The release tooling (§3.4) and the session store (§3.1) touch no SDK code and can proceed in
parallel; the shared smoke harness does not have to wait either, because a v2 client already
exercises a v1 server over stdio.

---

## 5. Test strategy

**Intent behind infomentor's Node runner** (inferred; every commit message in the imported history
is a single line with no body):

- The first commit (`368f318`) already had `bun build ./test/integration.test.ts --target=node …
  && node --test`, while the package still used Playwright (removed in 0.2.0, commit `098adf1`;
  `info/docs/REVIEW.md:132-135`). Playwright and the `node:test` mocking facilities
  (`mock.method`, `syncBuiltinESMExports`) are Node-runner features, which is the most plausible
  original reason; the runner simply outlived Playwright.
- The npm distribution runs under Node: `start`/`login` run `node dist/cli.js`, `engines.node
  >= 22`, package-smoke spawns `process.execPath` (`package-smoke.mjs:73`), and
  `info/README.md:422-423` says "Node 22+ remains the runtime for the npm package and its checks".
- What the current `test` script actually guarantees: `bun run build` proves `tsc` emits; the tests
  are bundled from `src/` by Bun's bundler (`--packages=external`) and executed under Node. It
  therefore tests the TypeScript source under the Node runtime, not `dist/`, and not the Bun
  runtime that the standalone executable ships. `dist/` is exercised only by `test:package` (Node
  stdio handshake) and the Bun binary only by `test:installer` (handshake plus a missing-session
  status call).

**Coverage matrix today.**

| Layer | abler / Bun | abler / Node | infomentor / Node | infomentor / Bun |
| --- | --- | --- | --- | --- |
| Unit and integration logic | `bun test` (8 tests) | — | `node --test` (15 tests) | — |
| Real `fetch`, cookies, lock against a loopback upstream | Yes (`integration.test.ts:348-435`) | — | No (`fetch` is mocked everywhere) | — |
| Stdio MCP handshake | `bun src/cli.ts` in-suite (`:195-230`); binary via `pack-smoke --standalone` (CI) | Installed `dist/cli.js` via pack-smoke (CI) | Installed `dist/cli.js` via `package-smoke.mjs` (CI) | Binary via `test-installer.mjs` (CI) |
| Installer script | `install.test.ts` (in `bun test`) | — | `test-installer.mjs` (CI; needs `release/`) | same |

**Recommendation** (one runner, two runtime smokes; keeps the Node guarantee):

1. Unit and integration tests run with `bun test` in both packages (turbo `test`), asserting with
   `node:assert/strict` (both already do) so files stay runner-agnostic. Converting infomentor's
   three files is **M, not S**: the global mocks must become injection seams. `InfoMentorHttp`
   takes a `fetch` in its constructor (abler's pattern, `api.ts:111`) replacing the five
   `mock.method(globalThis, 'fetch')` sites; the cancel-at-commit test (`:914-927`) observes the
   `.tmp` file through a small hook on `writeSession` instead of patching `fs.writeFile`;
   `promptCredentials` takes an `openBrowser` callback instead of patching `child_process.spawn`
   (`:1004`). Side benefits: no `syncBuiltinESMExports`, and the anti-slop `no-module-mocking`
   rule is honoured in spirit as well as letter.
2. Keep exactly one Node smoke of the built `dist/cli.js` per package (pack-smoke,
   package-smoke) and one Bun-binary smoke (pack-smoke `--standalone`, test-installer), wired as
   turbo tasks `test:dist` (Node) and `test:binary` (Bun) and run in CI as today. These, not the
   unit runner, are the runtime guarantees.
3. Add a loopback real-HTTP fixture for the upstream client layer in both packages (abler has
   one, infomentor has none): a `node:http` or `Bun.serve` fake that serves the login form, the
   relay, 302/303/307 redirects, `Set-Cookie`, a 429 with `Retry-After`, and an oversized body.
   Run that one file under both runtimes through the two smoke tasks. This is where undici and
   Bun's `fetch` differ (`getSetCookie`, manual redirects, body cancellation) and where neither
   package has cross-runtime evidence today.
4. Do not run `node:test` files under Bun's compatibility layer and do not keep two unit runners.
5. `.test-build/` can disappear with the conversion; adjust `turbo.json`'s
   `infomentor-mcp#test` outputs accordingly.

---

## 6. Release and install design

**Current state.** Per-repository tags `vX.Y.Z`. Installers pin the version (`abler/install.sh:6`
hard-coded; `info/install.sh:4` environment-overridable) and download
`https://github.com/olafurns7/<repo>/releases/download/v<ver>/<name>-<ver>-<os>-<arch>.tar.gz`
(`abler/install.sh:42-44`; `info/install.sh:21`), while READMEs fetch `install.sh` from the tag.
A release means editing the version in three or four places (`abler/docs/PUBLISHING.md:14-16`;
`info/docs/RELEASING.md:6-7`), checked only by `abler/test/install.test.ts:15,31` and the stranded
`info/.github/workflows/release.yml:22`. Infomentor's release workflow (dispatch on a tag, verify
tag = `v<version>`, run CI, draft prerelease with `--verify-tag`) is not discoverable at HEAD;
abler has no release workflow (manual asset upload, `PUBLISHING.md:68-72`). The root
`.github/workflows/ci.yml` already uploads `release-npm` and `release-<runner>` artifacts for both
packages and is `workflow_call`-able.

**Options.**

| Option | Shape | Pros | Cons |
| --- | --- | --- | --- |
| A. Per-package tags + one root release workflow | Tags `abler-mcp@0.3.1`, `infomentor-mcp@0.5.0`. Root `release.yml` (`on: push: tags: ['*@*']` or dispatch on a tag): a `version` job parses `<pkg>@<ver>`, asserts `packages/<pkg>/package.json` and the installer pin, `uses: ./.github/workflows/ci.yml`, then drafts a prerelease with only that package's artifacts. Assets keep their namespaced names. | One workflow; independent cadence per package; matches workspaces and turbo; `@` in tag names is the changesets convention already in wide use for `releases/download/<tag>/…` and `raw.githubusercontent.com/<repo>/<tag>/…` URLs (convention, not verified in this session). | Install URLs change in both READMEs, `AGENTS.md` and both `install.sh`; the old repositories must keep their historical releases online for existing installs. |
| B. Changesets on top of A | `.changeset/` entries; `changeset version` bumps `package.json` and CHANGELOG; `changeset tag` emits the same `<pkg>@<ver>` tags that feed A. | Changelogs, batched bumps, PR-based release review. | Another tool and bot; the install-pin and README URLs still need a sync script; overkill for one maintainer today. |
| C. Keep separate workflows and tag schemes per package | Two release workflows under the root, two tag conventions. | Least change to the imported files. | The two workflows were already about 70 % identical; GitHub reads only root workflows anyway; two release processes to document and drift between them. |

**Recommendation.** A now, B later only if changelog or bump discipline becomes a problem; not C.
Concretely: derive the root `release.yml` from infomentor's (tag verification, `--verify-tag`,
draft prerelease) with `package: [abler-mcp, infomentor-mcp]` filtered by the tag; add
`tooling/release/sync-version.mjs` that rewrites the installer pin and the README/AGENTS URLs from
`package.json`, asserted in CI for both packages (generalise the check in
`abler/test/install.test.ts`); adopt the URL scheme
`https://raw.githubusercontent.com/olafurns7/family-mcp/<pkg>@<ver>/packages/<pkg>/install.sh` and
`https://github.com/olafurns7/family-mcp/releases/download/<pkg>@<ver>/<asset>`; set
`repository.url` to the monorepo and `repository.directory` in both `package.json` files (required
for npm provenance later); keep npm unpublished; keep the old repositories' releases online and add a
pointer in their READMEs, since installed copies pin the old URLs.

---

## 7. Ranked improvement backlog

Ordered by value over effort. Effort: S ≤ half a day, M ≤ 2 days, L more.

| # | Improvement | Tags | Effort | Where |
| --- | --- | --- | --- | --- |
| 1 | Gate infomentor's `login`/`logout` (and `localForm`) behind an explicit opt-in; document that `select_child` changes shared context. | [security] | S | `info/src/server.ts:140-188`, `cli.ts` |
| 2 | Add ownership, mode and symlink checks to infomentor session and import reads (mirror `abler/src/auth.ts:106-111`). | [security] | S | `info/src/session.ts:246-258`, `login.ts:184` |
| 3 | Move the release workflow to the root, parameterised by `<pkg>@<ver>` tags; add the version-sync script and CI assertion. | [structure] [dx] | M | §6 |
| 4 | Extract release tooling: one binary builder, one installer template, one installer test harness, one MCP smoke, generated notices. | [structure] [dx] | M | §3.4 |
| 5 | Migrate infomentor to `@modelcontextprotocol/server` v2. | [structure] | S | §4 |
| 6 | Extract the session store (lock + private file I/O), drop proper-lockfile, add `fsync` to infomentor writes, sweep temp files. | [security] [correctness] | M | §3.1 |
| 7 | Sign or attest release assets and verify in the installers when the tool is available. | [security] | M | §2 item 4 |
| 8 | Unify on `bun test` with injection seams; add the dual-runtime loopback HTTP fixture; wire `test:dist` and `test:binary`. | [dx] [correctness] | M | §5 |
| 9 | Abler: keep the `serveStdio` handle and close on signals; set `onCompromised`; document or bound the lock hold. | [correctness] | S | `abler/src/cli.ts:51`, `auth.ts:25-30`, `api.ts:279-312` |
| 10 | Infomentor: bounded wait in `withSessionLock` (≈ 30 s, like abler) and a documented stale-lock recovery. | [correctness] | S | `info/src/lock.ts:53-116` |
| 11 | Infomentor: persist the 429 cooldown beside the session so other processes honour `Retry-After`. | [correctness] | S | `info/src/http.ts:54,141` |
| 12 | Remove `.collections` on logout; prune abler `.pending` candidates on a later successful import. | [security] | S | `info/src/client.ts:517-519`, `abler/src/cli.ts:74-85` |
| 13 | Infomentor `install.sh`: wrap in `main()`, extract single members with `tar -xO`. | [security] | S | `info/install.sh` |
| 14 | WARP: no `sudo` from the MCP launcher; separate the admin installer from the MCP installer. | [security] | M | `info/scripts/warp-launcher.sh:8`, `install.sh:49-57` |
| 15 | Abler: add `outputSchema` + `structuredContent` to all six tools; validate `list_groups`. | [dx] | S | `abler/src/server.ts:45-103`, `api.ts:243` |
| 16 | Abler tests: `groups()` and `event()` success paths; CLI `status`/`logout`/`capture` paths. | [correctness] | S | `abler/test/integration.test.ts` |
| 17 | Infomentor tests: 8 MiB HTTP cap, `Retry-After` date form, malformed bootstrap, form 413 / CSRF branches, CLI argument errors. | [correctness] | S | `info/test/*.test.ts` |
| 18 | Lint debt inherited from the root config migration: 214 anti-slop findings in abler (194 are `require-readable-spacing`) and 384 in infomentor (338 in `scripts/*.mjs`; convert the scripts to TypeScript or type them). | [dx] | M | `.oxlintrc.json` overrides; terra report tables |
| 19 | Docs: abler `REVIEW.md` header, counts and Bun version; `PUBLISHING.md`/`AGENTS.md` URL pins; infomentor `REVIEW.md:188`, `RELEASING.md:18,51`, `.gitignore:6-8`; delete the empty `info/tools/` directory. | [docs] | S | listed files |
| 20 | Root-level `docs/AGENTS.md`: merge abler `docs/AGENTS.md` with infomentor's "Instructions for assistants" (`README.md:300-322`) into one agent guide with per-package sections; leave pointers in the packages. | [docs] | S | new file |
| 21 | Abler npm tarball: stop shipping maintainer docs and the hand-maintained notices file; generate notices at build. | [structure] | S | `abler/package.json` `files`, `docs/THIRD_PARTY_NOTICES.txt` |
| 22 | Consistent Bun build flags: drop the no-op `-baseline` suffix in abler, add `--sourcemap` to infomentor (or drop it from abler), share the autoload flags. | [dx] | S | `abler/scripts/build-native.sh:9-13`, `info/scripts/build-binary.mjs:43-57` |
| 23 | Infomentor: cache the parent read within one lock hold; skip `isauthenticated` when the parent read succeeds. | [correctness] | M | `info/src/client.ts:123-124` |
| 24 | Config-path convention (XDG) documented; consider an XDG default for new infomentor installs with the legacy path as fallback. | [dx] | S | `info/src/session.ts:70-72` |
| 25 | `exactOptionalPropertyTypes`: already enabled by the shared base (`60e687b`); both packages typecheck clean at `7deb778`. No action. | [dx] | — | `tooling/tsconfig/base.json` |
