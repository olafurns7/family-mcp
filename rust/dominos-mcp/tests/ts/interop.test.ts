import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { DominosClient as Reference } from '../../../../packages/dominos-mcp/src/client.ts';
import {
  login as referenceLogin,
  logout as referenceLogout,
} from '../../../../packages/dominos-mcp/src/auth.ts';
import { DominosClient, login, logout } from './rust-dominos.ts';
import { scratchHome, filesContaining } from './scratch.ts';
import { profile, current } from './fixtures.ts';
const request = async (url: string) =>
  url.endsWith('/token')
    ? Response.json({
        access_token: 'interop-access',
        refresh_token: 'interop-refresh',
        username: '3545550123',
        token_type: 'bearer',
        expires_in: 3600,
      })
    : Response.json(profile);
for (const writer of ['ts', 'rust'])
  test(`${writer} writes a session the other language verifies and logs out`, async () => {
    const home = await scratchHome('dominos-interop-');
    const reader =
      writer === 'ts' ? new DominosClient(home.path, request) : new Reference(home.path, request);
    try {
      await (writer === 'ts' ? referenceLogin : login)('5550123', '123456', home.path, request);
      await assert.rejects(stat(home.path));
      assert.equal((await reader.status()).authenticated, true);
      assert.equal((await current(home.path)).refreshToken, 'interop-refresh');
      assert.deepEqual(
        await filesContaining(home.directory, ['interop-access', 'interop-refresh']),
        [],
      );
      await (writer === 'ts' ? logout : referenceLogout)(home.path);
      await assert.rejects(reader.status(), /No saved Domino’s session/);
    } finally {
      await reader.close();
      await home.cleanup();
    }
  });
