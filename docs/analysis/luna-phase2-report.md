# Luna phase 2 report: shared session store and security fixes

Written 2026-09-11 in worktree `.worktrees/luna`, branch `phase2/session-store-and-security`,
based on `6b521c7` (`main`). Path shorthand as in the phase 1 analysis: `abler/` =
`packages/abler-mcp/`, `info/` = `packages/infomentor-mcp/`, `store/` = `packages/session-store/`.

Commits on the branch (each ends with the session trailer):

| Commit | Subject |
| --- | --- |
| `bbd8e70` | Add the shared `@family-mcp/session-store` package (plus `turbo.json` task edges and `bun.lock`) |
| `7b08962` | Adopt the session store in abler-mcp and drop proper-lockfile |
| `b488480` | Adopt the session store in infomentor-mcp and gate setup tools |
| (this report) | Document phase 2 |

Not done, as instructed: no merge, no push, no live logins, no version bumps. Files owned by
terra (`scripts/`, `install.sh`, `.github/`, the SDK import lines and `extra.signal` sites in
`info/src/server.ts`, the stdio wiring in `info/src/cli.ts`) were not touched beyond the
localised edits the brief allowed; see §4 for the two places where terra's files will need a
follow-up.

---

## 1. What changed

### 1.1 `packages/session-store` (`@family-mcp/session-store`, private, 0.0.0) — Task 1

Dependency-free; extends `@family-mcp/tsconfig`; linted by the root config with **no new
overrides**; `bun test` as its `test` task; built to `dist/` with declarations, which is what
consumers resolve (a `types` condition pointing at TypeScript source would resolve through the
workspace symlink to a file outside each consumer's `rootDir` and break `tsc -p
tsconfig.build.json`).

| Export | Behaviour |
| --- | --- |
| `withFileLock(path, { signal?, waitMs?, staleMs? }, work)` | Directory lock `<file>.lock` beside the file, keyed by the realpath'd parent (aliased directories share it). Ownership is one `<pid>-<uuid>` file published by renaming a complete temporary directory (no partially written owner). Contenders poll with 25→250 ms backoff for up to `waitMs` (default 30 s, `0` fails fast) and then throw `BUSY`; the caller's `signal` aborts the wait with `CANCELLED`. A crashed owner is recovered as soon as its PID is gone. While held, the owner file's mtime is refreshed every `staleMs / 6` (20 s by default); an owner file not refreshed for `staleMs` (default 120 s) is treated as abandoned even when its PID is alive, which bounds the PID-reuse false-busy case. A holder only ever removes its own owner file; if that file was expired by another process, `work` still completes and `LOCK_LOST` is thrown afterwards (its writes may have interleaved). Errors thrown by `work` propagate unchanged. |
| `readPrivateFile(path, { maxBytes })` | `open(O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK)`, then on the handle: regular file, no group/other bits, `uid === process.getuid()`, `size <= maxBytes`; reads `size + 1` bytes so a file that grows during the read is rejected. Errors: `NOT_FOUND`, `UNSAFE_FILE`, `TOO_LARGE`, `IO`. |
| `writePrivateFile(path, data, { fsync?, signal? })` | Creates missing parents with 0700, writes an exclusive (`wx`) 0600 `<path>.<uuid>.tmp`, `fsync`s it, checks `signal` at the commit point, renames, `fsync`s the directory (best effort), removes the temporary on every failure. |
| `ensurePrivateDir(path, { enforceMode? })` | 0700 for new directories; existing directories keep their mode unless `enforceMode` (used only for infomentor's `.collections`, which the package already tightened). |
| `sweepTemp(path, { olderThanMs? })`, `sweepTempInDirectory(dir, …)` | Remove `<name>.*.tmp` siblings, or every `*.tmp` entry, older than five minutes; documented to run under the lock so a waiter's lock temporary is never mistaken for an orphan. |
| `defaultSessionPath(appName, { legacy? })` | `$XDG_CONFIG_HOME/<app>/session.json` (relative `XDG_CONFIG_HOME` ignored per the spec), default `~/.config/<app>/session.json`; an existing legacy *file* keeps precedence. Synchronous, because `sessionPath()` is evaluated synchronously throughout infomentor. |
| `SessionStoreError` | Codes `BUSY`, `CANCELLED`, `LOCK_LOST`, `NOT_FOUND`, `UNSAFE_FILE`, `TOO_LARGE`, `IO`; literal messages without paths or contents. |

Tests (`store/test`, 8 tests, 38 assertions): `lock.test.ts` ports `info/test/lock.test.ts`
(live owner busy, dead-owner recovery under twelve concurrent fail-fast attempts, symlinked
directory alias, replaced ownership now reported as `LOCK_LOST`, abort handling, work errors
verbatim) and adds bounded waiting, cancellation while waiting, age-based expiry of an unrefreshed
owner with a live PID, and proof that a live holder's refresh keeps a long hold from expiring.
`processes.test.ts` ports abler's three-process test to the store: three real processes
(`test/lock-worker.ts`, spawned through `node:child_process`) serialize read-pause-write cycles on
a counter (final value 3, no stray lock or temp entries) and a removal process waits for an
in-flight holder. `files.test.ts` covers mode/symlink/size/directory guards, symlink destinations
being replaced rather than followed, the abort-at-commit property (deterministic: the signal's
`aborted` getter reports true only on its second inspection, so the temporary is fully written
before the abort is observed, and the previous file and directory listing are unchanged),
sweeping, directory modes, and the default path rules.

`store/README.md` states the security contract and marks the Windows branches (no mode/owner
checks, `EPERM` on an existing lock directory, no directory flush) as **unverified**.

### 1.2 `turbo.json`

`typecheck`, `lint` (type-aware) and `test` now `dependsOn: ["^build"]`, because both consumers
resolve the store's `dist/` declarations and JavaScript; without the edge the forced acceptance
run is order-dependent. Terra may add tasks to the same file; the three added lines are easy to
merge.

### 1.3 abler-mcp — Task 2

- `abler/src/auth.ts`: `withSessionLock` wraps `withFileLock` (30 s wait, temporaries swept under
  the lock; `BUSY`/`IO` map to the existing message, `LOCK_LOST` to a "retry" message);
  `loadSession` uses `readPrivateFile` (256 KiB cap; the existing tests' `/owner-only/` and
  `/symlink/` expectations still hold); `saveSession` uses `writePrivateFile` (fsync of file and
  directory); `sessionPath()` uses `defaultSessionPath('abler-mcp')` (unchanged location);
  `prunePendingCandidates(path)` added.
- `abler/src/cli.ts`: after a verified import renames the candidate into place, retained
  `.pending` candidates from earlier failed imports are removed (backlog #12). Only the import
  block changed.
- `proper-lockfile` and `@types/proper-lockfile` removed from `package.json` and `bun.lock`;
  the notices for proper-lockfile, graceful-fs, retry and signal-exit (pulled in only by it) were
  removed from `docs/THIRD_PARTY_NOTICES.txt`.
- `README.md:111,115,117,204,206,209,219` reworded to the new semantics (30 s wait, immediate
  crash recovery, two-minute expiry of an abandoned lock, sweep after five minutes, candidate
  pruning, owner check, `@family-mcp/session-store` instead of proper-lockfile).
- Test: the failed-import test now continues with a verified import and asserts that the
  retained candidate is gone and the new session holds the verified token.

### 1.4 infomentor-mcp — Task 2

- `info/src/session.ts`: `readSession` → `readPrivateFile` (1 MiB cap): `NOT_FOUND` →
  `LOGIN_REQUIRED`, `UNSAFE_FILE` → `INVALID_SESSION` with a chmod/symlink instruction;
  `writeSession` → `writePrivateFile` with `fsync` and the caller's `signal` (cancellation before
  the rename keeps the previous file). Default path is now XDG with the legacy
  `~/.infomentor-mcp/session.json` kept while that file exists (#24). New optional field
  `rateLimitedUntil` in `savedSessionSchema` and `rateLimitCooldown()` (cap one hour).
- `info/src/lock.ts`: adapter over `withFileLock` with a 30 s bounded wait (#10), temporaries
  swept under the lock (#6), a `waitMs` option for tests, and mapped `BUSY`/`LOCK_LOST`/`IO`
  errors; `InfoMentorError`s from the action still propagate first, then abort takes precedence.
- `info/src/credentials.ts`: `readCredentials` → `readPrivateFile` (16 KiB cap, symlink and owner
  checks added to the existing mode check).
- `info/src/collection.ts`: snapshot reads and writes go through the store (`ensurePrivateDir`
  with `enforceMode`, `writePrivateFile` with `fsync`); `pruneSnapshots` also sweeps orphaned
  snapshot temporaries.
- `info/src/http.ts`: `InfoMentorHttp(jar, cooldownUntil)` and a `rateLimitedUntil` getter (the
  only change in that file).
- `info/src/login.ts`: `sessionFromHttp` persists a pending cooldown; `httpFromSession` restores
  cookies and cooldown together; `login`/`importSession` run `requireSameAccount` before the
  write (see §1.5).
- `info/src/client.ts`: reads rebuild the HTTP client through `httpFromSession`, so a 429 seen by
  any process is honoured by all of them (#11); `comparableSession` includes the cooldown so it
  is written once and dropped once; logout removes `<session>.collections` under the lock (#12).
- README: default path, file requirements, lock semantics, rate-limit persistence, logout
  behaviour, Windows marked unverified, upgrade note.
- Tests: `test/lock.test.ts` rewritten for the new contract (fail-fast via `waitMs: 0`, dead-owner
  recovery, one winner among twelve concurrent fail-fast attempts, bounded wait, cancellation
  while waiting); `test/integration.test.ts` no longer loops a 429 through the renewal test (a
  persisted cooldown would have blocked the later `LOGIN_REQUIRED` expectations) and gained the
  tests listed in §2. The cancel-at-commit test used `mock.method(fs, 'writeFile')` to pause
  inside the temp write; with the store writing through a `FileHandle` that hook can never fire,
  so the test now cancels from the fixture's final request (the verified parent read) and the
  commit-point property itself is proven deterministically in `store/test/files.test.ts`.

### 1.5 Security fixes — Task 3

- **Setup tools gated (backlog #1, §2 item 1).** `createServer(options)` accepts
  `allowSetupTools`; `info/src/server.ts` registers `infomentor_login`,
  `infomentor_setup_status`, `infomentor_cancel_setup` and `infomentor_logout` only when it is
  true (one early `return server` before the four registrations, plus a sentence at the end of
  the `instructions` string). `info/src/cli.ts` parses `--allow-setup-tools` (serve only) and
  `--allow-account-change` (login only) in the argv block and passes them through the options
  object it already builds, so the `serve` wiring line is unchanged. `LOGIN_REQUIRED` (thrown by
  `readSession`, `http.ts` 401 and `requireSchoolPage`) is now neutral: it names
  `infomentor-mcp login` first and mentions `infomentor_login` only for servers started with the
  flag, so `session_status.nextStep` sends the user to the CLI by default.
- **`infomentor_select_child` description** now says later reads are context-dependent and that
  any client sharing the session can change the selection.
- **Account-change refusal (§2 item 8).** `login()` and `importSession()` read the existing
  session under the lock and refuse to replace a readable v2 session whose `accountId` differs
  from the newly verified one, unless `allowAccountChange` (`--allow-account-change`, MCP
  `allowAccountChange: true`) is given. Missing, unreadable, legacy-v1 and account-less files are
  replaceable, so "run login again to create a version-2 session" keeps working.
- **`loginUrl` removed from `infomentor_setup_status`** (`setupStatusSchema`); the MCP path prints
  the URL on stderr and opens the browser locally, the CLI prints it as before.

---

## 2. Security properties now guaranteed

| Property | Package | Proven by |
| --- | --- | --- |
| Session and import files that are symlinks, readable by others, or owned by another user are refused before any network request | infomentor | `session and credential files that are world-readable or symlinked are refused for reads and imports` (`info/test/integration.test.ts`) |
| Credentials files with the same defects are refused | infomentor | same test (`readCredentials` on a 0644 file and on a symlink) |
| Abler session files with the same defects are refused | abler | `unsafe session files, malformed pages, stalled cursors, and wrong events fail explicitly` (`abler/test/integration.test.ts`) |
| The guard itself (mode, symlink, non-regular file, size cap, growth) | store | `private files are written atomically with owner-only permissions and read back` (`store/test/files.test.ts`) |
| Writes are atomic, 0600, and an abort observed after the temporary is written but before the rename leaves the previous file untouched with no temporary behind | store | `an abort observed at the commit point keeps the previous file and leaves no temporary` |
| Cancelling a login or import after its last network request never replaces the saved account | infomentor | `cancelled login/import cannot replace the previous account, even after the last request before the commit` |
| Session-mutating tools are absent unless explicitly enabled; a missing session names the CLI; login/logout calls on the default server fail without touching the network | infomentor | `private login and eleven MCP tools select children and read school data without changing read state` (default-server block: seven tools listed by name) |
| An explicit login or import cannot silently switch the saved account; `allowAccountChange` is required; same-account and legacy files still work | infomentor | `explicit login or import cannot silently replace a session verified for another account` (library and MCP paths) |
| `infomentor_setup_status` never carries `loginUrl` | infomentor | `private login and eleven MCP tools …` (`'loginUrl' in progress` is false and the serialized result never contains it) |
| A 429 pause is persisted with the session and honoured by a second client/process with zero requests; other session files are unaffected; expired pauses are ignored; saved pauses are capped at one hour | infomentor | `a rate-limit pause is saved with the session and honoured by other processes without contacting InfoMentor` |
| Processes sharing a session file serialize their read-modify-write cycles and a removal waits for an in-flight holder | store, abler | `separate processes serialize read-modify-write cycles and removal waits for an in-flight holder` (`store/test/processes.test.ts`); `separate processes serialize rotating credentials and logout waits for an in-flight request` (`abler/test/integration.test.ts`) |
| Live owners exclude contenders; dead owners are recovered without deleting a concurrent winner's lock; symlinked directories share the lock; a holder never removes another holder's ownership and reports `LOCK_LOST` | store, infomentor | `locks exclude live owners, recover dead owners safely, and release only their own token` (`store/test/lock.test.ts`); `session locks exclude live owners, recover dead owners safely, and release only their token` (`info/test/lock.test.ts`) |
| Contention waits a bounded time instead of failing instantly, can be cancelled while waiting, and an unrefreshed owner with a live (reused) PID expires by age while a live holder's refresh prevents expiry | store, infomentor | `waiters poll for a busy lock up to waitMs and abandoned owners expire by age` (`store/test/lock.test.ts`); `session locks wait a bounded time for another process and cancel while waiting` (`info/test/lock.test.ts`) |
| Orphaned temporaries are swept only when old and only when they belong to the target; `.pending` candidates are never swept | store | `sweeping removes only old temporaries that belong to the target` |
| A verified import removes candidates retained by earlier failed imports | abler | `failed import retains a rotated candidate without overwriting the existing session, and a later verified import removes it` |
| Collection snapshots are 0700/0600, and logout removes the session together with its snapshots | infomentor | `collection snapshots replay deltas, …` (modes); logout removal is exercised in `private login and eleven MCP tools …` (logout) and covered by code review rather than a listing assertion — see §5 |
| Existing installs keep their session path; new installs use XDG | store | `the default session path follows XDG and keeps an existing legacy file` |

---

## 3. Decisions the brief left open

- **`LOCK_LOST` is an error, not a warning.** If another process expired this holder (or a human
  removed the lock directory) while `work` ran, the work's writes may have interleaved, so the
  caller gets an error and must retry; the holder never deletes the new owner's file. The old
  abler behaviour was a crash from proper-lockfile's timer; infomentor silently succeeded.
- **Age-based expiry has a documented cost:** a holder whose process is suspended or whose event
  loop stalls for more than 120 s (a laptop that sleeps mid-request) can lose the lock while it
  believes it holds it. proper-lockfile had the same property; the README states it and the
  manual recovery (`rm -r <file>.lock` when no process runs).
- **Poll cadence** 25 ms doubling to 250 ms keeps hand-offs fast for short holds without a hot
  loop; the old abler retry was 1 s.
- **Owner check consequence:** Kubernetes-style secret mounts (symlink to `..data/<file>`, often
  0644 or root-owned) are now rejected for credentials files; the README tells users to copy the
  secret into a private file. The previous mode check already rejected 0644 mounts.
- **The cooldown lives in the session file** (`rateLimitedUntil`, optional, stripped by older
  versions) rather than a sibling file, so it is written under the same lock and atomic rename
  and disappears with logout. Restores are capped at one hour so a transferred file cannot
  self-deny for longer.
- **Default XDG path for infomentor** applies only when no legacy file exists; the legacy check
  is a synchronous `statSync` because `sessionPath()` is a default-parameter expression.
- **One `LOGIN_REQUIRED` text for both modes** instead of plumbing the server mode into
  `http.ts`, `session.ts` and `client.ts`.
- **`ImportOptions`/`ServerOptions`** are exported from `info/src/index.ts`; `setupStatusSchema`
  lost an optional field, which is compatible for consumers that parse it.

---

## 4. Consequences for terra's files (not changed here)

1. **Tool count in the smoke scripts.** `info/scripts/package-smoke.mjs:79` and
   `info/scripts/test-installer.mjs:148` assert `tools.length === 11`. Both spawn `serve` without
   `--allow-setup-tools`, so the server now lists **7** tools. Change the expectation to 7 (and
   optionally add a second handshake with the flag expecting 11).
2. **npm tarballs.** Verified locally: `npm pack` keeps `"@family-mcp/session-store":
   "workspace:*"` verbatim in the packed `package.json`, and `bun pm pack` rewrites it to
   `"0.0.0"`. Neither resolves from a registry, so the CI `check` job's `npm install --global
   … abler-mcp-0.3.1.tgz` step and infomentor's `bun run test:package` will fail until the
   store is either bundled into each package's `dist/` at build time or published. The standalone
   binaries (`build:native`, `build:binary`) bundle it and are unaffected; the store has no
   third-party dependencies, so the generated notices do not change.
3. `.oxlintrc.json` gained no overrides; the store lints under every rule.

---

## 5. Deferred or not verified

- Windows: all branches kept, none executed.
- The `uid !== getuid()` rejection has no automated test (it needs a second user); it is
  exercised only by code review.
- `LOCK_LOST` detected *during* the hold by the refresh loop is not asserted separately; the test
  asserts the release-time detection (replacement directory) and the expiry-by-age path.
- Logout's removal of `.collections` has no dedicated listing assertion; the integration test's
  logout runs after a collection and the code path is a two-line `rm` under the lock.
- `abler/docs/REVIEW.md` and `info/docs/REVIEW.md` are historical review records and were not
  rewritten; `info/docs/HTTP-AUTH.md:73` still describes the lock generically and remains true.
- `info/src/server.ts` `result()` still says "Check infomentor_setup_status or
  infomentor_session_status" in its generic failure text; it is outside the registration block.
- Backlog #8 (unify infomentor on `bun test` with injection seams) and #9's non-lock parts
  (`serveStdio` handle, `onCompromised`) were out of scope; `onCompromised` is moot without
  proper-lockfile.
- `infomentor_select_child` and `infomentor_collect_updates` stay reachable by design.

---

## 6. Acceptance

From the worktree root, after a single `bun install` with Bun 1.4.2 (the
`/private/tmp/family-mcp-phase1-runtime` binary from phase 1; `bun install --frozen-lockfile`
then reports no changes) and `git diff --check` clean.

```sh
bunx turbo run build typecheck lint format:check test --force
```

Exact summary of the run with the global Bun 1.2.19 (the run terra's phase 1 report used):

```text
• turbo 2.10.12

   • Packages in scope: @family-mcp/oxlint-anti-slop, @family-mcp/session-store, @family-mcp/tsconfig, abler-mcp, infomentor-mcp
   • Running build, typecheck, lint, format:check, test in 5 packages
   • Remote caching disabled (in configuration), using shared worktree cache

//:format:root:check: All matched files use the correct format.
//:format:root:check: Finished in 4ms on 8 files using 14 threads.
@family-mcp/session-store:lint: Found 0 warnings and 0 errors.
@family-mcp/session-store:lint: Finished in 336ms on 9 files with 218 rules using 14 threads.
@family-mcp/session-store:format:check: All matched files use the correct format.
@family-mcp/session-store:format:check: Finished in 247ms on 13 files using 14 threads.
abler-mcp:lint: Found 0 warnings and 0 errors.
abler-mcp:lint: Finished in 451ms on 7 files with 218 rules using 14 threads.
abler-mcp:format:check: All matched files use the correct format.
abler-mcp:format:check: Finished in 229ms on 14 files using 14 threads.
infomentor-mcp:format:check: All matched files use the correct format.
infomentor-mcp:format:check: Finished in 270ms on 25 files using 14 threads.
infomentor-mcp:lint: Found 0 warnings and 0 errors.
infomentor-mcp:lint: Finished in 673ms on 16 files with 218 rules using 14 threads.
infomentor-mcp:test: ℹ tests 19
infomentor-mcp:test: ℹ pass 19
infomentor-mcp:test: ℹ fail 0
infomentor-mcp:test: ℹ duration_ms 729.944416
abler-mcp:test:  85 expect() calls
abler-mcp:test: Ran 8 tests across 2 files. [2.05s]
@family-mcp/session-store:test:  38 expect() calls
@family-mcp/session-store:test: Ran 8 tests across 3 files. [3.47s]

 Tasks:    16 successful, 16 total
Cached:    0 cached, 16 total
  Time:    3.502s
```

The same command with Bun 1.4.2 on `PATH` (as CI runs it) also finished `Tasks: 16 successful,
16 total`, `Cached: 0 cached, 16 total`, `Time: 3.214s`, with the same test counts under
`bun test v1.4.2`.

Test counts: infomentor 19 (the original 15 including 7 subtests, plus 4 new), abler 8 (one
extended), session-store 8.
