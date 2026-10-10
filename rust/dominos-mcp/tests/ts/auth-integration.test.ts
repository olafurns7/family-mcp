// Original TS auth/rotation cases with the client and auth commands supplied by the binary.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  loadSession,
  saveSession,
  SESSION_MAX_BYTES,
  withSession,
  type Session,
} from '../../../../packages/dominos-mcp/src/auth.ts';
import { login, logout, migrate, sessionStorage, DominosClient } from './rust-dominos.ts';
import { filesContaining, scratchHome } from './scratch.ts';
import { setup, saved, current, TOKENS } from './fixtures.ts';
for (const legacy of [false, true])
  test(`concurrent clients serialize refresh and persist rotated tokens (${legacy ? 'plaintext file' : 'store'})`, async () => {
    const fixture = await setup(true, legacy);
    const other = new DominosClient(fixture.path, fixture.provider.request);

    try {
      await Promise.all([fixture.client.status(), other.status()]);
      assert.equal(fixture.provider.refreshes, 1);

      const bodies = fixture.provider.requests
        .filter(({ url }) => url.pathname === '/api/token')
        .map(({ options }) => options.body);

      assert.deepEqual(bodies, ['grant_type=refresh_token&refresh_token=synthetic-refresh']);
      assert.equal((await current(fixture.path)).refreshToken, 'rotated-refresh');

      if (legacy) {
        // Before migration the plaintext file stays authoritative, refreshes included.
        assert.equal((await loadSession(fixture.path)).refreshToken, 'rotated-refresh');
        await assert.rejects(stat(fixture.home.record));
        await assert.rejects(stat(`${fixture.home.record}.marker`));
        assert.equal(
          await sessionStorage(fixture.path),
          'Saved in a plaintext file. Run dominos-mcp auth migrate.',
        );
      } else {
        await assert.rejects(stat(fixture.path));
        assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
      }
    } finally {
      await Promise.all([fixture.client.close(), other.close()]);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

test('a read retried after 401 refreshes once inside the same store hold', async () => {
  const fixture = await setup();
  const { request } = fixture.provider;
  let rejected = 0;

  const client = new DominosClient(fixture.path, async (url, options) => {
    if (
      new URL(url).pathname === '/api/user/newuser' &&
      new Headers(options.headers).get('authorization') === 'bearer synthetic-access'
    ) {
      rejected++;

      return new Response('', { status: 401 });
    }

    return request(url, options);
  });

  try {
    assert.equal((await client.status()).authenticated, true);
    assert.equal(rejected, 1);
    assert.equal(fixture.provider.refreshes, 1);
    assert.equal((await current(fixture.path)).accessToken, 'rotated-access');
    assert.match(await readFile(`${fixture.home.record}.marker`, 'utf8'), /"generation":2\}/);
    assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
  } finally {
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a refreshed session for another account is rejected and nothing is saved', async () => {
  const fixture = await setup(true);
  const marker = `${fixture.home.record}.marker`;
  const { request } = fixture.provider;

  const client = new DominosClient(fixture.path, async (url, options) => {
    if (new URL(url).pathname === '/api/token')
      return Response.json({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        token_type: 'bearer',
        username: '3545550999',
        expires_in: 3600,
      });

    return request(url, options);
  });

  try {
    const files = async () => [await readFile(fixture.home.record), await readFile(marker)];
    const before = await files();
    await assert.rejects(client.status(), /refreshed Domino’s account differs/);
    assert.deepEqual(await files(), before);
    assert.equal(fixture.provider.requests.length, 0);
    assert.equal((await current(fixture.path)).refreshToken, 'synthetic-refresh');
  } finally {
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

/** The longest JSON a schema-valid session can have, at a given token. */
const worst = (token: string): Session => ({
  version: 1,
  accessToken: token,
  refreshToken: token,
  username: '\u0001'.repeat(256),
  expiresAt: -Number.MAX_VALUE,
});

test('the largest schema-valid session fits the store, so a refreshed one is always storable', async () => {
  const home = await scratchHome('dominos-size-test-');

  try {
    const largest = worst('"'.repeat(32768));
    assert.equal(Buffer.byteLength(JSON.stringify(largest)), SESSION_MAX_BYTES);
    await assert.rejects(saveSession(home.path, worst('"'.repeat(32769))));
    await assert.rejects(saveSession(home.path, { ...largest, username: '\u0001'.repeat(257) }));

    await saveSession(home.path, largest);
    assert.equal(await migrate(home.path), 'migrated');
    assert.deepEqual(await current(home.path), largest);
  } finally {
    await home.cleanup();
  }
});

test('a refreshed session that cannot be stored poisons the old record and nothing retries', async () => {
  const fixture = await setup(true);
  const marker = `${fixture.home.record}.marker`;
  const { request } = fixture.provider;

  const client = new DominosClient(fixture.path, async (url, options) => {
    // Domino's consumes the refresh token, then the store refuses the pending marker.
    if (new URL(url).pathname === '/api/token') {
      await rename(marker, `${marker}.aside`);
      await mkdir(join(marker, 'blocked'), { recursive: true });
    }

    return request(url, options);
  });

  try {
    await assert.rejects(client.status(), /did not complete, so its session is not used/);
    assert.equal(fixture.provider.refreshes, 1);
    assert.equal(fixture.provider.requests.length, 1);
    await assert.rejects(stat(fixture.home.record));

    // Once the store works again, the consumed refresh token is never offered a second time.
    await rm(marker, { recursive: true });
    await rename(`${marker}.aside`, marker);

    // Login refuses too, before the SMS code is exchanged.
    for (const run of [
      () => client.status(),
      () => sessionStorage(fixture.path),
      () => login('5550123', '123456', fixture.path, request),
    ])
      await assert.rejects(run(), /did not complete.*run dominos-mcp auth login again/);
    assert.equal(fixture.provider.requests.length, 1);
    assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
  } finally {
    await client.close();
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('without any saved session every command says to sign in', async () => {
  const home = await scratchHome('dominos-empty-test-');

  try {
    await assert.rejects(sessionStorage(home.path), /No saved Domino’s session/);
    await assert.rejects(migrate(home.path), /No saved Domino’s session/);
    await logout(home.path);
    await assert.rejects(stat(home.record));
  } finally {
    await home.cleanup();
  }
});

test('a lost key fails closed until an explicit login replaces the store', async () => {
  const fixture = await setup();

  try {
    await rm(fixture.home.key);
    await saveSession(fixture.path, saved(false, 'planted'));
    await assert.rejects(fixture.client.status(), /store key is missing/);
    assert.equal(fixture.provider.requests.length, 0);
    await assert.rejects(sessionStorage(fixture.path), /store key is missing/);
    await assert.rejects(migrate(fixture.path), /store key is missing/);
    await assert.rejects(logout(fixture.path), /store key is missing/);
    assert.ok(await stat(fixture.path));

    assert.equal(await login('5550123', '123456', fixture.path, fixture.provider.request), true);
    await assert.rejects(stat(fixture.path));
    assert.equal((await fixture.client.status()).authenticated, true);
    assert.match(await readFile(`${fixture.home.record}.marker`, 'utf8'), /"generation":1\}/);
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

/** Domino's refuses every request, so a login exchange fails. */
const rejecting = async () => new Response('', { status: 400 });

test('migrate resumes on an empty store with a marker, and refuses it untouched while its key is missing', async () => {
  const fixture = await setup();

  try {
    // A login after a lost key resets the store, then the code exchange fails: marker, no record.
    await rm(fixture.home.key);
    await assert.rejects(login('5550123', '123456', fixture.path, rejecting));
    await assert.rejects(stat(fixture.home.record));
    const key = await readFile(fixture.home.key);
    await rm(fixture.home.key);
    await saveSession(fixture.path, saved(false, 'planted'));
    const marker = await readFile(`${fixture.home.record}.marker`);

    await assert.rejects(migrate(fixture.path), /store key is missing/);
    await assert.rejects(stat(fixture.home.key));
    assert.deepEqual(await readFile(`${fixture.home.record}.marker`), marker);
    assert.ok(await stat(fixture.path));

    await writeFile(fixture.home.key, key, { mode: 0o600 });
    await assert.rejects(fixture.client.status(), /No saved Domino’s session/);
    assert.equal(await migrate(fixture.path), 'migrated');
    assert.equal((await current(fixture.path)).accessToken, 'planted-access');
    await assert.rejects(stat(fixture.path));
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a session path that aliases the store, its key or the checkouts is refused untouched', async () => {
  const fixture = await setup();
  const { record, key } = fixture.home;
  const storeDirectory = join(fixture.directory, 'config', 'dominos-mcp');
  const aliased = join(fixture.directory, 'aliased');
  await mkdir(aliased);
  await symlink(storeDirectory, join(aliased, 'session.checkouts'));
  await symlink(storeDirectory, join(fixture.directory, 'linked'));
  // Checkouts planted under a record temporary's exact name: refused, and never swept.
  const temporary = `${record}.${randomUUID()}.tmp`;
  const planted = join(temporary, 'session.json.checkouts', 'quote.json');
  await mkdir(dirname(planted), { recursive: true });
  await writeFile(planted, 'kept');
  await utimes(temporary, new Date(0), new Date(0));
  await symlink(temporary, join(aliased, 'temporary.checkouts'));

  const files = async () => [
    await readFile(record),
    await readFile(`${record}.marker`),
    await readFile(key),
  ];

  const before = await files();

  try {
    for (const path of [
      record,
      `${record}.marker`,
      `${record}.lock`,
      `${record}.tmp`,
      join(storeDirectory, 'session'),
      join(fixture.directory, 'linked', 'session.enc'),
      join(storeDirectory, 'nested', '..', 'session.enc'),
      key,
      storeDirectory,
      join(aliased, 'session'),
      join(temporary, 'session.json'),
      join(aliased, 'temporary'),
      join(dirname(key), 'dominos-mcp.default.key.lock', 'session.json'),
    ]) {
      for (const run of [
        () => login('5550123', '123456', path, fixture.provider.request),
        () => migrate(path),
        () => logout(path),
      ])
        await assert.rejects(run(), /DOMINOS_SESSION_FILE overlaps/);
      assert.deepEqual(await files(), before);
    }

    assert.equal(fixture.provider.requests.length, 0);
    assert.equal((await fixture.client.status()).authenticated, true);
    assert.equal(await readFile(planted, 'utf8'), 'kept');
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
