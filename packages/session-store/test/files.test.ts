import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionStoreError,
  defaultSessionPath,
  ensurePrivateDir,
  readPrivateFile,
  sweepTemp,
  sweepTempInDirectory,
  writePrivateFile,
} from '../src/index.js';
import { fileChanged } from '../src/files.js';

const hasCode =
  (code: string) =>
  (cause: unknown): boolean =>
    cause instanceof SessionStoreError && cause.code === code;

test('detects inode, size, and modification-time changes between read stats', () => {
  const before = { ino: 1, size: 6, mtimeMs: 1000 };

  expect(fileChanged(before, before)).toBe(false);
  expect(fileChanged(before, { ...before, ino: 2 })).toBe(true);
  expect(fileChanged(before, { ...before, size: 7 })).toBe(true);
  expect(fileChanged(before, { ...before, mtimeMs: 1001 })).toBe(true);
});

test('private files are written atomically with owner-only permissions and read back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-files-'));
  const file = join(directory, 'nested', 'session.json');

  try {
    await writePrivateFile(file, '{"version":1}\n');
    expect(await readPrivateFile(file, { maxBytes: 1024 })).toBe('{"version":1}\n');

    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'nested'))).mode & 0o777).toBe(0o700);
    }

    await writePrivateFile(file, new TextEncoder().encode('replaced'), { fsync: false });
    expect(await readPrivateFile(file, { maxBytes: 8 })).toBe('replaced');
    await assert.rejects(readPrivateFile(file, { maxBytes: 7 }), hasCode('TOO_LARGE'));
    assert.deepEqual(await readdir(join(directory, 'nested')), ['session.json']);
    await assert.rejects(
      readPrivateFile(join(directory, 'missing.json'), { maxBytes: 8 }),
      hasCode('NOT_FOUND'),
    );
    await assert.rejects(
      readPrivateFile(join(directory, 'nested'), { maxBytes: 8 }),
      hasCode('UNSAFE_FILE'),
    );

    if (process.platform !== 'win32') {
      await chmod(file, 0o644);
      await assert.rejects(readPrivateFile(file, { maxBytes: 8 }), (cause: unknown) => {
        assert.ok(cause instanceof SessionStoreError);
        assert.equal(cause.code, 'UNSAFE_FILE');
        assert.match(cause.message, /chmod 600/);

        return true;
      });
      await chmod(file, 0o600);
      await symlink(file, join(directory, 'link.json'));
      await assert.rejects(
        readPrivateFile(join(directory, 'link.json'), { maxBytes: 8 }),
        (cause: unknown) => {
          assert.ok(cause instanceof SessionStoreError);
          assert.equal(cause.code, 'UNSAFE_FILE');
          assert.match(cause.message, /symbolic link/);

          return true;
        },
      );
      // A symbolic link at the destination is replaced by the rename, never followed.
      await writePrivateFile(join(directory, 'link.json'), 'unlinked');
      expect((await stat(file)).size).toBe(8);
      expect(await readPrivateFile(join(directory, 'link.json'), { maxBytes: 8 })).toBe('unlinked');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects hard-linked session files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-hard-link-'));
  const file = join(directory, 'session.json');

  try {
    await writePrivateFile(file, 'private');
    await link(file, join(directory, 'alias.json'));
    await assert.rejects(readPrivateFile(file, { maxBytes: 1024 }), hasCode('UNSAFE_FILE'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects files owned by another user', async () => {
  const getuid = process.getuid;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');

  if (getuid === undefined || descriptor === undefined) return;
  const directory = await mkdtemp(join(tmpdir(), 'session-store-foreign-owner-'));
  const file = join(directory, 'session.json');

  try {
    await writePrivateFile(file, 'private');
    Object.defineProperty(process, 'getuid', {
      ...descriptor,
      value: () => getuid() + 1,
    });
    await assert.rejects(readPrivateFile(file, { maxBytes: 1024 }), hasCode('UNSAFE_FILE'));
  } finally {
    Object.defineProperty(process, 'getuid', descriptor);
    await rm(directory, { recursive: true, force: true });
  }
});

test('an abort observed at the commit point keeps the previous file and leaves no temporary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-commit-'));
  const file = join(directory, 'session.json');

  try {
    await writePrivateFile(file, 'previous');
    await assert.rejects(
      writePrivateFile(file, 'never', { signal: AbortSignal.abort() }),
      hasCode('CANCELLED'),
    );

    // The signal reports "aborted" only on its second inspection: the temporary is fully written
    // and the abort is observed immediately before the rename.
    const controller = new AbortController();
    let inspections = 0;
    Object.defineProperty(controller.signal, 'aborted', { get: () => ++inspections > 1 });
    await assert.rejects(
      writePrivateFile(file, 'never', { signal: controller.signal }),
      hasCode('CANCELLED'),
    );
    expect(inspections).toBe(2);
    expect(await readFile(file, 'utf8')).toBe('previous');
    assert.deepEqual(await readdir(directory), ['session.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sweeping removes only old temporaries that belong to the target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-sweep-'));
  const file = join(directory, 'session.json');
  const old = new Date(Date.now() - 600_000);

  try {
    await writePrivateFile(file, 'live');
    const staleFile = `${file}.${randomUUID()}.tmp`;
    const staleLock = `${file}.lock.${process.pid}-${randomUUID()}.tmp`;
    const fresh = `${file}.${randomUUID()}.tmp`;
    const pending = `${file}.${randomUUID()}.pending`;
    const unrelated = join(directory, `other.json.${randomUUID()}.tmp`);
    await writeFile(staleFile, '', { mode: 0o600 });
    await mkdir(staleLock, { mode: 0o700 });
    await writeFile(join(staleLock, 'owner'), '', { mode: 0o600 });
    await writeFile(fresh, '', { mode: 0o600 });
    await writeFile(pending, '', { mode: 0o600 });
    await writeFile(unrelated, '', { mode: 0o600 });

    for (const path of [staleFile, staleLock, pending, unrelated]) await utimes(path, old, old);
    expect(await sweepTemp(file)).toBe(2);
    assert.deepEqual(
      (await readdir(directory)).toSorted(),
      [fresh, pending, unrelated, file].map((path) => path.slice(directory.length + 1)).toSorted(),
    );
    expect(await sweepTemp(file)).toBe(0);
    expect(await sweepTempInDirectory(directory)).toBe(1);

    await utimes(fresh, old, old);
    expect(await sweepTempInDirectory(directory, { olderThanMs: 0 })).toBe(1);
    assert.deepEqual(
      (await readdir(directory)).toSorted(),
      ['session.json', pending.slice(directory.length + 1)].toSorted(),
    );
    expect(await sweepTemp(join(directory, 'absent', 'session.json'))).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('private directories are created with 0700 and tightened only on request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-dir-'));

  try {
    await ensurePrivateDir(join(directory, 'a', 'b'));

    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'a', 'b'))).mode & 0o777).toBe(0o700);
      await chmod(join(directory, 'a'), 0o755);
      await ensurePrivateDir(join(directory, 'a'));
      expect((await stat(join(directory, 'a'))).mode & 0o777).toBe(0o755);
      await ensurePrivateDir(join(directory, 'a'), { enforceMode: true });
      expect((await stat(join(directory, 'a'))).mode & 0o777).toBe(0o700);
    }

    await writeFile(join(directory, 'file'), '');
    await assert.rejects(ensurePrivateDir(join(directory, 'file')), hasCode('IO'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the default session path follows XDG and keeps an existing legacy file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-path-'));
  const configured = process.env['XDG_CONFIG_HOME'];

  try {
    process.env['XDG_CONFIG_HOME'] = directory;
    expect(defaultSessionPath('abler-mcp')).toBe(join(directory, 'abler-mcp', 'session.json'));
    const legacy = join(directory, 'legacy', 'session.json');
    expect(defaultSessionPath('infomentor-mcp', { legacy })).toBe(
      join(directory, 'infomentor-mcp', 'session.json'),
    );
    await writePrivateFile(legacy, '{}');
    expect(defaultSessionPath('infomentor-mcp', { legacy })).toBe(legacy);
    expect(defaultSessionPath('infomentor-mcp', { legacy: join(directory, 'legacy') })).toBe(
      join(directory, 'infomentor-mcp', 'session.json'),
    );
    process.env['XDG_CONFIG_HOME'] = 'relative/config';
    expect(defaultSessionPath('abler-mcp')).not.toContain('relative');
    assert.throws(() => defaultSessionPath('../escape'), RangeError);
  } finally {
    if (configured === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = configured;
    await rm(directory, { recursive: true, force: true });
  }
});
