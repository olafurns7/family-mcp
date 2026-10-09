import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalKeyFileProvider,
  SessionStoreError,
  createSecretKey,
  startupCheck,
  withSecretRecord,
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

test('an unsafe store gets one line naming the path and the fix', async () => {
  await scratch(async (root) => {
    const records = join(root, 'family-mcp', 'test-mcp');
    await mkdir(records, { recursive: true, mode: 0o700 });
    await chmod(records, 0o750);

    expect(await check({ store: () => store(root) })).toEqual({
      passed: false,
      text: `test-mcp: cannot start: The store directory is accessible to other users; use owner-only permissions (chmod 700). (${records})\n`,
    });
    expect(await readdir(records)).toEqual([]);

    // An unknown home is reported the same way, from building the store's options.
    expect(await check({ store: unknownHome })).toEqual({
      passed: false,
      text: 'test-mcp: cannot start: The home directory is not known; set HOME to an absolute path.\n',
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
        'test-mcp: an earlier build left a session store here; it is not used and nothing reads it:',
        `  ${join(old, 'session.enc')}`,
        `  ${join(old, "it's.marker")}`,
        `  ${join(old, 'session.enc.lock')}`,
        'Sign in again: test-mcp auth login',
        'After the new sign-in works, stop every test-mcp process, then remove the old files:',
        `  rm '${join(old, 'session.enc')}' '${join(old, "it'\\''s.marker")}'`,
        `  rm -r '${join(old, 'session.enc.lock')}'`,
        'If that build kept its key in the macOS Keychain, remove it too (Keychain Access may ask for your password):',
        '  security delete-generic-password -s family-mcp.test-mcp -a default.data-key',
        'Older Time Machine backups may still hold those files.',
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
