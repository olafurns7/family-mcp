import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KeychainAccessorKeyProvider,
  LocalKeyFileProvider,
  SessionStoreError,
  createSecretKey,
  defaultKeyProvider,
  defaultSecretRecordPath,
  readSecretRecord,
  withSecretRecord,
  type KeychainAccessorOptions,
} from '../src/index.js';

const SECRET_ENV = 'SESSION_STORE_TEST_TOKEN';

// The fake keychain keeps its one item in `<directory>/item`, exactly as `-w` prints it.
const FIND = '[ -f "$d/item" ] || exit 44; cat "$d/item"';

const ADD = `sed -n 's/^add-generic-password .* -w \\([0-9a-f]*\\) -T .*$/\\1/p' "$d/stdin" > "$d/item"`;

const HANG = 'echo $$ > "$d/pid"; exec sleep 30';

const hasCode =
  (code: string) =>
  (cause: unknown): boolean =>
    cause instanceof SessionStoreError && cause.code === code;

type Fake = { directory: string; options: KeychainAccessorOptions };

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-keychain-'));

  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A stand-in for security(1) that records its argv, environment and stdin. */
async function withFake(
  behaviour: { find?: string; add?: string },
  work: (fake: Fake) => Promise<void>,
): Promise<void> {
  await scratch(async (directory) => {
    const accessor = join(directory, 'security');

    await writeFile(
      accessor,
      [
        '#!/bin/sh',
        `d='${directory}'`,
        'printf \'%s\\n\' "$*" >> "$d/argv"',
        'env > "$d/env"',
        'if [ "$1" = -i ]; then',
        '  cat >> "$d/stdin"',
        `  ${behaviour.add ?? ADD}`,
        'else',
        `  ${behaviour.find ?? FIND}`,
        'fi',
        '',
      ].join('\n'),
    );
    await chmod(accessor, 0o700);
    await work({
      directory,
      options: { server: 'test-mcp', profile: 'default', accessor, readTimeoutMs: 5000 },
    });
  });
}

const read = (directory: string, name: string): Promise<string> =>
  readFile(join(directory, name), 'utf8');

async function expectKilled(directory: string): Promise<void> {
  const pid = Number(await read(directory, 'pid'));

  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('setup writes one add command on stdin and never puts the key in argv', async () => {
  process.env[SECRET_ENV] = 'inherited-secret';

  try {
    await withFake({}, async ({ directory, options }) => {
      const keys = new KeychainAccessorKeyProvider(options);

      await keys.createKey();
      const hex = Buffer.from(await keys.getKey()).toString('hex');
      expect(hex).toMatch(/^[0-9a-f]{64}$/);

      expect(await read(directory, 'stdin')).toBe(
        `add-generic-password -s family-mcp.test-mcp -a default.data-key -w ${hex} -T /usr/bin/security\n`,
      );

      const argv = await read(directory, 'argv');
      expect(argv).not.toContain(hex);
      expect(argv.split('\n')).toEqual([
        'find-generic-password -s family-mcp.test-mcp -a default.data-key -w',
        '-i',
        'find-generic-password -s family-mcp.test-mcp -a default.data-key -w',
        'find-generic-password -s family-mcp.test-mcp -a default.data-key -w',
        '',
      ]);

      const env = await read(directory, 'env');
      expect(env).toContain('PATH=/usr/bin:/bin\n');
      expect(env).not.toContain(SECRET_ENV);

      // An existing item is never replaced: the second setup stops at its lookup.
      await assert.rejects(keys.createKey(), hasCode('STORE_ERROR'));
      expect((await read(directory, 'stdin')).split('\n')).toHaveLength(2);
    });
  } finally {
    delete process.env[SECRET_ENV];
  }
});

test('encrypted records round-trip through the keychain provider', async () => {
  await withFake({}, async ({ directory, options }) => {
    const store = {
      path: join(directory, 'records', 'session.enc'),
      server: 'test-mcp',
      profile: 'default',
      purpose: 'session',
      schema: 1,
      keys: new KeychainAccessorKeyProvider(options),
      maxBytes: 1024,
    };

    await assert.rejects(readSecretRecord(store), hasCode('STORE_UNAVAILABLE'));
    await createSecretKey(store);
    await withSecretRecord(store, async () => 'refresh-token');
    expect(await readSecretRecord(store)).toBe('refresh-token');
    expect(await read(directory, 'records/session.enc.marker')).toContain(
      '"keySource":"keychain-accessor"',
    );
  });
});

test('reads accept exactly 64 lowercase hex characters and a newline', async () => {
  const hex = 'ab'.repeat(32);

  for (const [output, code] of [
    [`printf '${hex}\\n'`, undefined],
    [`printf '${hex.slice(2)}\\n'`, 'STORE_ERROR'],
    [`printf '${hex}0\\n'`, 'STORE_ERROR'],
    [`printf '${'g'.repeat(64)}\\n'`, 'STORE_ERROR'],
    [`printf '${hex.toUpperCase()}\\n'`, 'STORE_ERROR'],
    [`printf '${hex}'`, 'STORE_ERROR'],
    ['head -c 100000 /dev/zero', 'STORE_ERROR'],
  ] as const)
    await withFake({ find: output }, async ({ options }) => {
      const keys = new KeychainAccessorKeyProvider(options);

      if (code === undefined) expect(Buffer.from(await keys.getKey()).toString('hex')).toBe(hex);
      else await assert.rejects(keys.getKey(), hasCode(code));
    });
});

test('security(1) exit statuses map to fixed store codes', async () => {
  for (const [find, code] of [
    ['exit 44', 'STORE_UNAVAILABLE'],
    ['exit 36', 'STORE_LOCKED'],
    ['exit 29', 'STORE_LOCKED'],
    ['exit 51', 'STORE_ACCESS_DENIED'],
    ['exit 128', 'STORE_ACCESS_DENIED'],
    ['exit 1', 'STORE_ERROR'],
    ['exit 2', 'STORE_ERROR'],
    ['kill -9 $$', 'STORE_ERROR'],
  ] as const)
    await withFake({ find }, async ({ options }) => {
      const keys = new KeychainAccessorKeyProvider(options);

      await assert.rejects(keys.getKey(), hasCode(code));

      // A failed lookup other than a missing item never leads to a new key.
      if (code !== 'STORE_UNAVAILABLE') await assert.rejects(keys.createKey(), hasCode(code));
    });

  await scratch(async (directory) => {
    const keys = new KeychainAccessorKeyProvider({
      server: 'test-mcp',
      profile: 'default',
      accessor: join(directory, 'missing'),
    });

    await assert.rejects(keys.getKey(), hasCode('STORE_ERROR'));
  });
});

test('a read that overflows stdout is killed before its deadline', async () => {
  await withFake(
    { find: 'echo $$ > "$d/pid"; head -c 257 /dev/zero; exec sleep 30' },
    async ({ directory, options }) => {
      await assert.rejects(
        new KeychainAccessorKeyProvider(options).getKey(),
        hasCode('STORE_ERROR'),
      );
      await expectKilled(directory);
    },
  );
});

test('a hung read is killed at its deadline or on abort', async () => {
  await withFake({ find: HANG }, async ({ directory, options }) => {
    const keys = new KeychainAccessorKeyProvider({ ...options, readTimeoutMs: 200 });

    await assert.rejects(keys.getKey(), hasCode('STORE_TIMEOUT'));
    await expectKilled(directory);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(
      new KeychainAccessorKeyProvider(options).getKey(controller.signal),
      hasCode('CANCELLED'),
    );
    await expectKilled(directory);
    await assert.rejects(keys.getKey(AbortSignal.abort()), hasCode('CANCELLED'));
  });
});

test('a setup write that is not confirmed is uncertain and never retried', async () => {
  for (const add of [
    // Another key landed, -i exited 0 after a failed command, or the write failed outright.
    `printf '%064d\\n' 0 > "$d/item"`,
    'true',
    `${ADD}; exit 45`,
  ])
    await withFake({ add }, async ({ directory, options }) => {
      await assert.rejects(
        new KeychainAccessorKeyProvider(options).createKey(),
        hasCode('STORE_WRITE_UNCERTAIN'),
      );
      expect((await read(directory, 'argv')).match(/^-i$/gm)).toHaveLength(1);
    });

  await withFake({ add: HANG }, async ({ directory, options }) => {
    const keys = new KeychainAccessorKeyProvider({ ...options, createTimeoutMs: 200 });

    await assert.rejects(keys.createKey(), hasCode('STORE_WRITE_UNCERTAIN'));
    await expectKilled(directory);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(keys.createKey(controller.signal), hasCode('STORE_WRITE_UNCERTAIN'));
    await expectKilled(directory);
    await assert.rejects(keys.createKey(AbortSignal.abort()), hasCode('CANCELLED'));
  });
});

test('keychain names are validated', () => {
  for (const [server, profile] of [
    ['test mcp', 'default'],
    ['test-mcp', '-w'],
    ['test-mcp', ''],
  ] as const)
    assert.throws(() => new KeychainAccessorKeyProvider({ server, profile }), RangeError);
});

test('default key providers and record paths follow the platform and XDG', async () => {
  const saved = {
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
  };

  // Paths only: nothing here may create a key under the real home directory.
  try {
    const darwin = defaultKeyProvider({
      server: 'test-mcp',
      profile: 'default',
      platform: 'darwin',
    });

    expect(darwin).toBeInstanceOf(KeychainAccessorKeyProvider);
    expect(darwin.keySource).toBe('keychain-accessor');

    process.env['XDG_DATA_HOME'] = '/data';
    const linux = defaultKeyProvider({ server: 'test-mcp', profile: 'work', platform: 'linux' });

    assert.ok(linux instanceof LocalKeyFileProvider);
    expect(linux.path).toBe(join('/data', 'family-mcp', 'keys', 'test-mcp.work.key'));

    process.env['XDG_DATA_HOME'] = 'relative/data';

    const fallback = defaultKeyProvider({
      server: 'test-mcp',
      profile: 'default',
      platform: 'linux',
    });

    assert.ok(fallback instanceof LocalKeyFileProvider);
    expect(fallback.path).toBe(
      join(homedir(), '.local', 'share', 'family-mcp', 'keys', 'test-mcp.default.key'),
    );

    assert.throws(
      () => defaultKeyProvider({ server: 'test-mcp', profile: 'default', platform: 'win32' }),
      hasCode('STORE_UNAVAILABLE'),
    );
    assert.throws(
      () => defaultKeyProvider({ server: '../x', profile: 'default', platform: 'linux' }),
      RangeError,
    );

    process.env['XDG_CONFIG_HOME'] = '/config';
    expect(defaultSecretRecordPath('test-mcp')).toBe(join('/config', 'test-mcp', 'session.enc'));
    process.env['XDG_CONFIG_HOME'] = 'relative/config';
    expect(defaultSecretRecordPath('test-mcp')).toBe(
      join(homedir(), '.config', 'test-mcp', 'session.enc'),
    );
    assert.throws(() => defaultSecretRecordPath('../escape'), RangeError);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});
