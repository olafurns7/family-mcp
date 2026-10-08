import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { loginWithElectronicId } from '../src/login.js';

const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"synthetic-subject"}').toString('base64url')}.${'x'.repeat(32)}-`;

const bodySchema = z.object({
  returnUrl: z.string().optional(),
  userIdentifier: z.string().optional(),
  verificationProperties: z.string().optional(),
  data: z.string().optional(),
  session: z.object({ data: z.string(), isSuccess: z.boolean() }).optional(),
});

const session = (data: string, success = false, wait = 2000) => ({
  isSuccess: success,
  retryWaitTime: wait,
  retries: 10,
  nexusUrl: null,
  data,
  timeoutErrorMessage: 'Synthetic expired message',
  isFirstPoll: false,
  scriptId: null,
  sessionId: null,
  deviceLinkUrl: null,
});

const redirect = (url: string, cookies?: string) =>
  new Response(null, {
    status: 302,
    headers: cookies ? { Location: url, 'Set-Cookie': cookies } : { Location: url },
  });

function provider() {
  const calls: { url: URL; method: string }[] = [];
  let polls = 0;
  let terms = true;
  let access = [{ system: 1, user_id: 2, status: 3, is_access: true }];
  const selections: Record<string, string>[] = [];
  let trap = false;

  const fetcher = async (value: string, options: RequestInit): Promise<Response> => {
    const url = new URL(value);
    const headers = new Headers(options.headers);
    const method = options.method ?? 'GET';
    const body = bodySchema.parse(JSON.parse(z.string().optional().parse(options.body) ?? '{}'));
    expect(url.protocol).toBe('https:');
    expect(options.redirect).toBe('manual');
    expect([
      'r.inna.is',
      'inna.is',
      'heimdallur.inna.is',
      'innskra.island.is',
      'nam.inna.is',
    ]).toContain(url.hostname);
    calls.push({ url, method });

    if (headers.has('Authorization')) {
      expect(url.origin).toBe('https://inna.is');
      expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
    }

    if (method === 'POST' && url.hostname === 'innskra.island.is')
      expect(headers.get('X-CSRF-TOKEN-IDS')).toBe('synthetic-csrf');

    switch (`${url.hostname}${url.pathname}`) {
      case 'r.inna.is/auth/island':
        return redirect(
          trap
            ? 'https://example.invalid/credential-trap'
            : 'https://heimdallur.inna.is/auth/island/login',
        );
      case 'heimdallur.inna.is/auth/island/login':
        return redirect('https://innskra.island.is/connect/authorize');
      case 'innskra.island.is/connect/authorize':
        return redirect(
          'https://innskra.island.is/app/login?ReturnUrl=' +
            encodeURIComponent('/connect/authorize/callback?state=synthetic'),
        );
      case 'innskra.island.is/app/login':
        return new Response('<html>synthetic phone shell</html>');
      case 'innskra.island.is/login/context':
        return Response.json(
          { identityProviderRestrictions: [] },
          { headers: { 'Set-Cookie': 'CSRF-TOKEN-IDS=synthetic-csrf; Path=/; Secure' } },
        );
      case 'innskra.island.is/login/phone':
        return Response.json({
          displayCode: '1234',
          verificationProperties: 'synthetic-verification',
        });
      case 'innskra.island.is/login/phone/check-device':
        expect(body).toEqual({
          returnUrl: encodeURIComponent('/connect/authorize/callback?state=synthetic'),
          userIdentifier: '5550000',
        });

        return Response.json({ isTwoFactorRequired: false, isNewLoginRestricted: false });
      case 'innskra.island.is/login/phone/authenticate':
        expect(body.verificationProperties).toBe('synthetic-verification');

        return Response.json({ userIdentifier: null, session: session('synthetic-first') });
      case 'innskra.island.is/login/phone/poll':
        expect(body.userIdentifier).toBeUndefined();
        expect(body.data).toBe(polls++ ? 'synthetic-next' : 'synthetic-first');

        return Response.json(
          polls === 1 ? session('synthetic-next', false, 3000) : session('synthetic-success', true),
        );
      case 'innskra.island.is/login/phone/signin':
        expect(body.session?.data).toBe('synthetic-success');
        expect(body.session?.isSuccess).toBe(true);

        return Response.json(
          { validReturnUrl: '/connect/authorize/callback?state=synthetic' },
          { headers: { 'Set-Cookie': 'innskra=synthetic-identity-cookie; Path=/; Secure' } },
        );
      case 'innskra.island.is/connect/authorize/callback':
        return redirect('https://heimdallur.inna.is/auth/island/callback');
      case 'heimdallur.inna.is/auth/island/callback':
        return redirect('https://innskra.island.is/connect/endsession');
      case 'innskra.island.is/connect/endsession':
        return redirect('https://innskra.island.is/logout?logoutId=synthetic');
      case 'innskra.island.is/logout':
        return new Response(
          '<a class="other PostLogoutRedirectUri" href="https://heimdallur.inna.is/auth/island/logout-callback?state=synthetic">Continue</a>',
        );
      case 'heimdallur.inna.is/auth/island/logout-callback':
        return redirect('https://inna.is/auth/island/callback?token=synthetic');
      case 'inna.is/auth/island/callback':
        return new Response(`<script>var jwt = "${token}"; store.set('id_token',jwt);</script>`, {
          headers: { 'Set-Cookie': `id_token=${token}; Path=/; Domain=inna.is; Secure` },
        });
      case 'inna.is/auth/access':
        return Response.json(access.map((entry) => Object.assign({ ssn: 'DO-NOT-SAVE' }, entry)));
      case 'inna.is/auth/user-terms-confirmed':
        return Response.json({ confirmed: terms });
      case 'inna.is/auth/system':
        expect(method).toBe('POST');
        expect(body).toEqual({});
        expect([...url.searchParams.keys()]).toEqual(['i', 'system', 'user_id', 'status']);
        selections.push(Object.fromEntries(url.searchParams));

        return Response.json({ url: 'http://nam.inna.is/auth/token?token=synthetic' });
      case 'nam.inna.is/auth/token':
        expect(headers.has('Authorization')).toBe(false);

        return redirect(
          'http://nam.inna.is/auth/system',
          'SESSION=synthetic-school; Path=/; Secure; HttpOnly',
        );
      case 'nam.inna.is/auth/system':
        return redirect(
          'http://nam.inna.is/Components/Students/Students.html',
          'XSRF-TOKEN=synthetic-xsrf; Path=/',
        );
      case 'nam.inna.is/Components/Students/Students.html':
        return new Response('<html>Synthetic student application</html>');
      default:
        throw new Error('Unexpected synthetic login request');
    }
  };

  return {
    calls,
    fetcher,
    setTerms: (value: boolean) => {
      terms = value;
    },
    selections,
    setAccess: (value: typeof access) => {
      access = value;
    },
    setTrap: () => {
      trap = true;
    },
  };
}

test('phone login replaces the polling session, completes logout relay, upgrades HTTP, and retains only school cookies', async () => {
  const p = provider();
  const codes: string[] = [];
  const waits: number[] = [];

  const result = await loginWithElectronicId(
    '5550000',
    (code) => {
      expect(p.calls.some((call) => call.url.pathname === '/login/phone/authenticate')).toBe(false);
      codes.push(code);
    },
    {
      fetch: p.fetcher,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );

  expect(codes).toEqual(['1234']);
  expect(p.selections).toEqual([{ i: '0', system: '1', user_id: '2', status: '3' }]);
  expect(waits).toEqual([2000, 3000]);
  const saved = JSON.stringify(await result.jar.serialize());
  expect(saved).not.toContain(token);
  expect(saved).not.toContain('synthetic-identity-cookie');
  expect(saved).not.toContain('DO-NOT-SAVE');
  const cookies = await result.jar.getCookies('https://nam.inna.is/');
  expect(cookies.map((cookie) => cookie.key).toSorted()).toEqual(['SESSION', 'XSRF-TOKEN']);
  expect(cookies.every((cookie) => cookie.secure)).toBe(true);
  expect(result.token).toBe(token);
});

test('phone login refuses external redirects, unaccepted terms, and an access list without a student context', async () => {
  const p = provider();
  p.setTrap();
  await assert.rejects(
    loginWithElectronicId('5550000', () => {}, { fetch: p.fetcher }),
    /unexpected destination/,
  );
  expect(p.calls).toHaveLength(1);

  for (const reason of ['terms', 'schools']) {
    const q = provider();

    if (reason === 'terms') q.setTerms(false);
    else
      q.setAccess([
        { system: 2, user_id: 7, status: 1, is_access: true },
        { system: 1, user_id: 8, status: 1, is_access: false },
      ]);
    await assert.rejects(
      loginWithElectronicId('5550000', () => {}, { fetch: q.fetcher, wait: async () => {} }),
      reason === 'terms' ? /accept Inna terms yourself/ : /Select the intended school/,
    );
    expect(q.calls.some((call) => call.method === 'POST' && call.url.hostname === 'inna.is')).toBe(
      false,
    );
  }
});

test('phone login with several student contexts picks the first or the preferred one by its original index', async () => {
  const access = [
    { system: 2, user_id: 7, status: 1, is_access: true },
    { system: 1, user_id: 8, status: 1, is_access: false },
    { system: 1, user_id: 2, status: 3, is_access: true },
    { system: 1, user_id: 5, status: 4, is_access: true },
  ];

  const first = { i: '2', system: '1', user_id: '2', status: '3' };

  for (const [preferredUserId, selection] of [
    [undefined, first],
    [5, { i: '3', system: '1', user_id: '5', status: '4' }],
    [2, first],
    // Absent, without access, or another application: fall back to the first student context.
    [99, first],
    [8, first],
    [7, first],
  ] as const) {
    const p = provider();
    p.setAccess(access);

    const result = await loginWithElectronicId('5550000', () => {}, {
      fetch: p.fetcher,
      wait: async () => {},
      preferredUserId,
    });

    expect({ preferredUserId, selections: p.selections }).toEqual({
      preferredUserId,
      selections: [selection],
    });
    expect(
      (await result.jar.getCookies('https://nam.inna.is/')).map((cookie) => cookie.key),
    ).toContain('SESSION');
    expect(result.token).toBe(token);
  }
});
