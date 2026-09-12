import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { authenticate } from '../src/login.js';
import { InfoMentorHttp, parseForms } from '../src/http.js';
import { InfoMentorError, LOGIN_URL, PARENT_URL } from '../src/session.js';

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

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);

      if (url.pathname === '/production/mentor/' && request.method === 'GET')
        return new Response(
          '<form method="POST" action="./"><input type="hidden" name="__VIEWSTATE" value="state"><input type="hidden" name="__EVENTVALIDATION" value="validation"></form>',
          { headers: { 'Set-Cookie': 'preflight=ok; Path=/; Secure; HttpOnly' } },
        );

      if (url.pathname === '/production/mentor/' && request.method === 'POST') {
        const body = await request.text();

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

      if (url.pathname === '/' && request.method === 'GET') return new Response(parentHtml);

      if (url.pathname === '/authentication/authentication/isauthenticated/')
        return new Response('true');

      if (url.pathname === '/rate-int')
        return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });

      if (url.pathname === '/rate-date')
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': new Date(Date.now() + 5000).toUTCString() },
        });

      if (url.pathname === '/large') return new Response(new Uint8Array(8 * 1024 * 1024 + 1));

      return new Response('unexpected', { status: 404 });
    },
  });

  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const source = new URL(input instanceof Request ? input.url : input.toString());

    return fetch(`http://127.0.0.1:${server.port}${source.pathname}${source.search}`, init);
  };

  try {
    const http = new InfoMentorHttp(undefined, 0, fetcher);
    await authenticate(http, { username: '0101991239', password: 'synthetic-password' });
    const loaded = await http.readParent();

    assert.equal(loaded.account.currentUser.id, 'parent');
    assert.match(http.jar.getCookieStringSync(PARENT_URL), /IMHome=ok/);
    assert.deepEqual(parseForms('<form id="relay"></form>'), [
      { id: 'relay', action: '', method: 'get', fields: new URLSearchParams() },
    ]);
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

    await assert.rejects(
      new InfoMentorHttp(undefined, 0, fetcher).request(`${PARENT_URL}rate-int`),
      (error: Error) => error instanceof InfoMentorError && error.code === 'RATE_LIMITED',
    );
    await assert.rejects(
      new InfoMentorHttp(undefined, 0, fetcher).request(`${PARENT_URL}rate-date`),
      (error: Error) =>
        error instanceof InfoMentorError &&
        error.code === 'RATE_LIMITED' &&
        (error.retryAfterMs ?? 0) > 3000,
    );
    await assert.rejects(
      new InfoMentorHttp(undefined, 0, fetcher).request(`${PARENT_URL}large`),
      /unexpectedly large/,
    );
    assert.equal(LOGIN_URL, 'https://im1.infomentor.is/production/mentor/');
  } finally {
    await server.stop(true);
  }
});
