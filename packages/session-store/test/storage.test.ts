import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LocalKeyFileProvider,
  SessionStoreError,
  StoreRefusal,
  checkSecretStore,
  createSecretKey,
  withSecretRecord,
  withSecretStore,
  type SecretRecordOptions,
} from '../src/index.js';
import {
  aclEntries,
  aclProblem,
  ancestorProblem,
  ownedDirectoryProblem,
  type StoreStat,
} from '../src/storage.js';

const acl = (operation: '+a' | '-a', entry: string, path: string) =>
  execFileSync('/bin/chmod', [operation, entry, path]);

const worker = fileURLToPath(new URL('./key-worker.ts', import.meta.url));

const UID = process.getuid?.() ?? 0;

const OTHER = UID + 4242;

const E1 = 'The store directory is a symbolic link; use a real directory.';

const E2 = 'The store directory is owned by another user.';

const E3 =
  'The store directory is accessible to other users; use owner-only permissions (chmod 700).';

const E4 =
  'A directory above the store is writable by other users; remove their write permission (chmod go-w).';

const E5 = 'A directory above the store is owned by another user.';

const HARD_LINKS = 'Files with hard links are not supported.';

const OWNED_ACL =
  'The store path grants access to other users through an access control list; remove it (chmod -N).';

const ANCESTOR_ACL =
  'A directory above the store lets other users change it through an access control list; remove that entry (chmod -a).';

const TEMPORARY = '0f0e0d0c-0b0a-4908-8706-050403020100';

const refused =
  (message: string, path?: string) =>
  (cause: unknown): boolean =>
    cause instanceof StoreRefusal &&
    cause.code === 'UNSAFE_FILE' &&
    cause.message === message &&
    (path === undefined || cause.path === path);

function fake(kind: 'directory' | 'file' | 'link', mode: number, uid = UID, nlink = 1): StoreStat {
  return {
    mode,
    uid,
    nlink,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'link',
  };
}

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-storage-'));

  try {
    await work(directory);
  } finally {
    // A test's deny-delete ACL would keep the scratch tree; ACLs go first on macOS.
    if (process.platform === 'darwin') execFileSync('/bin/chmod', ['-R', '-N', directory]);
    await rm(directory, { recursive: true, force: true });
  }
}

/** A key file provider that counts reads, so a test can show the preflight never reads it. */
class CountingKeys extends LocalKeyFileProvider {
  reads = 0;

  override getKey(): Promise<Uint8Array> {
    this.reads++;

    return super.getKey();
  }
}

/** The macOS layout under `root`: `family-mcp/{keys,test-mcp}`. */
function layout(root: string): SecretRecordOptions & { keys: CountingKeys; key: string } {
  const key = join(root, 'family-mcp', 'keys', 'test-mcp.default.key');

  return {
    path: join(root, 'family-mcp', 'test-mcp', 'session.enc'),
    server: 'test-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    keys: new CountingKeys({ path: key }),
    key,
    maxBytes: 1024,
  };
}

async function listTree(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true })).toSorted();
}

test('store directory and ancestor decisions are pure', () => {
  expect(ownedDirectoryProblem(fake('directory', 0o40700), UID)).toBeUndefined();
  expect(ownedDirectoryProblem(fake('link', 0o120777), UID)).toBe(E1);
  expect(ownedDirectoryProblem(fake('directory', 0o40700, OTHER), UID)).toBe(E2);
  // A root-owned store directory is refused like any other owner.
  expect(ownedDirectoryProblem(fake('directory', 0o40700, 0), UID === 0 ? 1 : UID)).toBe(E2);
  expect(ownedDirectoryProblem(fake('directory', 0o40750), UID)).toBe(E3);
  expect(ownedDirectoryProblem(fake('directory', 0o40701), UID)).toBe(E3);
  expect(ownedDirectoryProblem(fake('file', 0o100600), UID)).toBe(
    'The directory path is not a directory.',
  );

  expect(ancestorProblem(fake('directory', 0o40755), UID, UID)).toBeUndefined();
  expect(ancestorProblem(fake('directory', 0o40755, 0), UID, UID)).toBeUndefined();
  expect(ancestorProblem(fake('directory', 0o40750), UID, UID)).toBeUndefined();
  expect(ancestorProblem(fake('directory', 0o40775), UID, UID)).toBe(E4);
  expect(ancestorProblem(fake('directory', 0o40757), UID, UID)).toBe(E4);
  expect(ancestorProblem(fake('directory', 0o40775, 0), UID, UID)).toBe(E4);
  expect(ancestorProblem(fake('directory', 0o40755, OTHER), UID, UID)).toBe(E5);
  // A sticky shared directory such as /tmp protects an entry only its owner or root can move.
  expect(ancestorProblem(fake('directory', 0o41777, 0), UID, UID)).toBeUndefined();
  expect(ancestorProblem(fake('directory', 0o41777, 0), UID, 0)).toBeUndefined();
  expect(ancestorProblem(fake('directory', 0o41777, 0), UID, OTHER)).toBe(E4);
  expect(ancestorProblem(fake('directory', 0o41777, 0), UID, undefined)).toBe(E4);
});

test('ACL entries: deny passes, any grant on the store and a changing grant above it fail', () => {
  const listing = [
    'drwxr-x---+ 152 me  staff  4864 Oct  9 14:47 /Users/me',
    ' 0: group:everyone deny delete',
    'drwx------  3 me  staff  96 Oct  9 14:47 /Users/me/Library/Application Support/family-mcp',
    '-rw-------+ 1 me  staff  32 Oct  9 14:47 /Users/me/key',
    ' 0: user:other allow read',
    ' 1: group:everyone inherited deny delete',
    '',
  ].join('\n');

  const [home, root, key] = aclEntries(listing);

  expect(aclEntries(listing)).toHaveLength(3);
  expect(home).toEqual([' 0: group:everyone deny delete']);
  expect(root).toEqual([]);
  expect(key).toHaveLength(2);

  for (const role of ['owned', 'ancestor'] as const) {
    expect(aclProblem(home ?? [], role, 'me')).toBeUndefined();
    expect(aclProblem([], role, 'me')).toBeUndefined();
    expect(aclProblem([' 0: something unexpected'], role, 'me')).toBe(
      role === 'owned' ? OWNED_ACL : ANCESTOR_ACL,
    );
  }

  expect(aclProblem(key ?? [], 'owned', 'me')).toBe(OWNED_ACL);
  expect(aclProblem([' 0: user:me allow read'], 'owned', 'me')).toBe(OWNED_ACL);
  expect(aclProblem(key ?? [], 'ancestor', 'me')).toBeUndefined();
  expect(aclProblem([' 0: user:me allow add_file,delete_child'], 'ancestor', 'me')).toBeUndefined();

  for (const permission of ['add_file', 'delete_child', 'add_subdirectory', 'writesecurity'])
    expect(
      aclProblem([` 0: group:staff inherited allow list,${permission}`], 'ancestor', 'me'),
    ).toBe(ANCESTOR_ACL);
});

test('the preflight passes on a missing store, creates nothing and reads no key', async () => {
  await scratch(async (root) => {
    const store = layout(root);
    expect(await checkSecretStore(store)).toEqual({ exists: false, retired: [] });
    expect(await listTree(root)).toEqual([]);
    expect(store.keys.reads).toBe(0);

    // Set up, then the preflight still reads nothing.
    await createSecretKey(store);
    await withSecretRecord(store, async () => 'secret');
    const reads = store.keys.reads;
    const before = await listTree(root);
    expect(await checkSecretStore(store)).toEqual({ exists: true, retired: [] });
    expect(store.keys.reads).toBe(reads);
    expect(await listTree(root)).toEqual(before);

    for (const directory of ['family-mcp', 'family-mcp/keys', 'family-mcp/test-mcp'])
      expect((await stat(join(root, directory))).mode & 0o777).toBe(0o700);

    for (const file of [store.key, store.path, `${store.path}.marker`])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

test('the preflight refuses unsafe files without reading the key', async () => {
  await scratch(async (root) => {
    const store = layout(root);
    await createSecretKey(store);
    await withSecretRecord(store, async () => 'secret');
    const reads = store.keys.reads;
    const marker = `${store.path}.marker`;

    for (const file of [store.key, store.path, marker]) {
      await chmod(file, 0o644);
      await assert.rejects(
        checkSecretStore(store),
        refused(
          'The file is accessible to other users; use owner-only permissions (chmod 600).',
          file,
        ),
      );
      await chmod(file, 0o600);

      const alias = join(root, 'alias');
      await link(file, alias);
      await assert.rejects(checkSecretStore(store), refused(HARD_LINKS, file));
      await rm(alias);
    }

    const saved = await readFile(store.key);
    await rm(store.key);
    await writeFile(join(root, 'elsewhere.key'), saved, { mode: 0o600 });
    await symlink(join(root, 'elsewhere.key'), store.key);
    await assert.rejects(
      checkSecretStore(store),
      refused('The path is a symbolic link; use a regular file.', store.key),
    );
    expect(store.keys.reads).toBe(reads);
  });
});

test('a store directory with group or other bits is refused and left unchanged', async () => {
  await scratch(async (root) => {
    const store = layout(root);
    const records = join(root, 'family-mcp', 'test-mcp');
    const keys = join(root, 'family-mcp', 'keys');
    await mkdir(records, { recursive: true, mode: 0o700 });
    await chmod(records, 0o750);

    await assert.rejects(checkSecretStore(store), refused(E3, records));
    await assert.rejects(
      withSecretStore(store, async () => assert.fail()),
      refused(E3, records),
    );
    expect((await stat(records)).mode & 0o777).toBe(0o750);
    expect(await readdir(records)).toEqual([]);

    await chmod(records, 0o700);
    await mkdir(keys, { mode: 0o750 });
    await chmod(keys, 0o750);
    await assert.rejects(store.keys.getKey(), refused(E3, keys));
    await assert.rejects(store.keys.createKey(), refused(E3, keys));
    await assert.rejects(createSecretKey(store), refused(E3, keys));
    expect(await readdir(keys)).toEqual([]);
    expect((await stat(keys)).mode & 0o777).toBe(0o750);

    // The store root is a store directory too.
    await chmod(keys, 0o700);
    await chmod(join(root, 'family-mcp'), 0o755);
    await assert.rejects(checkSecretStore(store), refused(E3, join(root, 'family-mcp')));
  });
});

test('a symlinked store directory is refused', async () => {
  await scratch(async (root) => {
    const store = layout(root);
    await mkdir(join(root, 'family-mcp'), { mode: 0o700 });
    await mkdir(join(root, 'real-records'), { mode: 0o700 });
    await mkdir(join(root, 'real-keys'), { mode: 0o700 });
    await symlink(join(root, 'real-records'), join(root, 'family-mcp', 'test-mcp'));
    await symlink(join(root, 'real-keys'), join(root, 'family-mcp', 'keys'));

    await assert.rejects(
      withSecretStore(store, async () => assert.fail()),
      refused(E1, join(root, 'family-mcp', 'test-mcp')),
    );
    await assert.rejects(store.keys.getKey(), refused(E1, join(root, 'family-mcp', 'keys')));
    await assert.rejects(store.keys.createKey(), refused(E1, join(root, 'family-mcp', 'keys')));
    expect(await readdir(join(root, 'real-keys'))).toEqual([]);
    expect(await readdir(join(root, 'real-records'))).toEqual([]);
  });
});

test('ancestors that another user could replace are refused, also above a missing store', async () => {
  await scratch(async (root) => {
    const shared = join(root, 'shared');
    await mkdir(shared, { mode: 0o775 });
    await chmod(shared, 0o775);
    const store = layout(shared);

    await assert.rejects(checkSecretStore(store), refused(E4, shared));
    await assert.rejects(
      withSecretStore(store, async () => assert.fail()),
      refused(E4, shared),
    );
    expect(await readdir(shared)).toEqual([]);

    // A link above the store is followed: the directory it resolves to is checked too.
    await chmod(shared, 0o755);
    const open = join(root, 'open');
    await mkdir(join(open, 'inner'), { recursive: true, mode: 0o700 });
    await chmod(open, 0o777);
    await symlink(join(open, 'inner'), join(root, 'alias'));
    await assert.rejects(
      checkSecretStore(layout(join(root, 'alias'))),
      refused(E4, await realpath(open)),
    );

    // Sticky and shared like /tmp: only this user can move the entry below it.
    await chmod(open, 0o1777);
    expect(await checkSecretStore(layout(join(root, 'alias')))).toEqual({
      exists: false,
      retired: [],
    });
  });
});

test.skipIf(process.platform !== 'darwin')(
  'macOS ACLs that grant other users access are refused; deny entries pass',
  async () => {
    await scratch(async (root) => {
      const store = layout(root);
      await createSecretKey(store);
      await withSecretRecord(store, async () => 'secret');
      const records = join(root, 'family-mcp', 'test-mcp');

      acl('+a', 'everyone deny delete', records);
      expect((await checkSecretStore(store)).exists).toBe(true);

      for (const path of [store.key, store.path, records]) {
        acl('+a', 'everyone allow read', path);
        await assert.rejects(checkSecretStore(store), refused(OWNED_ACL, path));
        acl('-a', 'everyone allow read', path);
      }

      acl('+a', 'everyone allow add_file,delete_child', root);
      await assert.rejects(checkSecretStore(store), refused(ANCESTOR_ACL, root));
      await assert.rejects(
        withSecretStore(store, async () => assert.fail()),
        refused(ANCESTOR_ACL, root),
      );
      acl('-a', 'everyone allow add_file,delete_child', root);

      // A read-only grant above the store cannot replace anything below it.
      acl('+a', 'everyone allow list,search', root);
      expect((await checkSecretStore(store)).exists).toBe(true);
    });
  },
);

test('key creation never replaces a key and leaves no temporary or partial key', async () => {
  await scratch(async (root) => {
    const { key, keys } = layout(root);
    const other = new LocalKeyFileProvider({ path: key });
    const results = await Promise.allSettled([keys.createKey(), other.createKey()]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    assert.ok(failure?.status === 'rejected');
    assert.ok(failure.reason instanceof SessionStoreError);
    expect(failure.reason.message).toBe('A store key already exists; it is never replaced.');

    const info = await stat(key);
    expect(info.size).toBe(32);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.nlink).toBe(1);
    expect(await readdir(join(root, 'family-mcp', 'keys'))).toEqual(['test-mcp.default.key']);

    const bytes = await readFile(key);
    await assert.rejects(keys.createKey(), (cause: unknown) => cause instanceof SessionStoreError);
    expect(await readFile(key)).toEqual(bytes);
  });
});

test('a crash at any key publication step restarts cleanly through the preflight', async () => {
  for (const step of ['written', 'linked'] as const)
    await scratch(async (root) => {
      const store = layout(root);
      const child = spawn(process.execPath, [worker, store.key, step], { stdio: 'inherit' });
      await once(child, 'exit');
      expect(child.signalCode).toBe('SIGKILL');
      const keyDirectory = join(root, 'family-mcp', 'keys');
      const left = await readdir(keyDirectory);

      if (step === 'written') {
        // No key yet: the temporary never became one, and setup simply runs again.
        expect(left).toHaveLength(1);
        expect((await checkSecretStore(store)).exists).toBe(false);
        await assert.rejects(
          store.keys.getKey(),
          (cause: unknown) =>
            cause instanceof SessionStoreError && cause.code === 'STORE_UNAVAILABLE',
        );
        await store.keys.createKey();
      } else {
        // The whole key, with the temporary as its second name.
        expect(left).toHaveLength(2);
        expect((await stat(store.key)).nlink).toBe(2);

        // Concurrent restarts all pass the preflight while the second name is still there.
        await Promise.all(Array.from({ length: 4 }, () => checkSecretStore(store)));
        expect(await store.keys.getKey()).toHaveLength(32);
        expect(await readdir(keyDirectory)).toEqual(['test-mcp.default.key']);
      }

      expect((await stat(store.key)).nlink).toBe(1);
      expect(await checkSecretStore(store)).toEqual({ exists: false, retired: [] });
      await withSecretRecord(store, async () => 'secret');
    });
});

test('only the store’s own temporary of the same key is recovered', async () => {
  await scratch(async (root) => {
    const { key, keys } = layout(root);
    await keys.createKey();
    const store = layout(root);

    // A hard link under any other name stays refused.
    const stray = join(root, 'family-mcp', 'keys', 'copy.key');
    await link(key, stray);
    await assert.rejects(checkSecretStore(store), refused(HARD_LINKS, key));
    await assert.rejects(
      keys.getKey(),
      (cause: unknown) => cause instanceof SessionStoreError && cause.message === HARD_LINKS,
    );
    await rm(stray);

    // A temporary name of another file is not the key's second name.
    const temporary = `${key}.${TEMPORARY}.tmp`;
    await writeFile(temporary, 'other', { mode: 0o600 });
    const outside = join(root, 'outside.key');
    await link(key, outside);
    await assert.rejects(checkSecretStore(store), refused(HARD_LINKS, key));
    expect(await readFile(temporary, 'utf8')).toBe('other');
    await rm(outside);
    await rm(temporary);

    // The recognised second name goes, and the key keeps its bytes.
    const bytes = await readFile(key);
    await link(key, temporary);
    await checkSecretStore(store);
    expect((await lstat(temporary)).nlink).toBe(2);
    expect(Buffer.from(await keys.getKey())).toEqual(bytes);
    expect(await readdir(join(root, 'family-mcp', 'keys'))).toEqual(['test-mcp.default.key']);
  });
});
