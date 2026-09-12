# @family-mcp/session-store

Private workspace package shared by `abler-mcp` and `infomentor-mcp`. It owns the two things both
servers must get right for a parent's school or sports login: coordinating every local process that
uses one session file, and reading or writing that file without exposing it. It has no runtime
dependencies.

```ts
import {
  defaultSessionPath,
  readPrivateFile,
  sweepTemp,
  withFileLock,
  writePrivateFile,
} from '@family-mcp/session-store';

const path = process.env.APP_SESSION_FILE ?? defaultSessionPath('app-mcp');

await withFileLock(path, { waitMs: 30_000 }, async () => {
  await sweepTemp(path);
  const previous = await readPrivateFile(path, { maxBytes: 262_144 });
  await writePrivateFile(path, rotate(previous));
});
```

## Security contract

`withFileLock(path, { signal?, waitMs? }, work)`

- One holder per session-file path per host. The lock is a directory named `<file>.lock` beside
  the file, keyed by the resolved parent directory, so aliased or symlinked directories share it.
  Hard-linked session files are unsupported and rejected.
- Ownership is a single `<pid>-<uuid>` file published by renaming a complete temporary directory
  into place; there is no window with a partially written owner.
- A waiter polls at most every 250 ms for up to `waitMs` (default 30 s; `0` fails immediately)
  and then throws `BUSY`. The caller's `signal` aborts the wait with `CANCELLED`.
- A crashed owner is recovered as soon as its PID no longer exists. A live PID is never expired by
  age, even if its process is suspended. If the operating system reuses a crashed owner's PID for
  another live process, the lock can remain busy; remove it with `rm -r <file>.lock` only when no
  process is using that session file.
- A holder only ever removes its own owner file. If another process removed or replaced that file meanwhile,
  the holder completes `work` and then throws `LOCK_LOST`, because its writes may have interleaved
  with the new holder's. Errors thrown by `work` propagate unchanged.

`readPrivateFile(path, { maxBytes })`

- Opens with `O_NOFOLLOW` and `O_NONBLOCK`, then checks the open handle: it must be a regular,
  single-link file, have no group or other permission bits, and be owned by the current user.
  Symbolic links, hard links, copies transferred with `0644`, and files owned by another account
  are rejected with `UNSAFE_FILE`.
- Files larger than `maxBytes` are rejected before they are read. The file is re-statted after the
  read; changes to its inode, size, or modification time are rejected. Callers parse and validate
  the returned text themselves.

`writePrivateFile(path, data, { fsync?, signal? })`

- Creates missing parent directories with mode `0700`, writes an exclusive (`wx`) `0600` temporary
  file beside the destination, flushes it, renames it over the destination, and flushes the
  directory. The rename is the only commit point: a crash or an abort observed before it leaves
  the previous file untouched, and the temporary is removed on every failure.
- A symbolic link at the destination is replaced by the rename, never followed.

`ensurePrivateDir(path, { enforceMode? })` creates directories with `0700` and leaves an existing
directory's mode alone unless `enforceMode` is set. `sweepTemp(path)` and
`sweepTempInDirectory(directory)` remove `*.tmp` files and directories left by a hard crash once
they are older than five minutes. Lock temporaries use `<file>.lock-tmp.<owner>`, which `sweepTemp`
does not match; sweeps should still run under the lock. `defaultSessionPath(appName, { legacy? })` returns
`$XDG_CONFIG_HOME/<app>/session.json` (default `~/.config/<app>/session.json`), keeping an existing
legacy file's path when one is given.

Every error is a `SessionStoreError` with a `code` (`BUSY`, `CANCELLED`, `LOCK_LOST`, `NOT_FOUND`,
`UNSAFE_FILE`, `TOO_LARGE`, `IO`) and a literal message that never contains a path or file contents.

## Platform notes

The permission and ownership checks run on macOS and Linux. Windows is **unsupported and
unverified**: its branches (no mode or owner checks, `EPERM` on an existing lock directory, no
directory flush) are kept from the original implementations, but nothing in this repository has
run there.

## Tests

`bun test` runs the acceptance suite: live-owner exclusion and dead-owner recovery under twelve
concurrent attempts, symlinked directories, in-flight ownership replacement, bounded waiting and
no age expiry for live PIDs, hard-link rejection, inode/size/mtime checks, file owner/mode/symlink/size checks,
abort at the commit point, sweeping, directory modes, default paths, and three real processes that
serialize read-modify-write cycles while a removal waits for an in-flight holder.
