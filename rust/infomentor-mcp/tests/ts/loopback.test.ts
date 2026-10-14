// packages/infomentor-mcp/test/loopback.test.ts against the Rust binary, run by tests/typescript.rs
// from packages/infomentor-mcp. Changed only where the case calls into the TypeScript process: a
// CLI login of ./rust-infomentor.ts runs the binary instead, and each other change is marked
// `Rust:`. Every request of the binary's test build already crosses real loopback HTTP.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { LOGIN_URL } from '../../../../packages/infomentor-mcp/src/session.js';
import { readStored, useScratchStore } from '../../../../packages/infomentor-mcp/test/scratch.js';
import { InfoMentorClient, login } from './rust-infomentor.js';
import { loginDiagnostic } from './login-diagnostic.js';
import { setupStatusSchema } from '../../../../packages/infomentor-mcp/src/client.js';

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

    // Rust: InfoMentor answers 411 to a POST without its length, as it did to 0.9.3's empty
    // isauthenticated form; fetch always sends one.
    if (method === 'POST' && new Headers(init.headers).get('content-length') === null)
      return new Response(null, { status: 411 });

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

const markers = [
  'URL_PRIVATE',
  'BODY_PRIVATE',
  'HEADER_PRIVATE',
  'LOCATION_PRIVATE',
  'FORM_PRIVATE',
  'NETWORK_PRIVATE',
];

const reviewedError = 'InfoMentor returned an error. Try again later.';

const rejectedAdvice =
  'InfoMentor did not accept the login. Check your credentials; no automatic retry was made.';

const diagnosticCases = [
  { mode: 'login-page', step: 'login-page', status: 500, advice: reviewedError },
  {
    mode: 'credential-submit',
    step: 'credential-submit',
    status: 403,
    advice: 'InfoMentor denied access. Check the account before retrying.',
  },
  {
    mode: 'relay',
    step: 'relay',
    status: 429,
    advice: 'InfoMentor is limiting requests. No automatic retry was made.',
  },
  { mode: 'isauthenticated', step: 'isauthenticated', status: 411, advice: reviewedError },
  {
    mode: 'parent-bootstrap',
    step: 'parent-bootstrap',
    status: 401,
    advice:
      'Sign in first: run infomentor-mcp login on the MCP host, or call infomentor_login when the server was started with --allow-setup-tools.',
  },
  { mode: 'redirect-hop', step: 'credential-submit', status: 500, advice: reviewedError },
  {
    mode: 'network',
    step: 'isauthenticated',
    status: undefined,
    advice: 'InfoMentor request failed. Check the network.',
  },
  { mode: 'false', step: 'isauthenticated', status: undefined, advice: rejectedAdvice },
  {
    mode: 'parse',
    step: 'isauthenticated',
    status: 200,
    advice: 'InfoMentor returned an unsupported authentication response.',
  },
  {
    mode: 'form-action',
    step: 'login-page',
    status: 200,
    advice: 'InfoMentor changed its password form destination. Login stopped.',
  },
  {
    mode: 'location',
    step: 'credential-submit',
    status: 307,
    advice: 'InfoMentor requested an unsupported cross-origin form redirect.',
  },
] as const;

for (const scenario of diagnosticCases) {
  test(`login diagnostic ${scenario.mode} is private in CLI and setup status`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infomentor-diagnostic-'));
    const credentialsFile = join(directory, 'credentials.json');
    const sessionFile = join(directory, 'session.json');
    await writeFile(
      credentialsFile,
      JSON.stringify({ username: 'synthetic-user', password: 'synthetic-password' }),
      { mode: 0o600 },
    );
    let submissions = 0;
    let failureEnabled = true;

    const headers = {
      'X-Private': 'HEADER_PRIVATE',
      Location: 'https://minn.infomentor.is/LOCATION_PRIVATE',
    };

    const fetcher = (url: URL, init: RequestInit): Response => {
      const post = init.method === 'POST';

      if (url.pathname === '/production/mentor/' && !post) {
        if (failureEnabled && scenario.mode === 'login-page')
          return new Response('BODY_PRIVATE', { status: 500, headers });

        return new Response(
          `<form method=post action="${failureEnabled && scenario.mode === 'form-action' ? 'https://minn.infomentor.is/FORM_PRIVATE' : './?URL_PRIVATE'}"><input type=hidden name=__VIEWSTATE value=FORM_PRIVATE><input type=hidden name=__EVENTVALIDATION value=state></form>`,
        );
      }

      if (url.pathname === '/production/mentor/' && post) {
        submissions++;

        if (failureEnabled && scenario.mode === 'credential-submit')
          return new Response('BODY_PRIVATE', { status: 403, headers });

        if (failureEnabled && scenario.mode === 'redirect-hop')
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://minn.infomentor.is/LOCATION_PRIVATE?URL_PRIVATE' },
          });

        if (failureEnabled && scenario.mode === 'location')
          return new Response(null, { status: 307, headers });

        return new Response(
          '<form id=openid_message method=post action="./relay?URL_PRIVATE"><input type=hidden name=oauth_token value=FORM_PRIVATE></form>',
        );
      }

      if (url.pathname === '/LOCATION_PRIVATE')
        return new Response('BODY_PRIVATE', { status: 500, headers });

      if (url.pathname === '/production/mentor/relay') {
        if (failureEnabled && scenario.mode === 'relay')
          return new Response('BODY_PRIVATE', {
            status: 429,
            headers: { ...headers, 'Retry-After': '120' },
          });

        return new Response('BODY_PRIVATE', {
          headers: { 'Set-Cookie': 'IMHome=synthetic; Secure; HttpOnly; Path=/' },
        });
      }

      if (url.pathname.endsWith('/isauthenticated/')) {
        assert.equal(new Headers(init.headers).get('content-length'), '0');

        if (failureEnabled && scenario.mode === 'network') throw new Error('NETWORK_PRIVATE');

        if (failureEnabled && scenario.mode === 'isauthenticated')
          return new Response('BODY_PRIVATE', { status: 411, headers });

        return new Response(
          failureEnabled && scenario.mode === 'false'
            ? 'false'
            : failureEnabled && scenario.mode === 'parse'
              ? 'BODY_PRIVATE'
              : 'true',
        );
      }

      if (!failureEnabled)
        return new Response(
          '<script>IMHome.home.homeData = {"account":{"currentUser":{"id":"parent"},"pupils":[]},"apps":[]}; IMHome.home.init(1);</script>',
        );

      return new Response('BODY_PRIVATE', { status: 401, headers });
    };

    const expected = `InfoMentor login failed at step ${scenario.step}${scenario.status === undefined ? '' : ` (HTTP ${scenario.status})`}. ${scenario.advice}`;

    const check = (message: string) => {
      assert.equal(message, expected);

      for (const marker of markers) assert.ok(!message.includes(marker));
      assert.ok(message.length <= 512);
    };

    const client = new InfoMentorClient({ sessionFile, credentialsFile, fetch: fetcher });

    try {
      await assert.rejects(
        login({ sessionFile, credentialsFile, fetch: fetcher }),
        (error: Error) => {
          check(error.message);

          return true;
        },
      );
      assert.equal(submissions, ['login-page', 'form-action'].includes(scenario.mode) ? 0 : 1);
      submissions = 0;
      await client.startLogin({ credentialsFile });
      let status = setupStatusSchema.parse(await client.getSetupStatus());
      const deadline = performance.now() + 10_000;

      while (status.state === 'running' && performance.now() < deadline)
        status = setupStatusSchema.parse(await client.getSetupStatus());
      assert.equal(status.state, 'failed');
      check(status.message);
      assert.equal(submissions, ['login-page', 'form-action'].includes(scenario.mode) ? 0 : 1);
      await client.close();
      failureEnabled = false;
      await login({ sessionFile, credentialsFile, fetch: fetcher });
      const before = await readFile(store.record, 'utf8');
      failureEnabled = true;
      submissions = 0;
      await assert.rejects(client.getOverview(), (error: Error) => {
        check(error.message);

        return true;
      });
      assert.equal(submissions, ['login-page', 'form-action'].includes(scenario.mode) ? 0 : 1);
      assert.equal(await readFile(store.record, 'utf8'), before);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('login prefix grammar rejects arbitrary messages and out-of-range status', () => {
  for (const prefix of [
    'InfoMentor login failed at step URL_PRIVATE (HTTP 411). ',
    'InfoMentor login failed at step relay (HTTP 65536). ',
    'InfoMentor login failed at step relay (HTTP 0411). ',
    'InfoMentor login failed at step relay (HTTP -1). ',
    'InfoMentor login failed at step relay (HTTP BODY_PRIVATE). ',
  ])
    assert.equal(loginDiagnostic(prefix + reviewedError), undefined);
  assert.deepEqual(
    loginDiagnostic('InfoMentor login failed at step relay (HTTP 65535). Reviewed.'),
    { step: 'relay', status: 65535, message: 'Reviewed.' },
  );
  assert.deepEqual(loginDiagnostic('InfoMentor login failed at step relay. Reviewed.'), {
    step: 'relay',
    status: undefined,
    message: 'Reviewed.',
  });
});
