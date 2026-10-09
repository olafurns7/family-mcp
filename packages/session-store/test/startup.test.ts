import { expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { BigIntStats, PathLike, StatOptions, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalKeyFileProvider,
  SessionStoreError,
  createSecretKey,
  startupCheck,
  withSecretRecord,
  withSecretStore,
} from '../src/index.js';

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-startup-'));

  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function store(root: string, retired: string[] = []) {
  return {
    path: join(root, 'family-mcp', 'test-mcp', 'session.enc'),
    server: 'test-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    keys: new LocalKeyFileProvider({ path: join(root, 'family-mcp', 'keys', 'test-mcp.key') }),
    maxBytes: 1024,
    retired,
  };
}

function unknownHome(): never {
  throw new SessionStoreError(
    'STORE_UNAVAILABLE',
    'The home directory is not known; set HOME to an absolute path.',
  );
}

async function check(options: Partial<Parameters<typeof startupCheck>[0]>) {
  let text = '';

  const passed = await startupCheck({
    server: 'test-mcp',
    signIn: 'test-mcp auth login',
    store: () => store('/nowhere'),
    write: (line) => {
      text += line;
    },
    ...options,
  });

  return { passed, text };
}

test('an unsafe store gets the path and the exact command that fixes it', async () => {
  await scratch(async (root) => {
    // A space and a quote in the path, as in Application Support: the commands still paste.
    const base = join(root, "Owner's Support");
    const records = join(base, 'family-mcp', 'test-mcp');
    const quoted = `'${records.replaceAll("'", "'\\''")}'`;
    await mkdir(records, { recursive: true, mode: 0o700 });
    await chmod(records, 0o750);

    expect(await check({ store: () => store(base) })).toEqual({
      passed: false,
      text: [
        'test-mcp: cannot start. Other users can open this store folder.',
        `  Path: ${quoted}`,
        `  Fix:  chmod 700 ${quoted}`,
        '',
      ].join('\n'),
    });
    expect(await readdir(records)).toEqual([]);
    expect(
      execFileSync('/bin/sh', ['-c', `chmod 700 ${quoted} && echo done`], { encoding: 'utf8' }),
    ).toBe('done\n');

    // A refusal without a one-line fix names only the path.
    await chmod(records, 0o700);
    await mkdir(join(base, 'family-mcp', 'keys'), { mode: 0o700 });
    const key = join(base, 'family-mcp', 'keys', 'test-mcp.key');
    await writeFile(key, Buffer.alloc(32), { mode: 0o600 });
    await link(key, join(root, 'second-name'));

    expect(await check({ store: () => store(base) })).toEqual({
      passed: false,
      text: [
        'test-mcp: cannot start. This file has a second name (a hard link). Remove the other name and start again.',
        `  Path: '${key.replaceAll("'", "'\\''")}'`,
        '',
      ].join('\n'),
    });

    // An unknown home is reported the same way, from building the store's options.
    expect(await check({ store: unknownHome })).toEqual({
      passed: false,
      text: 'test-mcp: cannot start. The home directory is not known; set HOME to an absolute path.\n',
    });

    // Anything else is not a store refusal and is not hidden.
    await assert.rejects(
      check({
        store: () => {
          throw new TypeError('bug');
        },
      }),
      TypeError,
    );
  });
});

test('a safe store passes silently', async () => {
  await scratch(async (root) => {
    expect(await check({ store: () => store(root) })).toEqual({ passed: true, text: '' });
  });
});

test('an earlier build’s store gets the exact cleanup commands, by metadata only', async () => {
  await scratch(async (root) => {
    const old = join(root, 'old');
    await mkdir(join(old, 'session.enc.lock'), { recursive: true });
    // Unreadable files: the notice only knows they exist.
    await writeFile(join(old, 'session.enc'), 'x', { mode: 0o000 });
    await writeFile(join(old, "it's.marker"), 'x', { mode: 0o000 });

    const retired = [
      join(old, 'session.enc'),
      join(old, "it's.marker"),
      join(old, 'session.enc.lock'),
      join(old, 'test-mcp.default.key'),
    ];

    const before = await check({ store: () => store(root, retired) });

    expect(before).toEqual({
      passed: true,
      text: [
        'test-mcp: an earlier test build left an old session store. Nothing uses it:',
        `  ${join(old, 'session.enc')}`,
        `  ${join(old, "it's.marker")}`,
        `  ${join(old, 'session.enc.lock')}`,
        'Sign in again: test-mcp auth login',
        'After the new sign-in works, quit your MCP host (for example Claude Desktop) so no test-mcp is running, then remove the old files:',
        `  rm '${join(old, 'session.enc')}' '${join(old, "it'\\''s.marker")}'`,
        `  rm -r '${join(old, 'session.enc.lock')}'`,
        'If that build kept its key in the macOS Keychain, remove that too (macOS may ask for your login password):',
        '  security delete-generic-password -s family-mcp.test-mcp -a default.data-key',
        'Time Machine backups made before today may still hold copies of those files.',
        '',
      ].join('\n'),
    });

    // Signed in again with a key file left behind: no sign-in line and no Keychain step.
    await writeFile(join(old, 'test-mcp.default.key'), 'x', { mode: 0o000 });
    await createSecretKey(store(root));
    await withSecretRecord(store(root), async () => 'secret');
    const after = await check({ store: () => store(root, retired) });

    expect(after.passed).toBe(true);
    expect(after.text).not.toContain('Sign in again');
    expect(after.text).not.toContain('security delete-generic-password');
    expect(after.text).toContain(`'${join(old, 'test-mcp.default.key')}'`);
  });
});

test('the current store is never named as old, also through a link', async () => {
  await scratch(async (root) => {
    const current = store(root);
    await createSecretKey(current);
    await withSecretRecord(current, async () => 'secret');
    await mkdir(`${current.path}.lock`);

    // An old layout that is the current one under another name: a linked directory and a link.
    await symlink(join(root, 'family-mcp'), join(root, 'alias'));
    await mkdir(join(root, 'old'));
    await symlink(current.keys.path, join(root, 'old', 'test-mcp.default.key'));

    const aliases = [
      join(root, 'alias', 'test-mcp', 'session.enc'),
      join(root, 'alias', 'test-mcp', 'session.enc.marker'),
      join(root, 'alias', 'test-mcp', 'session.enc.lock'),
      join(root, 'old', 'test-mcp.default.key'),
    ];

    expect(await check({ store: () => store(root, aliases) })).toEqual({ passed: true, text: '' });
    expect(await withSecretStore(store(root, aliases), (held) => held.exists())).toBe(true);

    // A really separate old file is still named, and only that one.
    const separate = join(root, 'old', 'session.enc');
    await writeFile(separate, 'x', { mode: 0o600 });
    const { text } = await check({ store: () => store(root, [...aliases, separate]) });
    expect(text).toContain(`  rm '${separate}'\n`);
    expect(text).not.toContain(join(root, 'alias'));
    expect(text).not.toContain('test-mcp.default.key');
  });
});

test('a save during the check never makes the current store look old', async () => {
  await scratch(async (root) => {
    const current = store(root);
    await createSecretKey(current);
    await withSecretRecord(current, async () => 'secret');

    // The current files under other names: a linked directory, a link to the record, and a link
    // to the lock, which exists only while a save runs.
    await symlink(join(root, 'family-mcp'), join(root, 'alias'));
    await mkdir(join(root, 'old'));
    await symlink(current.path, join(root, 'old', 'session.enc'));
    await symlink(`${current.path}.lock`, join(root, 'old', 'session.enc.lock'));

    const aliases = [
      join(root, 'alias', 'test-mcp', 'session.enc'),
      join(root, 'alias', 'test-mcp', 'session.enc.marker'),
      join(root, 'old', 'session.enc'),
      join(root, 'old', 'session.enc.lock'),
    ];

    // Another process saves right after the check first looks at the record: the atomic rename
    // gives the record and its marker new inodes before the check looks at the old names.
    const { stat } = fs;
    let saved = false;

    function statThenSave(
      path: PathLike,
      options?: StatOptions & { bigint?: false | undefined },
    ): Promise<Stats>;
    function statThenSave(
      path: PathLike,
      options: StatOptions & { bigint: true },
    ): Promise<BigIntStats>;
    function statThenSave(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>;
    async function statThenSave(path: PathLike, options?: StatOptions) {
      const info = await stat(path, options);

      if (!saved && path === current.path) {
        saved = true;
        await withSecretRecord(current, async () => 'saved meanwhile');
      }

      return info;
    }

    const spy = spyOn(fs, 'stat').mockImplementation(statThenSave);

    try {
      expect(await check({ store: () => store(root, aliases) })).toEqual({
        passed: true,
        text: '',
      });
    } finally {
      spy.mockRestore();
    }

    expect(saved).toBe(true);
    expect(await withSecretRecord(current, async () => undefined)).toBe('saved meanwhile');
  });
});
