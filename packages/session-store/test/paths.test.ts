import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LocalKeyFileProvider,
  SessionStoreError,
  TEST_SEAM,
  defaultKeyProvider,
  defaultSecretRecordPath,
  retiredStorePaths,
} from '../src/index.js';

const hasCode =
  (code: string) =>
  (cause: unknown): boolean =>
    cause instanceof SessionStoreError && cause.code === code;

const MAC_ROOT = join('/Users/scratch', 'Library', 'Application Support', 'family-mcp');

type Environment = Record<string, string | undefined>;

/** Run `work` with these variables, restoring every one afterwards; paths only, no file is made. */
function withEnvironment(variables: Environment, work: () => void): void {
  const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));

  try {
    for (const [name, value] of Object.entries(variables))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    work();
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

/** Production macOS: the test seam off, a scratch HOME, and no XDG unless given. */
const production = (variables: Environment = {}) => ({
  [TEST_SEAM]: undefined,
  HOME: '/Users/scratch',
  XDG_CONFIG_HOME: undefined,
  XDG_DATA_HOME: undefined,
  FAMILY_MCP_KEY_BACKEND: undefined,
  ...variables,
});

function keyPath(platform: NodeJS.Platform, server = 'test-mcp', profile = 'work'): string {
  const keys = defaultKeyProvider({ server, profile, platform });

  assert.ok(keys instanceof LocalKeyFileProvider);
  expect(keys.keySource).toBe('local-file');
  expect(keys.keyId).toBe('local');

  return keys.path;
}

test('macOS keeps keys and records under Application Support and ignores XDG', () => {
  for (const xdg of [
    {},
    { XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' },
    { XDG_CONFIG_HOME: 'relative/config', XDG_DATA_HOME: 'relative/data' },
  ])
    withEnvironment(production(xdg), () => {
      expect(keyPath('darwin')).toBe(join(MAC_ROOT, 'keys', 'test-mcp.work.key'));
      expect(defaultSecretRecordPath('test-mcp', { platform: 'darwin' })).toBe(
        join(MAC_ROOT, 'test-mcp', 'session.enc'),
      );
    });
});

test('Linux keeps its XDG paths', () => {
  withEnvironment(production(), () => {
    expect(keyPath('linux')).toBe(
      join('/Users/scratch', '.local', 'share', 'family-mcp', 'keys', 'test-mcp.work.key'),
    );
    expect(defaultSecretRecordPath('test-mcp', { platform: 'linux' })).toBe(
      join('/Users/scratch', '.config', 'test-mcp', 'session.enc'),
    );
  });

  withEnvironment(production({ XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' }), () => {
    expect(keyPath('linux')).toBe(join('/data', 'family-mcp', 'keys', 'test-mcp.work.key'));
    expect(defaultSecretRecordPath('test-mcp', { platform: 'linux' })).toBe(
      join('/config', 'test-mcp', 'session.enc'),
    );
  });

  // Both XDG roots are absolute, so an unusable HOME does not matter.
  withEnvironment(
    production({ HOME: 'relative', XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' }),
    () => {
      expect(keyPath('linux')).toBe(join('/data', 'family-mcp', 'keys', 'test-mcp.work.key'));
    },
  );

  withEnvironment(production({ XDG_DATA_HOME: 'relative/data' }), () => {
    expect(keyPath('linux')).toBe(
      join('/Users/scratch', '.local', 'share', 'family-mcp', 'keys', 'test-mcp.work.key'),
    );
  });
});

test('the test seam makes macOS follow XDG like Linux', () => {
  withEnvironment(
    production({ [TEST_SEAM]: '1', XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' }),
    () => {
      expect(keyPath('darwin')).toBe(join('/data', 'family-mcp', 'keys', 'test-mcp.work.key'));
      expect(defaultSecretRecordPath('test-mcp', { platform: 'darwin' })).toBe(
        join('/config', 'test-mcp', 'session.enc'),
      );
      expect(retiredStorePaths('test-mcp', 'default', { platform: 'darwin' })).toEqual([]);
    },
  );

  // Only the exact value turns it on.
  withEnvironment(production({ [TEST_SEAM]: 'true', XDG_DATA_HOME: '/data' }), () => {
    expect(keyPath('darwin')).toBe(join(MAC_ROOT, 'keys', 'test-mcp.work.key'));
  });
});

test('a relative or unknown home is refused', () => {
  for (const home of ['relative', 'relative/home', '.'])
    withEnvironment(production({ HOME: home }), () => {
      for (const platform of ['darwin', 'linux'] as const) {
        for (const resolve of [
          () => defaultKeyProvider({ server: 'test-mcp', profile: 'default', platform }),
          () => defaultSecretRecordPath('test-mcp', { platform }),
        ])
          assert.throws(
            resolve,
            (cause: unknown) =>
              hasCode('STORE_UNAVAILABLE')(cause) &&
              cause instanceof Error &&
              cause.message === 'The home directory is not known; set HOME to an absolute path.',
          );
      }
    });
});

test('names are checked and keys is never a store name', () => {
  withEnvironment(production(), () => {
    for (const platform of ['darwin', 'linux'] as const) {
      assert.throws(() => defaultSecretRecordPath('../escape', { platform }), RangeError);
      assert.throws(() => defaultSecretRecordPath('keys', { platform }), RangeError);
      assert.throws(
        () => defaultKeyProvider({ server: '../x', profile: 'default', platform }),
        RangeError,
      );
    }
  });
});

test('the retired backend variable accepts only file or nothing', () => {
  for (const value of ['', 'file'])
    withEnvironment(production({ FAMILY_MCP_KEY_BACKEND: value }), () => {
      expect(keyPath('darwin')).toBe(join(MAC_ROOT, 'keys', 'test-mcp.work.key'));
    });

  for (const value of ['keychain', 'keychain-accessor', 'FILE', ' file', '0'])
    withEnvironment(production({ FAMILY_MCP_KEY_BACKEND: value }), () => {
      for (const platform of ['darwin', 'linux'] as const)
        assert.throws(
          () => defaultKeyProvider({ server: 'test-mcp', profile: 'default', platform }),
          (cause: unknown) =>
            hasCode('STORE_UNAVAILABLE')(cause) &&
            cause instanceof Error &&
            cause.message ===
              'FAMILY_MCP_KEY_BACKEND is not supported. Set it to file or unset it.',
        );
    });

  withEnvironment(production(), () => {
    assert.throws(
      () => defaultKeyProvider({ server: 'test-mcp', profile: 'default', platform: 'win32' }),
      hasCode('STORE_UNAVAILABLE'),
    );
  });
});

test('retired macOS layouts are named by path only', () => {
  withEnvironment(production(), () => {
    expect(retiredStorePaths('test-mcp', 'default', { platform: 'darwin' })).toEqual([
      '/Users/scratch/.config/test-mcp/session.enc',
      '/Users/scratch/.config/test-mcp/session.enc.marker',
      '/Users/scratch/.config/test-mcp/session.enc.lock',
      '/Users/scratch/.local/share/family-mcp/keys/test-mcp.default.key',
    ]);
    expect(retiredStorePaths('test-mcp', 'default', { platform: 'linux' })).toEqual([]);
  });

  // An earlier build honoured absolute XDG directories on macOS too.
  withEnvironment(production({ XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' }), () => {
    const paths = retiredStorePaths('test-mcp', 'default', { platform: 'darwin' });

    expect(paths).toContain('/config/test-mcp/session.enc.marker');
    expect(paths).toContain('/data/family-mcp/keys/test-mcp.default.key');
    expect(paths).toContain('/Users/scratch/.config/test-mcp/session.enc');
  });
});

test('no source file reaches the Keychain or security(1)', async () => {
  const source = fileURLToPath(new URL('../src/', import.meta.url));

  for (const name of await readdir(source)) {
    const text = await readFile(join(source, name), 'utf8');

    expect(text).not.toContain('/usr/bin/security');
    expect(text).not.toContain('find-generic-password');
  }
});
