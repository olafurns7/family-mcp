// `auth capture` and real loopback HTTP against the Rust binary, run by tests/browser.rs from
// packages/abler-mcp. These are the capture cases of packages/abler-mcp/test/integration.test.ts
// and the case of test/loopback.test.ts; those call `captureCookies` and `AblerClient` in
// process, so here each step is a command of ABLER_RUST_BINARY and the Chrome side is the
// package's own test/cdp-mock.ts.
import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ORIGIN, withSession, type Slot } from '../../../../packages/abler-mcp/src/auth.js';
import { createCdpMock } from '../../../../packages/abler-mcp/test/cdp-mock.js';
import { filesContaining, useScratchStore } from '../../../../packages/abler-mcp/test/scratch.js';

const rustBinary = process.env.ABLER_RUST_BINARY;

if (!rustBinary) throw new RangeError('ABLER_RUST_BINARY must name the Rust abler-mcp binary.');

// Rust: the store key is the key file in every test, never the login Keychain.
if (process.env.FAMILY_MCP_KEY_BACKEND !== 'file')
  throw new RangeError('Tests must keep FAMILY_MCP_KEY_BACKEND=file; the Keychain is never used.');

const store = useScratchStore();

/** A closed loopback port: no case may reach Abler, whatever the binary does. */
const NOWHERE = 'http://127.0.0.1:9';

const savedCookies = (path: string, slot: Slot = 'current') =>
  withSession(
    path,
    slot,
    new AbortController().signal,
    async (jar) =>
      new Map((await jar.getCookies(`${ORIGIN}/`)).map(({ key, value }) => [key, value])),
  );

async function run(args: string[], sessionPath: string, origin = NOWHERE, input = '') {
  const child = Bun.spawn([rustBinary!, ...args], {
    env: { ...process.env, ABLER_SESSION_FILE: sessionPath, ABLER_TEST_ORIGIN: origin },
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exit, stdout, stderr };
}

/** Abler's side: every refresh rotates both cookies; records each request's path and cookies. */
function rotatingUpstream() {
  const seen: string[] = [];
  const cookies: string[] = [];
  let rotations = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;

      // Local port scanners probe new listeners at `/`; the client never requests it.
      if (path === '/') return new Response(null, { status: 404 });
      seen.push(path);
      cookies.push(request.headers.get('cookie') ?? '');

      if (path === '/oauth/token') {
        rotations += 1;
        const response = Response.json({ access_token: 'rotated-access' });
        response.headers.append(
          'Set-Cookie',
          `id_token=rotated-access-${rotations}; Path=/; Max-Age=600; HttpOnly`,
        );
        response.headers.append(
          'Set-Cookie',
          `refreshToken=rotated-refresh-${rotations}; Path=/; Max-Age=3600; HttpOnly`,
        );

        return response;
      }

      if (path === '/graphql')
        return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });

      return new Response('Not found', { status: 404 });
    },
  });

  return { server, seen, cookies, origin: `http://127.0.0.1:${server.port}` };
}

test('Chrome capture is limited to loopback and to the Abler tab', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-capture-'));
  const path = join(directory, 'session.json');
  const mockChrome = createCdpMock();
  const upstream = rotatingUpstream();

  try {
    const remote = await run(['auth', 'capture', 'https://example.com'], path);
    expect(remote.exit).toBe(1);
    assert.match(remote.stderr, /loopback/);

    const captured = await run(
      ['auth', 'capture', `http://127.0.0.1:${mockChrome.server.port}`],
      path,
      upstream.origin,
    );
    expect(captured.stderr).toBe('');
    expect(captured.exit).toBe(0);
    expect(mockChrome.requests).toHaveLength(1);
    expect(mockChrome.requests[0]?.method).toBe('Network.getCookies');
    expect(mockChrome.requests[0]?.params.urls).toEqual([
      `${ORIGIN}/oauth/token`,
      `${ORIGIN}/graphql`,
    ]);
    // The captured jar held only the tab's refresh cookie.
    expect(upstream.cookies[0]).toBe('refreshToken=private-refresh');
  } finally {
    await mockChrome.server.stop(true);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('capture saves only encrypted cookies, verified through the candidate slot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-rotation-'));
  const path = join(directory, 'session.json');
  const mockChrome = createCdpMock();
  const upstream = rotatingUpstream();
  const secrets = ['private-refresh', 'rotated-access', 'rotated-refresh'];

  try {
    const captured = await run(
      ['auth', 'capture', `http://127.0.0.1:${mockChrome.server.port}`],
      path,
      upstream.origin,
    );

    expect(captured.stderr).toBe('');
    expect(captured.stdout).toBe('Abler session saved and verified in the encrypted store.\n');
    expect(captured.exit).toBe(0);
    expect(upstream.seen).toEqual(['/oauth/token', '/graphql']);
    expect(upstream.cookies[0]).toBe('refreshToken=private-refresh');
    expect(upstream.cookies[1]).toContain('id_token=rotated-access-1');
    expect((await savedCookies(path)).get('refreshToken')).toBe('rotated-refresh-1');
    await assert.rejects(savedCookies(path, 'candidate'), /No retained Abler session candidate/);
    expect(await filesContaining(secrets, directory, store.home)).toEqual([]);
  } finally {
    await mockChrome.server.stop(true);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('capture reports each debugging failure with its fixed message and saves nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-capture-errors-'));
  const path = join(directory, 'session.json');
  const marker = 'PRIVATE_EXCEPTION_MARKER';
  let list: (port: number) => Response = () => new Response(marker);
  let reply: (id: number) => string | undefined = () => undefined;

  const chrome = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const { pathname } = new URL(request.url);

      if (pathname === '/json/list') return list(server.port ?? 0);

      if (pathname === '/elsewhere') return Response.json([]);

      if (server.upgrade(request)) return undefined;

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const answer = reply(JSON.parse(String(message)).id);

        if (answer === undefined) socket.close();
        else socket.send(answer);
      },
    },
  });

  const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const closedPort = closed.port;
  await closed.stop(true);

  const tabs = (socket: (port: number) => string) => (port: number) =>
    Response.json([
      { type: 'page', url: 'https://www.abler.io/coach', webSocketDebuggerUrl: socket(port) },
    ]);

  const here = tabs((port) => `ws://127.0.0.1:${port}/devtools/page/1`);
  const refresh = { name: 'refreshToken', value: 'private-refresh', domain: 'www.abler.io' };

  const check = async (expected: string, endpoint = `http://127.0.0.1:${chrome.port}`) => {
    const { exit, stdout, stderr } = await run(['auth', 'capture', endpoint], path);

    expect(stderr.trim()).toBe(expected);
    expect(stderr).not.toContain(marker);
    expect(stdout).toBe('');
    expect(exit).toBe(1);
  };

  try {
    const loopback = 'Use a loopback Chrome debugging URL, such as http://127.0.0.1:9222.';
    await check(loopback, marker);
    await check(loopback, 'http://192.168.0.1:9222');
    await check(loopback, `http://user:secret@127.0.0.1:${chrome.port}`);
    await check('Cannot connect to Chrome debugging.', `http://127.0.0.1:${closedPort}`);
    await check('Invalid Chrome debugging response.');
    list = () => new Response(marker, { status: 500 });
    await check('Cannot list Chrome debugging tabs.');
    list = () => new Response(null, { status: 302, headers: { Location: '/elsewhere' } });
    await check('Cannot connect to Chrome debugging.');
    list = () => Response.json([{ type: 'page', url: 'https://unrelated.example/' }]);
    await check('Open www.abler.io and sign in in that browser first.');
    list = tabs(() => `ws://127.0.0.1:${closedPort}/devtools/page/1`);
    await check('Chrome returned an unexpected debugging address.');
    list = tabs(() => 'ws://unrelated.example/devtools/page/1');
    await check('Chrome returned an unexpected debugging address.');

    list = here;
    await check('Chrome debugging connection closed.');
    reply = () => marker;
    await check('Invalid Chrome debugging response.');
    reply = (id) => JSON.stringify({ id, error: { code: -32000, message: marker } });
    await check('Invalid Chrome debugging response.');
    reply = (id) => JSON.stringify({ id, result: { cookies: [] }, error: { message: marker } });
    await check('Chrome rejected session capture.');
    reply = (id) => JSON.stringify({ id, result: { cookies: [] } });
    await check(
      'No unexpired Abler refreshToken cookie found. Sign in again and capture/import the session.',
    );
    reply = (id) => JSON.stringify({ id, result: { cookies: [{ ...refresh, value: 'a b' }] } });
    await check('Invalid Abler authentication cookie.');
    // A captured session Abler cannot be asked about is retained, never used.
    reply = (id) => JSON.stringify({ id, result: { cookies: [refresh] } });
    await check(
      'Session verification failed. The previous session was kept; the new one is retained in the encrypted store. Run abler-mcp auth retry-candidate, or capture a fresh session.',
    );
    await assert.rejects(savedCookies(path), /No saved Abler session/);
    expect((await savedCookies(path, 'candidate')).get('refreshToken')).toBe('private-refresh');
  } finally {
    await chrome.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('real loopback HTTP covers cookies, redirects, rate limits, and large bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-loopback-'));
  const path = join(directory, 'session.json');
  let mode: 'normal' | 'rate' | 'large' | 302 | 303 | 307 = 'normal';
  let followedRedirect = false;

  const server = Bun.serve({
    hostname: '127.0.0.1',
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
        // Short-lived, so each `auth status` below refreshes as `status(true)` does.
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=20; HttpOnly');
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

      return new Response('unexpected', { status: 404 });
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;

  const status = async () => {
    const { stdout, stderr } = await run(['auth', 'status'], path, origin);

    return stdout ? JSON.parse(stdout) : Promise.reject(new Error(stderr));
  };

  try {
    const imported = await run(
      ['auth', 'import', '-'],
      path,
      origin,
      JSON.stringify([
        {
          name: 'refreshToken',
          value: 'refresh',
          domain: 'www.abler.io',
          path: '/',
          expires: Date.now() / 1000 + 3600,
        },
      ]),
    );
    expect(imported.stderr).toBe('');
    assert.deepEqual(await status(), {
      authenticated: true,
      account: { id: 'parent', displayName: 'Parent' },
      storage: 'Saved in an encrypted file.',
    });

    const redirects: (302 | 303 | 307)[] = [302, 303, 307];

    for (const redirect of redirects) {
      mode = redirect;
      await assert.rejects(status(), /Abler request failed/);
      assert.equal(followedRedirect, false);
    }

    mode = 'rate';
    await assert.rejects(status(), /Abler returned an error/);
    mode = 'large';
    await assert.rejects(status(), /invalid API response/);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
