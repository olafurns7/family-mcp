import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AblerClient } from '../src/api.js';
import { importCookies, saveSession } from '../src/auth.js';

test('real loopback HTTP covers cookies, redirects, rate limits, and large bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-loopback-'));
  const path = join(directory, 'session.json');
  let mode: 'normal' | 'rate' | 'large' | 302 | 303 | 307 = 'normal';
  let followedRedirect = false;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === '/oauth/token') {
        if (mode === 302 || mode === 303 || mode === 307)
          return new Response(null, {
            status: mode,
            headers: { Location: '/redirect-target', 'Set-Cookie': 'redirect=private; Path=/' },
          });

        const response = Response.json({ access_token: 'access' });
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=600; HttpOnly');
        response.headers.append(
          'Set-Cookie',
          'refreshToken=rotated; Path=/; Max-Age=3600; HttpOnly',
        );

        return response;
      }

      if (url.pathname === '/graphql' && mode === 'rate')
        return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });

      if (url.pathname === '/graphql' && mode === 'large')
        return new Response(new Uint8Array(8 * 1024 * 1024 + 1));

      if (url.pathname === '/redirect-target') {
        followedRedirect = true;

        return Response.json({ access_token: 'unexpected' });
      }

      if (url.pathname === '/graphql')
        return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });

      const status = Number(url.pathname.slice('/redirect/'.length));

      if ([302, 303, 307].includes(status))
        return new Response(null, {
          status,
          headers: { Location: '/graphql', 'Set-Cookie': `redirect${status}=ok; Path=/` },
        });

      return new Response('unexpected', { status: 404 });
    },
  });

  const request = (url: string, init?: RequestInit): Promise<Response> => {
    const source = new URL(url);

    return fetch(`http://127.0.0.1:${server.port}${source.pathname}${source.search}`, init);
  };

  try {
    await saveSession(
      path,
      await importCookies([
        {
          name: 'refreshToken',
          value: 'refresh',
          domain: 'www.abler.io',
          path: '/',
          expires: Date.now() / 1000 + 3600,
        },
      ]),
    );
    const client = new AblerClient(path, request);
    assert.deepEqual(await client.status(true), {
      authenticated: true,
      account: { id: 'parent', displayName: 'Parent' },
    });

    const redirects: (302 | 303 | 307)[] = [302, 303, 307];

    for (const status of redirects) {
      mode = status;
      await assert.rejects(client.status(true), /Abler request failed/);
      assert.equal(followedRedirect, false);
    }

    mode = 'rate';
    await assert.rejects(client.status(true), /HTTP 429/);
    mode = 'large';
    await assert.rejects(client.status(true), /invalid API response/);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
