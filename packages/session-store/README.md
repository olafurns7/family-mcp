# @family-mcp/session-store

Private workspace package shared by `abler-mcp`, `infomentor-mcp`, and `kronan-mcp`. It owns the two
things a server must get right for a locally saved credential: coordinating every local process that
uses one session file (Abler and InfoMentor), and reading or writing that file without exposing it
(all three, including Krónan's non-rotating token file). It has no runtime dependencies.

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
`UNSAFE_FILE`, `TOO_LARGE`, `IO`, and the store codes below) and a literal message that never
contains a path, key or file contents. `readPrivateBytes` is `readPrivateFile` without decoding.

## Encrypted secret records

```ts
import {
  LocalKeyFileProvider,
  createSecretKey,
  readSecretRecord,
  withSecretRecord,
} from '@family-mcp/session-store';

const store = {
  path: recordPath, // for example ~/.config/app-mcp/session.enc
  server: 'app-mcp',
  profile: 'default',
  purpose: 'session',
  schema: 1,
  keys: new LocalKeyFileProvider({ path: keyPath }), // e.g. $XDG_DATA_HOME/family-mcp/keys/app-mcp.key
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
`createSecretKey({ path, keys })` calls `keys.createKey()` under the record lock, and only while
the record has no marker and no record.

Key providers implement `getKey()`, which never creates a key, and `createKey()`, which refuses to
replace one. `LocalKeyFileProvider({ path, keyId? })` keeps exactly 32 raw bytes in a file outside
the record directory. It reads the key with the `readPrivateFile` checks: a regular, single-link
file owned by the current user with no group or other bits. `createKey()` creates it exclusively
(`wx`) with mode `0600` in a `0700` directory and flushes the file and the directory.
`FakeKeyProvider` holds a key in memory for tests. Providers take an optional `AbortSignal`;
`withSecretRecord` and `createSecretKey` pass theirs.

`KeychainAccessorKeyProvider({ server, profile, keyId?, readTimeoutMs?, createTimeoutMs? })`
(key source `keychain-accessor`) keeps the key in a generic password of the default (login)
keychain: service `family-mcp.<server>`, account `<profile>.data-key`, value 64 lowercase hex
characters. It runs Apple's `/usr/bin/security` directly, never through a shell, with only `PATH`
and `HOME` in its environment and its output never logged:

- `getKey()` runs `find-generic-password -s … -a … -w` and accepts exactly 64 hex characters and a
  newline on stdout. The key is never in argv. The child is killed after `readTimeoutMs` (default
  10 s, `STORE_TIMEOUT`) or on abort (`CANCELLED`).
- `createKey()` first checks that no item exists, then runs `security -i` and writes one
  `add-generic-password … -w <hex> -T /usr/bin/security` command to its stdin, without `-U` or
  `-A`: the item is never updated, and its ACL trusts only the Apple tool. `-i` exits with the
  last command's status; a zero status is still followed by reading the key back and checking, in
  constant time, that it equals the generated key. Any
  failure, abort or timeout (`createTimeoutMs`, default 120 s) after the write starts is
  `STORE_WRITE_UNCERTAIN` and is never retried; running setup again creates the key only while the
  item is still absent and otherwise refuses.
- Exit statuses are the OSStatus truncated to 8 bits (Apple Security-61901.80.25,
  `SecurityTool/macOS/security.c` and `keychain_find.c`): 44 item not found is `STORE_UNAVAILABLE`;
  36 interaction not allowed (a locked keychain without UI) and 29 interaction required are
  `STORE_LOCKED`; 51 authorization failed and 128 user cancelled are `STORE_ACCESS_DENIED`; anything
  else, malformed output or a missing tool is `STORE_ERROR`.

The binaries ship unsigned, so trusting the Apple tool is what keeps updates free of keychain
prompts. The cost: **any process of the same user can fetch the key with `security` while the login
keychain is unlocked**; there is no per-app isolation. Records still hold no plaintext in config or
backups, and the key is protected while the keychain is locked. A later Developer ID release
upgrades without rewriting data: an interactive step grants the signed binary access to the same
item, verifies that it reads the key, then removes the `security` tool's access.

`defaultKeyProvider({ server, profile, platform? })` picks the key for the platform: the keychain
provider on macOS; on Linux a `LocalKeyFileProvider` at
`$XDG_DATA_HOME/family-mcp/keys/<server>.<profile>.key` when `XDG_DATA_HOME` is absolute, else
`~/.local/share/family-mcp/keys/…`, apart from the records under `~/.config`. Other platforms throw
`STORE_UNAVAILABLE`. `defaultSecretRecordPath(server)` returns `$XDG_CONFIG_HOME/<server>/session.enc`
(default `~/.config/<server>/session.enc`).

Failures are fixed, never repaired:

- `STORE_UNAVAILABLE`: the key is missing. It is never regenerated, also when the marker says the
  store is migrated.
- `STORE_ERROR`: a malformed key (also from a custom provider), a record that fails
  authentication (a wrong key and tampering are not distinguished), a malformed or mismatched
  marker, or a setup on an existing store or key.
- `STORE_WRITE_UNCERTAIN`: any other disagreement between the marker and the record: a record at
  neither the committed nor the pending generation, a pending record with another nonce, a
  pending generation other than the next one, a migrated flag that disagrees with the generation, a
  committed marker ahead of or behind its record, a missing record after a committed write, or a
  record without a marker. Neither file is used or changed; nothing resets the store.
- `STORE_LOCKED`, `STORE_ACCESS_DENIED`, `STORE_TIMEOUT`: the keychain is locked, refused access,
  or did not answer in time. The key is never created as a fallback.
- `TOO_LARGE`, plus the existing lock and file codes (`BUSY`, `CANCELLED`, `LOCK_LOST`,
  `UNSAFE_FILE`, `IO`).

Threat model: encryption with a separately held key reduces accidental file, grep and commit
exposure and ciphertext-only backup leaks. It does not stop root, a compromised service, or a
same-user shell that can read the key. A key stolen together with the records is roughly a `0600`
file. The marker detects inconsistent writes, not an attacker who rolls back both the record and
the marker.

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
serialize read-modify-write cycles while a removal waits for an in-flight holder. The secret-record
suite covers round trips, 1 MiB payloads, header and ciphertext tampering, wrong keys, missing and
unsafe key files, pending-write reconciliation, stale or rolled-back markers and records, messages
without paths or secrets, and three processes serializing encrypted updates. The keychain suite
runs a fake `security` script, never the real tool: key read-back, argv without the key, exactly one
stdin command, a minimal environment, output validation, every mapped exit status, killed hung
reads and setups, unconfirmed setup writes, and the default key and record paths per platform.
