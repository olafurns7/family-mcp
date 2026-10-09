import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalKeyFileProvider,
  StoreRefusal,
  TEST_TMUTIL,
  checkSecretStore,
  createSecretKey,
  withSecretRecord,
  withSecretStore,
  type SecretRecordOptions,
} from '../src/index.js';
import { runBounded } from '../src/spawn.js';

const NOT_EXCLUDED =
  'Time Machine did not confirm that it skips this store folder. After the fix, tmutil isexcluded should show [Excluded].';

const ATTRIBUTE = 'com.apple.metadata:com_apple_backup_excludeItem';

type Mode = 'works' | 'ignores-attribute' | 'fails' | 'hangs' | 'lies';

/**
 * A fake tmutil that logs each call with its stdin state and the directory's entries at that
 * moment. `isexcluded` reports a directory excluded when it carries the real exclusion attribute
 * (unless the mode ignores it) or `addexclusion` named it before. It runs with only PATH and
 * HOME, so its own paths are written into it.
 */
async function fakeTmutil(directory: string, mode: Mode) {
  const log = join(directory, 'tmutil.log');
  const state = join(directory, 'tmutil.state');
  const executable = join(directory, 'tmutil');
  await writeFile(state, '');

  await writeFile(
    executable,
    `#!/bin/sh
if read -r line; then input=data; else input=eof; fi
echo "$1 stdin=$input" >> '${log}'
command=$1
shift
for path in "$@"; do echo "  $path: $(ls -A "$path" | tr '\\n' ' ')" >> '${log}'; done
case ${mode} in
  fails) exit 1 ;;
  hangs) sleep 60 ;;
esac
case $command in
  addexclusion) for path in "$@"; do echo "$path" >> '${state}'; done ;;
  isexcluded)
    for path in "$@"; do
      if [ ${mode} = lies ]; then excluded=no
      elif grep -qxF "$path" '${state}'; then excluded=yes
      elif [ ${mode} = works ] && /usr/bin/xattr -p ${ATTRIBUTE} "$path" >/dev/null 2>&1; then excluded=yes
      else excluded=no; fi
      if [ $excluded = yes ]; then echo "[Excluded]    $path"; else echo "[Included]    $path"; fi
    done ;;
esac
`,
  );
  await chmod(executable, 0o700);

  return {
    executable,
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).replace(/\n$/, '').split('\n'),
  };
}

function attribute(path: string): boolean {
  try {
    execFileSync('/usr/bin/xattr', ['-p', ATTRIBUTE, path], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
}

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-backup-'));
  const saved = process.env[TEST_TMUTIL];

  try {
    await work(directory);
  } finally {
    if (saved === undefined) delete process.env[TEST_TMUTIL];
    else process.env[TEST_TMUTIL] = saved;
    await rm(directory, { recursive: true, force: true });
  }
}

function layout(root: string): SecretRecordOptions {
  return {
    path: join(root, 'family-mcp', 'test-mcp', 'session.enc'),
    server: 'test-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    keys: new LocalKeyFileProvider({ path: join(root, 'family-mcp', 'keys', 'test-mcp.key') }),
    maxBytes: 1024,
  };
}

const darwin = process.platform === 'darwin';

test.skipIf(!darwin)(
  'setup excludes each directory before any secret is written in it',
  async () => {
    for (const mode of ['works', 'ignores-attribute'] as const)
      await scratch(async (directory) => {
        const tmutil = await fakeTmutil(directory, mode);
        process.env[TEST_TMUTIL] = tmutil.executable;
        const store = layout(join(directory, 'home'));
        const records = join(directory, 'home', 'family-mcp', 'test-mcp');
        const keys = join(directory, 'home', 'family-mcp', 'keys');

        await createSecretKey(store);
        await withSecretRecord(store, async () => 'secret');
        expect(attribute(records)).toBe(true);
        expect(attribute(keys)).toBe(true);

        // The attribute is confirmed by isexcluded; addexclusion runs only when that fails. Each
        // directory is still empty when it is confirmed, and stdin is closed.
        const confirmed = (path: string) => [
          'isexcluded stdin=eof',
          `  ${path}: `,
          'isexcluded stdin=eof',
          `  ${path}: `,
          ...(mode === 'works'
            ? []
            : ['addexclusion stdin=eof', `  ${path}: `, 'isexcluded stdin=eof', `  ${path}: `]),
        ];

        expect(await tmutil.calls()).toEqual([...confirmed(records), ...confirmed(keys)]);

        // A start confirms again; a lost exclusion is applied again before the server serves.
        execFileSync('/usr/bin/xattr', ['-d', ATTRIBUTE, records]);
        await checkSecretStore(store);
        // The fallback fake remembers addexclusion by path, so only the attribute fake loses it.
        expect(attribute(records)).toBe(mode === 'works');
        expect((await tmutil.calls()).findLast((line) => !line.startsWith(' '))).toBe(
          'isexcluded stdin=eof',
        );

        // A directory that is removed and made again is excluded again.
        await rm(records, { recursive: true });
        await withSecretStore(store, async () => undefined);
        expect(attribute(records)).toBe(mode === 'works');
      });
  },
);

test.skipIf(!darwin)('a store that cannot be excluded is refused before any secret', async () => {
  for (const mode of ['fails', 'lies'] as const)
    await scratch(async (directory) => {
      process.env[TEST_TMUTIL] = (await fakeTmutil(directory, mode)).executable;
      const store = layout(join(directory, 'home'));

      await assert.rejects(
        createSecretKey(store),
        (cause: unknown) => cause instanceof StoreRefusal && cause.message === NOT_EXCLUDED,
      );
      await assert.rejects(store.keys.createKey(), StoreRefusal);
      // The record directory was made for the exclusion, and nothing went into it.
      expect(await readdir(join(directory, 'home', 'family-mcp', 'test-mcp'))).toEqual([]);
      expect(await readdir(join(directory, 'home', 'family-mcp', 'keys'))).toEqual([]);
    });
});

test.skipIf(!darwin)(
  'a hung tmutil is abandoned within its bound',
  async () => {
    await scratch(async (directory) => {
      process.env[TEST_TMUTIL] = (await fakeTmutil(directory, 'hangs')).executable;
      const started = performance.now();

      await assert.rejects(
        withSecretStore(layout(join(directory, 'home')), async () => assert.fail()),
        (cause: unknown) => cause instanceof StoreRefusal && cause.message === NOT_EXCLUDED,
      );
      expect(performance.now() - started).toBeLessThan(7000);
    });
  },
  20_000,
);

test('a bounded child settles at its deadline even when its output stays open', async () => {
  const started = performance.now();

  // The grandchild keeps stdout open long after the shell ignored SIGTERM and exited.
  const run = await runBounded(
    '/bin/sh',
    ['-c', 'trap "" TERM; (sleep 30 &); echo started; sleep 30'],
    { timeoutMs: 300, maxBytes: 1024 },
  );

  expect(performance.now() - started).toBeLessThan(2000);
  expect(run).toEqual({ status: null, stdout: 'started\n', failure: 'timeout' });

  const overflow = await runBounded('/bin/sh', ['-c', 'yes'], { timeoutMs: 5000, maxBytes: 64 });
  expect(overflow.failure).toBe('overflow');
});

test('no tmutil runs off macOS or under the test seam without a fake', async () => {
  await scratch(async (directory) => {
    const tmutil = await fakeTmutil(directory, 'works');
    const store = layout(join(directory, 'home'));

    if (darwin) delete process.env[TEST_TMUTIL];
    else process.env[TEST_TMUTIL] = tmutil.executable;
    await createSecretKey(store);
    await withSecretRecord(store, async () => 'secret');
    await checkSecretStore(store);
    expect(await tmutil.calls()).toEqual(['']);
    expect(darwin && attribute(join(directory, 'home', 'family-mcp', 'keys'))).toBe(false);
  });
});
