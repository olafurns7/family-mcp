import { expect } from 'bun:test';
import { z } from 'zod';
export const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"synthetic-subject"}').toString('base64url')}.${'x'.repeat(32)}-`;

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

export function provider() {
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
        return new Response(`<script>var jwt = "${token}"; store.set('id_token',jwt);</script>`);
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
