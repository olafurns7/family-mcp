// The TypeScript package and the Rust binary on one token store and one order-attempt record:
// whatever either writes, the other reads and honours. Run by tests/typescript.rs from
// packages/kronan-mcp, whose bunfig preload keeps the store in scratch directories.
import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePrivateFile } from '@family-mcp/session-store';

import { claimAttempt, readAttempts } from '../../../../packages/kronan-mcp/src/attempts.ts';
import * as typescript from '../../../../packages/kronan-mcp/src/auth.ts';

import * as rust from './rust-kronan.ts';

const TOKEN = 'synthetic-token-0123456789';

const NEXT = 'synthetic-token-next-4242';

const SCRATCH = await mkdtemp(join(tmpdir(), 'kronan-interop-'));

afterAll(() => rm(SCRATCH, { recursive: true, force: true }));

/** A legacy token path and store of their own; both sides read them from this environment. */
async function scratchStore(): Promise<string> {
  const directory = await mkdtemp(join(SCRATCH, 'case-'));
  process.env.KRONAN_TOKEN_FILE = join(directory, 'session.json');
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  process.env.XDG_DATA_HOME = join(directory, 'data');

  return directory;
}

const writeLegacyToken = (token: string) =>
  writePrivateFile(process.env.KRONAN_TOKEN_FILE!, JSON.stringify({ version: 1, token }) + '\n');

test('a token either side saves, migrates or removes is what the other reads', async () => {
  await scratchStore();

  await rust.saveToken(TOKEN);
  expect(await typescript.loadSavedToken()).toEqual({
    token: TOKEN,
    storage: 'Saved in an encrypted file.',
  });

  expect(await typescript.saveToken(NEXT)).toBe(false);
  expect(await rust.loadSavedToken()).toEqual({ token: NEXT, storage: 'Saved in an encrypted file.' });

  await rust.logoutToken();
  await assert.rejects(typescript.loadToken(), /No saved Krónan access token/);
  // A legacy file never counts once the store has decided, on either side.
  await writeLegacyToken(TOKEN);
  await assert.rejects(typescript.loadToken(), /No saved Krónan access token/);
  await assert.rejects(rust.loadToken(), /No saved Krónan access token/);
  expect(await typescript.migrateToken()).toBe('already-removed-legacy');

  await typescript.saveToken(TOKEN);
  await typescript.logoutToken();
  await assert.rejects(rust.loadToken(), /No saved Krónan access token/);
});

test('a legacy token migrated by either side is the store record the other reads', async () => {
  await scratchStore();
  await writeLegacyToken(TOKEN);
  expect(await rust.loadSavedToken()).toEqual({
    token: TOKEN,
    storage: 'Saved in a plaintext file. Run kronan-mcp auth migrate.',
  });
  expect(await rust.migrateToken()).toBe('migrated');
  await assert.rejects(stat(process.env.KRONAN_TOKEN_FILE!), { code: 'ENOENT' });
  expect(await typescript.loadToken()).toBe(TOKEN);
  expect(await typescript.migrateToken()).toBe('already');

  await scratchStore();
  await writeLegacyToken(NEXT);
  expect(await typescript.migrateToken()).toBe('migrated');
  expect(await rust.loadToken()).toBe(NEXT);
  expect(await rust.migrateToken()).toBe('already');

  // A key the TypeScript side created is the key the binary uses, and the other way round.
  const key = await readFile(join(process.env.XDG_DATA_HOME!, 'family-mcp', 'keys', 'kronan-mcp.default.key'));
  expect(key).toHaveLength(32);
});

test('an order attempt the TypeScript client recorded blocks and lists in the binary', async () => {
  await scratchStore();
  const attempts = rust.attemptsPath();
  expect(attempts).toBe(typescript.tokenPath() + '.order-attempts.json');

  const outcome = await claimAttempt(attempts, {
    tool: 'reserve_pickup_slot',
    expectedCheckoutToken: 'checkout-token',
    signal: new AbortController().signal,
    gate: async () => ({ token: 'checkout-token', total: 990, print: 'lines' }),
    send: async () => ({ orderToken: 'order-token' }),
    orderToken: (value) => value.orderToken,
  });
  expect(outcome).toEqual({ orderToken: 'order-token' });
  const [recorded] = await readAttempts(attempts);
  assert(recorded);

  const listed = Bun.spawnSync([process.env.KRONAN_RUST_BINARY!, 'orders', 'clear-attempts'], {
    env: { ...process.env, KRONAN_TEST_ORIGIN: rust.NOWHERE },
    stdin: new Blob(['n\n']),
  });
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString()).toContain(
    `  ${recorded.createdAt}  reserve_pickup_slot  accepted  checkout checkout-token  total 990 ISK  order order-token\n`,
  );
  expect(await readAttempts(attempts)).toEqual([recorded]);
});
