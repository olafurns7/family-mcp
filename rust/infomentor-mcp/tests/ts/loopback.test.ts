// packages/infomentor-mcp/test/loopback.test.ts against the Rust binary, run by tests/typescript.rs
// from packages/infomentor-mcp. Changed only where the case calls into the TypeScript process: a
// CLI login of ./rust-infomentor.ts runs the binary instead, and each other change is marked
// `Rust:`. Every request of the binary's test build already crosses real loopback HTTP.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { LOGIN_URL } from '../../../../packages/infomentor-mcp/src/session.js';
import { readStored, useScratchStore } from '../../../../packages/infomentor-mcp/test/scratch.js';
import { login } from './rust-infomentor.js';

const store = useScratchStore();

test('real loopback HTTP covers login redirects, cookies, rate limits, and body caps', async () => {
  const requests: string[] = [];

  const parent = {
    account: {
      currentUser: { id: 'parent' },
      pupils: [{ id: 'child', name: 'Child', selected: true, switchPupilUrl: null }],
    },
    apps: [],
  };

  const parentHtml = `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`;

  // Rust: the drop-in's loopback upstream serves this handler, with the InfoMentor URL as `url`.
  const fetcher = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);

    if (url.pathname === '/production/mentor/' && method === 'GET')
      return new Response(
        '<form method="POST" action="./"><input type="hidden" name="__VIEWSTATE" value="state"><input type="hidden" name="__EVENTVALIDATION" value="validation"></form>',
        { headers: { 'Set-Cookie': 'preflight=ok; Path=/; Secure; HttpOnly' } },
      );

    if (url.pathname === '/production/mentor/' && method === 'POST') {
      const body = String(init.body ?? '');

      if (body.includes('oauth_token'))
        return new Response(null, {
          status: 303,
          headers: {
            Location: 'https://minn.infomentor.is/Authentication/Authentication/LoginCallback',
            'Set-Cookie': 'relay=ok; Path=/; Secure; HttpOnly',
          },
        });

      return new Response(null, {
        status: 302,
        headers: { Location: 'https://minn.infomentor.is/authentication/authentication/login' },
      });
    }

    if (url.pathname === '/authentication/authentication/login')
      return new Response(
        '<form id="openid_message" method="post" action="https://im1.infomentor.is/production/mentor/"><input type="hidden" name="oauth_token" value="token"></form>',
      );

    if (url.pathname === '/Authentication/Authentication/LoginCallback')
      return new Response(null, {
        status: 307,
        headers: {
          Location: 'https://minn.infomentor.is/',
          'Set-Cookie': 'IMHome=ok; Path=/; Secure; HttpOnly',
        },
      });

    if (url.pathname === '/' && method === 'GET') return new Response(parentHtml);

    if (url.pathname === '/authentication/authentication/isauthenticated/')
      return new Response('true');

    return new Response('unexpected', { status: 404 });
  };

  const directory = await mkdtemp(join(tmpdir(), 'infomentor-loopback-'));
  const credentialsFile = join(directory, 'credentials.json');
  await writeFile(
    credentialsFile,
    JSON.stringify({ username: '0101991239', password: 'synthetic-password' }),
    { mode: 0o600 },
  );

  try {
    // Rust: a CLI login in place of authenticate and readParent; the stored session shows the
    // account and the cookie the relay set.
    await login({ sessionFile: join(directory, 'session.json'), credentialsFile, fetch: fetcher });
    const stored = await readStored(store);
    assert.equal(stored.session?.accountId, 'parent');
    assert.ok(
      stored.session?.cookies.some((cookie) => cookie.key === 'IMHome' && cookie.value === 'ok'),
    );
    // Rust: parseForms, the rate-limit and the body-cap requests call InfoMentorHttp, which is
    // internal to the binary: html.rs's unit tests parse forms, and parity.ts's parent-429,
    // parent-429-date and parent-large scenarios compare the binary's answers with TypeScript's.
    assert.deepEqual(requests.slice(0, 8), [
      'GET /production/mentor/',
      'POST /production/mentor/',
      'GET /authentication/authentication/login',
      'POST /production/mentor/',
      'GET /Authentication/Authentication/LoginCallback',
      'GET /',
      'POST /authentication/authentication/isauthenticated/',
      'GET /',
    ]);
    assert.equal(LOGIN_URL, 'https://im1.infomentor.is/production/mentor/');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
