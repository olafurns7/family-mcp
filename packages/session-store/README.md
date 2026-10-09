# @family-mcp/session-store

Private workspace package shared by the family-mcp servers. It owns the two things a server must get
right for a locally saved credential: coordinating every local process that uses one session, and
keeping it unreadable to others: encrypted secret records whose key is an owner-only key file, and
owner-only private files, such as an older version's plaintext session. It has no runtime
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
  and then throws `BUSY`. The deadline uses monotonic time, so a clock change does not move it,
  and every retry obeys it: once it has passed, a lock caught between owners gets at most three
  more immediate attempts (so `waitMs: 0` can still finish a recovery), and a live owner none. The caller's `signal` aborts the wait with `CANCELLED`. These
  bounds cover the waiting, not kernel file I/O: a network, FUSE or failing disk can block a
  single file call for longer.
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
`sweepTempInDirectory(directory)` remove the `<name>.<uuid>.tmp` regular files `writePrivateFile`
leaves after a hard crash once they are older than five minutes; a directory or link under such a
name is never removed. Lock temporaries use `<file>.lock-tmp.<owner>`, which `sweepTemp`
does not match; sweeps should still run under the lock. `defaultSessionPath(appName, { legacy? })` returns
`$XDG_CONFIG_HOME/<app>/session.json` (default `~/.config/<app>/session.json`), keeping an existing
legacy file's path when one is given; it is the older plaintext location and does not move.

Writes are atomic, not power-loss durable: a reader sees the old file or the new one, never a mix,
but flushing the directory is best effort, so after a power cut the last change can be missing.

Every error is a `SessionStoreError` with a `code` (`BUSY`, `CANCELLED`, `LOCK_LOST`, `NOT_FOUND`,
`UNSAFE_FILE`, `TOO_LARGE`, `IO`, and the store codes below) and a literal message that never
contains a path, key or file contents. `readPrivateBytes` is `readPrivateFile` without decoding.

## Encrypted secret records

```ts
import {
  createSecretKey,
  defaultKeyProvider,
  defaultSecretRecordPath,
  readSecretRecord,
  withSecretRecord,
} from '@family-mcp/session-store';

const store = {
  path: defaultSecretRecordPath('app-mcp'),
  server: 'app-mcp',
  profile: 'default',
  purpose: 'session',
  schema: 1,
  keys: defaultKeyProvider({ server: 'app-mcp', profile: 'default' }), // a LocalKeyFileProvider
  maxBytes: 262_144,
};

await createSecretKey(store); // explicit setup (first login) only
await withSecretRecord(store, async (current) => rotate(current)); // undefined keeps the record
const session = await readSecretRecord(store);
```

`withSecretRecord(options, update)` is the one transaction for a record:

- It holds `withFileLock` on the record path for the whole read, decrypt, `update`, encrypt,
  write, read-back and marker commit, and returns only after the write has finished. `update`
  receives the plaintext, or `null` when the store holds no record yet, and returns the next
  plaintext or `undefined`. The caller's `signal` aborts the lock wait or stops before `update`;
  once `update` returns a value, the write completes.
- A record is a canonical JSON header `{v, server, profile, purpose, schema, generation, keyId,
nonce}` on the first line, which is the AES-256-GCM additional authenticated data, and the
  base64url ciphertext with its 128-bit tag on the second. Every write uses a fresh random 96-bit
  nonce and the next generation under one stable 256-bit key. No name, path or authenticated field
  contains an executable hash, version, signer or language, so another build reads the same record.
- The record is authenticated and its server, profile, purpose, schema and key id are checked
  before any plaintext is returned. `maxBytes` bounds the plaintext; the encoded file is bounded
  from it before it is read. Records and markers use `readPrivateFile` and `writePrivateFile`.
- `<path>.marker` is a non-secret JSON file `{backend, keySource, keyId, profile, migrated,
generation, pending?}`. A write first commits a marker naming the pending generation and nonce,
  then the record, reads the record back, and commits the marker. The lock never expires a live
  holder, so no interrupted write can land later. The next transaction commits the marker when
  the record is that exact authenticated candidate, and drops the pending generation when the
  record is still at the committed generation (or still absent before a first write); a session
  kept that way may need a new login. Recovery only considers a pending generation one past the
  committed one, in a marker that is migrated exactly when its generation is at least 1.
- `schema` and generations are integers of at most 15 digits. A larger schema is a `RangeError`,
  and a store at the last generation fails with `STORE_ERROR`, both before `update` runs.

`readSecretRecord(options)` runs the same transaction without a change and throws
`SECRET_NOT_FOUND` only when a key is present and no record was ever committed.
`secretStoreExists(path)` is true once a marker exists. From then on the store decides, also while
it holds no record (after a reset or an interrupted first write); a caller must not fall back to an
older credential source.

`withSecretStore(options, work)` holds the record lock for all of `work` and hands it a handle,
so one critical section can decide, read, set up and write without taking the lock again:

```ts
await withSecretStore(store, async (held) => {
  let session = parse(await held.read()); // null while the store holds no record
  if (expired(session)) await held.write(serialize((session = await refresh(session))));
  await work(session); // a refresh in the middle writes again under the same hold
});
```

- `read()` returns the committed plaintext or `null`, with the same recovery as a transaction.
- `write(next)` runs the whole write protocol each time: next generation, pending marker, record,
  authenticated read-back, marker commit. Several writes in one hold are several generations, and
  a crash between them keeps the last committed one. A write that fails after a file changed is
  `STORE_WRITE_UNCERTAIN`; one refused before (`TOO_LARGE`, no generation left, or the store
  failing to open) keeps its code. Either way the handle is unusable afterwards, and every later
  call throws that error.
- `exists()`, `update()`, `createKey()` and `reset()` are the operations of the functions here.
  `withSecretRecord` is `read()`, `update`, then `write()` on one handle.
- `checkKey()` confirms the key is there without reading the record: `STORE_BACKEND_RETIRED` for
  a store of the retired Keychain accessor, then whatever `getKey()` throws. Callers use it, not
  `keys.getKey()`, to tell a lost key from a working one.
- The handle stops working when `work` settles; later calls throw `STORE_ERROR`. The signal only
  aborts the lock wait and `update`; a started `write` always completes, so a rotated token is
  never lost to cancellation.
- A caller that also holds another lock takes that one first.

`createSecretKey(options)` calls `keys.createKey()` under the record lock, only while there is no
record and either no marker or a generation-0 marker without a pending write whose key `getKey()`
reports as `STORE_UNAVAILABLE`.

`resetSecretStore(options)` is the one recovery from a lost key, for an explicit new login only:
under the record lock it re-checks that `getKey()` fails with `STORE_UNAVAILABLE`, commits a fresh
generation-0 marker first, then removes the record, which nothing can decrypt anymore. No path
removes a marker, so a crash at any later point leaves a store without a record, never a missing
store. The caller then runs `createSecretKey` and writes. A readable key (`STORE_ERROR`) or any
other key failure leaves both files untouched.

Key providers implement `getKey()`, which never creates a key, and `createKey()`, which refuses to
replace one. `LocalKeyFileProvider({ path, keyId? })` keeps exactly 32 raw bytes in a file outside
the record directory. It reads the key with the `readPrivateFile` checks: a regular, single-link
file owned by the current user with no group or other bits, in directories that pass the startup
check below. `createKey()` writes the key to an exclusive (`wx`) `0600` temporary `<key>.<uuid>.tmp`
in a `0700` directory, flushes it, publishes it with `link`, which never replaces an existing key,
removes the temporary and flushes the directory. A crash leaves no key or the whole key; at worst
the temporary is still a second name of the key, and the next `getKey()` removes it, only when it is
the store's own temporary owned by this user with the key's device and inode. Any other second
name is a hard link and refused. `FakeKeyProvider` holds a key in memory for tests. Providers take
an optional `AbortSignal`; `withSecretRecord` and `createSecretKey` pass theirs.

The `KeyProvider` interface and the marker's `backend`, `keySource` and `keyId` checks stay, so a
later provider (a signed macOS Keychain helper, Linux Secret Service) can be added and chosen at
setup; none falls back to another. No code here runs `/usr/bin/security` or any Keychain API. A
marker from an earlier test build whose key source is `keychain-accessor` is refused with
`STORE_BACKEND_RETIRED` before any key is asked for, whether or not a key file exists: reads,
writes, `reset()`, `createKey()` and `checkKey()` all refuse and leave both files as they are. That
build left no key file, and its record may still open with the Keychain key, so it is never taken
for a lost key. The owner removes `session.enc` and `session.enc.marker` and signs in again.

### Where the store lives

`defaultSecretRecordPath(server)` and `defaultKeyProvider({ server, profile, platform? })` give:

| Platform | Records, markers and locks                                      | Keys                                                                       |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/family-mcp/<server>/session.enc` | `~/Library/Application Support/family-mcp/keys/<server>.<profile>.key`     |
| Linux    | `$XDG_CONFIG_HOME/<server>/session.enc` (`~/.config`)           | `$XDG_DATA_HOME/family-mcp/keys/<server>.<profile>.key` (`~/.local/share`) |

On Linux a relative `XDG_*` value is ignored, as the spec says. On macOS the XDG variables do not
move the store, so it cannot be pointed into iCloud Drive, Desktop or Documents by accident.
Only the test seam `FAMILY_MCP_STORE_TEST_SEAM=1` makes macOS honour absolute XDG directories;
the tests of every package that uses the store, and `bun test` from the repository root, preload
`test/store-test-seam.ts`, which sets it with scratch XDG directories, so a test run never touches
the real store. A home that is unknown or not absolute is refused (`STORE_UNAVAILABLE`). Other
platforms have no supported key (`STORE_UNAVAILABLE`). `FAMILY_MCP_KEY_BACKEND` is retired: unset,
empty or `file` change nothing, and any other value is refused.

`retiredStorePaths(server, profile?, { platform? })` lists where an earlier, unreleased macOS build
kept the store (`~/.config/<server>/session.enc` with its marker and lock, and
`~/.local/share/family-mcp/keys/<server>.<profile>.key`), leaving out the current store's record,
marker, lock and key, which XDG variables pointing into Application Support would otherwise name.
Passed as a record's `retired` option, those files make `exists()` true, so the server asks for a
new sign-in instead of falling back to an older credential; nothing reads them. An old path that is
the current record, marker, lock or key under another name (a linked directory or file, by device
and inode) is not counted, and the startup notice never names it for removal.

### Time Machine

On macOS each store directory (`keys/` and the server's directory) is excluded from Time Machine
before any key, temporary or record is written in it: setup writes the sticky exclusion attribute
`com.apple.metadata:com_apple_backup_excludeItem`, the same value `tmutil addexclusion` writes,
with `xattr`, and confirms it with `tmutil isexcluded`, which decides. Only when that does not
confirm it does setup run `tmutil addexclusion` (it took 11 s per call on macOS 27.0.1), and if
the directory is still not excluded, setup refuses. Every `tmutil` and `xattr` run has a time
bound. A start confirms the exclusion again and re-applies it when it was lost; a directory that
was removed and made again is excluded again. Excluding the store does not remove copies that
older Time Machine backups already hold.

Linux has no standard backup exclusion. Leave the key directory
(`~/.local/share/family-mcp/keys`) out of your backups yourself; a backup holding both a record and
its key holds the secret.

### Startup check

`checkSecretStore({ path, keys, retired? })` is the preflight every server runs before it serves or
touches the store, and `startupCheck({ server, signIn, store })` wraps it for a CLI. On a refusal
it writes to stderr and returns `false`:

```text
abler-mcp: cannot start. Other users can open this store directory.
  Path: '/Users/x/Library/Application Support/family-mcp/keys'
  Fix:  chmod 700 '/Users/x/Library/Application Support/family-mcp/keys'
```

The path is quoted for the shell, so both lines paste as they are; `Fix:` is left out when no one
command fixes it. When `retired` files exist it writes a notice with the exact cleanup commands.
It reads no secret, takes no lock and creates nothing; on macOS it only re-applies a lost backup
exclusion. It refuses, with `UNSAFE_FILE` and a fixed message, and never repairs anything:

- a key, record or marker file that is not a regular file, is a symbolic link, has another name
  (other than the recognised key temporary above; when another process has just removed that
  temporary, one fresh look accepts the same file with one name), has group or other permission
  bits (`chmod 600`), or is owned by another user (`sudo chown "$(id -un)"`);
- a store directory (`keys/`, the server's directory, and `family-mcp/` where it is their parent)
  that is a symbolic link, is owned by another user, including root (`sudo chown -R "$(id -un)"`),
  or is not owner-only (`chmod 700`);
- a directory above the store that another user could use to replace the store: owned by someone
  other than this user or root, or writable by group or other (`chmod go-w`). The check follows
  the route the system takes, one name at a time from `/`: every symbolic link on the way, also
  one inside another link's target, must be this user's or root's, and every directory it passes
  through, including those above each target, is checked. More than 40 links, a loop or a link
  to nothing is refused. Root's own links such as `/tmp -> private/tmp` pass. A sticky shared
  directory such as `/tmp` passes only when the entry below it is this user's or root's;
- on macOS, an access control list that grants another user anything on a store directory or file
  (`chmod -N`), or lets another user change a directory above the store (no one-line fix:
  `chmod -N` would also drop the stock deny entry; the message says to list the entries with
  `ls -led` and remove the one that lets another user write). Deny entries, such as a stock
  home's `group:everyone deny delete`, pass; an entry the check cannot read is refused;
- on macOS, a store directory whose Time Machine exclusion `tmutil isexcluded` does not confirm
  (`tmutil addexclusion`).

The error message has no path; `StoreRefusal.path` names the path and `StoreRefusal.fix` the
command, for the owner's terminal.

Failures are fixed, never repaired:

- `STORE_UNAVAILABLE`: the key is missing. It is never regenerated, also when the marker says the
  store is migrated, except through an explicit `resetSecretStore`.
- `STORE_ERROR`: a malformed key (also from a custom provider), a record that fails
  authentication (a wrong key and tampering are not distinguished), a malformed or mismatched
  marker, or a setup on an existing store or key.
- `STORE_WRITE_UNCERTAIN`: any other disagreement between the marker and the record: a record at
  neither the committed nor the pending generation, a pending record with another nonce, a
  pending generation other than the next one, a migrated flag that disagrees with the generation, a
  committed marker ahead of or behind its record, a missing record after a committed write, or a
  record without a marker. Neither file is used or changed; nothing resets the store.
- `STORE_BACKEND_RETIRED`: the marker names the macOS Keychain key source of an earlier test
  build, checked before the key.
- `STORE_LOCKED`, `STORE_ACCESS_DENIED`, `STORE_TIMEOUT`: kept for a later key provider that can
  be locked, refuse access or not answer in time; the key file never reports them. The key is
  never created as a fallback.
- `TOO_LARGE`, plus the existing lock and file codes (`BUSY`, `CANCELLED`, `LOCK_LOST`,
  `UNSAFE_FILE`, `IO`).

## Threat model

What the store protects against:

- other local users who are not root: the files are owner-only, and the startup check refuses
  permissions, ACLs or directories that would let them read or replace the store;
- a record copied without its key file, such as one in a dotfile repository or a commit;
- Time Machine backups of the store, which are excluded on macOS;
- tampering with a record while its key is safe: every record is authenticated.

What it does not protect against:

- anything running as your user: other programs, malware, AI agents with shell access or a
  prompt injection. They can read both files or call the MCP tools;
- root, and a stolen laptop that is unlocked;
- backups, snapshots, clones or sync tools other than Time Machine that capture both files, and
  Time Machine backups made before the exclusion;
- Spotlight or other indexers seeing the files;
- crash dumps, swap and hibernation images holding the key in memory;
- rolling back a record together with its matching old marker;
- plaintext files from older versions and browser profiles outside the store.

Disk encryption (FileVault on macOS, LUKS on Linux) is what protects a stolen computer that is
switched off.

## Platform notes

The permission and ownership checks run on macOS and Linux. Windows is **unsupported and
unverified**: its branches (no mode or owner checks, `EPERM` on an existing lock directory, no
directory flush) are kept from the original implementations, but nothing in this repository has
run there.

## Tests

`bun test` runs the acceptance suite: live-owner exclusion and dead-owner recovery under twelve
concurrent attempts, symlinked directories, in-flight ownership replacement, bounded waiting and
no age expiry for live PIDs, every lock retry within its deadline, hard-link rejection,
inode/size/mtime checks, file owner/mode/symlink/size checks, abort at the commit point,
sweeping, directory modes, default paths per platform, and three real processes that serialize
read-modify-write cycles while a removal waits for an in-flight holder. The secret-record suite
covers round trips, 1 MiB payloads, header and ciphertext tampering, wrong keys, missing and unsafe
key files, pending-write reconciliation, stale or rolled-back markers and records, messages without
paths or secrets, the retired Keychain marker and old layout, and three processes serializing
encrypted updates. The storage suite covers every startup refusal (modes, owners, links, ancestors
including a replaceable directory between two links, link loops, sticky parents, macOS ACLs) with
nothing read, locked or created, a process stopped at each key publication step, then restarted,
also concurrently, and a recovery by another process landing inside the check. The backup suite runs a fake `tmutil`,
never the real one: exclusion before any secret, the `addexclusion` fallback, refusal when
exclusion fails or is not confirmed, re-application on start and after a directory is made again,
and a hung `tmutil` abandoned within its bound.
