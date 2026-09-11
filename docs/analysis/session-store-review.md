# Session-store adversarial review

Scope: read-only review of `packages/session-store/src/**`, its tests, and its
README on 2026-09-11. Findings describe local-filesystem behavior; no live
session or provider action was performed.

## High — a live holder can be expired and overwrite a newer rotating token

**Locations:** `packages/session-store/src/lock.ts:51-63`, `212-217`, `247-263`;
`packages/session-store/README.md:30-45`.

`inspect()` removes an owner whose PID is still live when its mtime is older
than `staleMs`. The original `work` receives no loss signal and continues until
it returns; `withFileLock()` reports `LOCK_LOST` only afterwards. For a rotating
refresh token, process A can stall after starting a refresh, process B can expire
the live A lock and write a newer token, then A can resume and atomically replace
B's session with its older response. The later `LOCK_LOST` does not restore the
lost token.

The README discloses the suspension consequence, but "one holder per session
file per host" is not true during that window and the warning does not explain
that a rotating credential may be rewound. The safest small fix is to never
age-expire an owner with a live PID; retain manual recovery for the rare PID-reuse
false busy case. A more involved alternative is fencing: communicate lock loss
to work and reject every session-file commit after the lease is invalid.

## Medium — refresh errors other than ENOENT are silently treated as healthy

**Locations:** `packages/session-store/src/lock.ts:247-263`.

`refreshOwner()` returns loss only for `ENOENT`; an `EACCES`, `EROFS`, or I/O
failure from `utimes()` is swallowed and the loop keeps running. The owner mtime
then becomes stale, a contender can remove the still-running owner, and the
holder keeps writing until release. This recreates the rotating-token interleave
without an explicit owner-file deletion.

Treat any refresh failure as lock loss (preserving the original error for
diagnostics if needed), and add a test that makes `utimes` fail while work is
held.

## Medium — hard-link aliases do not share a lock

**Locations:** `packages/session-store/src/lock.ts:150-159`;
`packages/session-store/README.md:30-31`.

The lock name derives from resolved parent directory plus basename, not the
target's device/inode. Two hard links to the same session file in the same or
different directories therefore use two lock directories. Two configured MCP
processes can simultaneously read the same token and rotate it; the first
atomic rename also breaks the hard-link relationship, leaving divergent files.

Reject a target with `nlink > 1`, or narrow the README promise to one configured
path and document hard links as unsupported. A lock keyed by file identity would
need a defined rule for a not-yet-created session file.

## Low — same-size mutation remains possible after the handle check

**Locations:** `packages/session-store/src/files.ts:51-116`.

Opening with `O_NOFOLLOW` and using `handle.stat()` correctly closes the common
final-component symlink TOCTOU: replacing the pathname after open does not
replace the inspected handle. It does not detect a same-UID process that rewrites
the already-open inode to the same length between `stat()` and `read()`. The
growth sentinel only catches a larger read.

This is not a cross-UID bypass—Unix permissions cannot isolate hostile processes
running as the same user—but it matters if the documented threat model includes
other same-account local software. Re-stat after reading and compare inode, size,
mtime/ctime, or explicitly document the trusted-parent/same-UID assumption.

## Low — the foreign-owner branch has no executable regression check

**Locations:** `packages/session-store/src/files.ts:94-97`;
`packages/session-store/test/files.test.ts:42-85`.

The tests cover mode and final-symlink rejection but never exercise
`info.uid !== process.getuid()`. A future refactor can accidentally move the
check behind a platform guard or remove it without a failing test. A real second
Unix user is unnecessary: temporarily mock `process.getuid()` to a different
number around `readPrivateFile()` and assert `UNSAFE_FILE`.

## Low — LOCK_LOST is tested only at release, not from the refresh loop

**Locations:** `packages/session-store/src/lock.ts:131-140`, `247-263`;
`packages/session-store/test/lock.test.ts:154-164`, `227-256`.

The replacement test removes ownership from inside `work`, so the release path
detects it. The live-holder test proves a healthy timer stays fresh, but no test
removes the owner while `refreshOwner()` is active and confirms `LOCK_LOST` after
the holder completes. A broken keepalive loop could retain the release-time test
while failing to observe an in-flight loss.

Add one short deterministic test: wait past one refresh interval, remove the
owner directory from a second actor, let `work` finish, and assert `LOCK_LOST`
without removing the replacement owner.

## Low — Windows behavior is documented but unverified

**Locations:** `packages/session-store/src/files.ts:45`, `84-98`, `257-275`;
`packages/session-store/src/lock.ts:176-177`, `198-202`;
`packages/session-store/README.md:74-78`.

The README accurately calls out missing Windows mode/owner checks, `EPERM`
directory behavior, and skipped directory flushes. No suite runs those branches.
For example, an existing lock directory can report `EPERM` for either ordinary
contention or an ACL problem, and Windows' refusal to replace an open destination
can turn a normal token save into `IO`.

Add a Windows CI lane for lock contention, symlink rejection, an open-destination
write, and installer-free file operations before claiming platform support. Until
then, keep Windows explicitly unsupported rather than relying on the retained
branches.
