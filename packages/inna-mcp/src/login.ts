import { setTimeout as delay } from 'node:timers/promises';
import { CookieJar } from 'tough-cookie';
import { Parser } from 'htmlparser2';
import { z } from 'zod';
import { SafeError, readBody } from '@family-mcp/mcp-runtime';
import type { ClientOptions } from './client.js';

const ISSUER = 'https://innskra.island.is';

const allowedHosts = new Set([
  'r.inna.is',
  'heimdallur.inna.is',
  'innskra.island.is',
  'inna.is',
  'nam.inna.is',
]);

const pollSchema = z.object({
  isSuccess: z.boolean(),
  retryWaitTime: z.number().nonnegative().max(30_000),
  retries: z.number(),
  nexusUrl: z.string().nullable(),
  data: z.string(),
  timeoutErrorMessage: z.string(),
  isFirstPoll: z.boolean(),
  scriptId: z.string().nullable(),
  sessionId: z.string().nullable(),
  deviceLinkUrl: z.string().nullable(),
});

const accessSchema = z.array(
  z.object({
    system: z.number().int(),
    user_id: z.number().int(),
    status: z.number().int(),
    is_access: z.boolean(),
  }),
);

type LoginBody =
  | { returnUrl: string; userIdentifier: string; verificationProperties?: string }
  | z.infer<typeof pollSchema>
  | { session: z.infer<typeof pollSchema> }
  | Record<string, never>;

function trustedUrl(value: string, base?: string): URL {
  const url = new URL(value, base);

  if (url.protocol === 'http:' && url.hostname === 'nam.inna.is') url.protocol = 'https:';

  if (
    url.protocol !== 'https:' ||
    !allowedHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new SafeError(
      'Inna login returned an unexpected destination. Sign in through the browser.',
    );

  return url;
}

type LoginResult = { jar: CookieJar; token?: string };

/** Fresh electronic-ID login; returns jar and inna.is token for renewal. */
export async function loginWithElectronicId(
  phone: string,
  onCode: (code: string) => void,
  options: {
    fetch?: ClientOptions['fetch'];
    signal?: AbortSignal;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    preferredUserId?: number | undefined;
  } = {},
): Promise<LoginResult> {
  if (!/^\d{7}$/.test(phone)) throw new SafeError('Enter a seven-digit Icelandic phone number.');
  const timeout = AbortSignal.timeout(180_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetcher = options.fetch ?? globalThis.fetch;
  const jar = new CookieJar();

  async function request(value: string, body?: LoginBody, bearer?: string) {
    const url = trustedUrl(value);

    const headers = new Headers({
      Accept: 'application/json,text/html',
      Cookie: await jar.getCookieString(url.href),
    });

    if (bearer) {
      if (url.origin !== 'https://inna.is')
        throw new SafeError('The Inna access token cannot be sent to another origin.');
      headers.set('Authorization', `Bearer ${bearer}`);
    }

    if (url.origin === ISSUER) {
      const csrf = (await jar.getCookies(url.href)).find(
        (cookie) => cookie.key === 'CSRF-TOKEN-IDS',
      );

      if (csrf) headers.set('X-CSRF-TOKEN-IDS', decodeURIComponent(csrf.value));
    }

    if (body) headers.set('Content-Type', 'application/json');

    const init: RequestInit = {
      method: body ? 'POST' : 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    };

    if (body) init.body = JSON.stringify(body);
    const response = await fetcher(url.href, init);

    for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href);

    if (response.status >= 400)
      throw new SafeError(
        'Inna electronic-ID login failed or expired. Check your phone and start a fresh explicit login.',
      );

    return {
      url,
      response,
      text: await readBody(response, 2 * 1024 * 1024, signal),
    };
  }

  async function follow(value: string) {
    let next = trustedUrl(value);

    for (let count = 0; count < 20; count += 1) {
      const result = await request(next.href);
      const location = result.response.headers.get('location');

      if (result.response.status >= 300 && result.response.status < 400 && location) {
        next = trustedUrl(location, next.href);
        continue;
      }

      if (!result.response.ok) throw new SafeError('Inna login returned an incomplete redirect.');

      return result;
    }

    throw new SafeError('Inna login exceeded its redirect limit.');
  }

  async function json<T extends z.ZodType>(
    url: string,
    schema: T,
    body?: LoginBody,
    bearer?: string,
  ): Promise<z.output<T>> {
    const result = await request(url, body, bearer);

    if (
      !result.response.ok ||
      !result.response.headers.get('content-type')?.includes('application/json')
    )
      throw new SafeError('Inna login returned an unexpected response.');

    return schema.parse(JSON.parse(result.text));
  }

  try {
    signal.throwIfAborted();
    const start = await follow('https://r.inna.is/auth/island');
    const returnUrl = start.url.searchParams.get('ReturnUrl');

    if (start.url.origin !== ISSUER || start.url.pathname !== '/app/login' || !returnUrl)
      throw new SafeError('Inna electronic-ID login did not reach the expected phone prompt.');
    await json(
      `${ISSUER}/login/context?returnUrl=${encodeURIComponent(returnUrl)}`,
      z.object({ identityProviderRestrictions: z.array(z.string()) }),
    );

    const bootstrap = await json(
      `${ISSUER}/login/phone?returnUrl=${encodeURIComponent(returnUrl)}`,
      z.object({ displayCode: z.string().regex(/^\d{4}$/), verificationProperties: z.string() }),
    );

    const encodedReturn = encodeURIComponent(returnUrl);

    const device = await json(
      `${ISSUER}/login/phone/check-device`,
      z.object({
        isTwoFactorRequired: z.boolean(),
        isNewLoginRestricted: z.boolean(),
      }),
      { returnUrl: encodedReturn, userIdentifier: phone },
    );

    if (device.isTwoFactorRequired || device.isNewLoginRestricted)
      throw new SafeError(
        'This device needs additional verification. Complete sign-in in the browser.',
      );

    onCode(bootstrap.displayCode);

    const authentication = await json(
      `${ISSUER}/login/phone/authenticate`,
      z.object({ session: pollSchema }),
      {
        returnUrl: encodedReturn,
        verificationProperties: bootstrap.verificationProperties,
        userIdentifier: phone,
      },
    );

    let session = authentication.session;

    while (!session.isSuccess) {
      const milliseconds = Math.max(1000, session.retryWaitTime);

      if (options.wait) await options.wait(milliseconds, signal);
      else await delay(milliseconds, undefined, { signal });
      signal.throwIfAborted();
      session = await json(`${ISSUER}/login/phone/poll`, pollSchema, session);
    }

    const signin = await json(
      `${ISSUER}/login/phone/signin`,
      z.object({ validReturnUrl: z.string() }),
      { session },
    );

    const callback = trustedUrl(signin.validReturnUrl, ISSUER);

    if (callback.origin !== ISSUER || callback.pathname !== '/connect/authorize/callback')
      throw new SafeError('Electronic-ID login returned an unexpected callback.');
    const logout = await follow(callback.href);

    if (logout.url.origin !== ISSUER || logout.url.pathname !== '/logout')
      throw new SafeError('Inna login did not reach the expected identity-provider logout.');

    const links: string[] = [];

    new Parser({
      onopentag(name, attrs) {
        if (name === 'a' && attrs.class?.split(' ').includes('PostLogoutRedirectUri') && attrs.href)
          links.push(attrs.href);
      },
    }).end(logout.text);

    if (links.length !== 1)
      throw new SafeError('Inna identity-provider logout callback is missing.');
    const logoutCallback = trustedUrl(links[0] ?? '', logout.url.href);

    if (
      logoutCallback.origin !== 'https://heimdallur.inna.is' ||
      logoutCallback.pathname !== '/auth/island/logout-callback'
    )
      throw new SafeError('Inna identity-provider logout returned an unexpected callback.');
    const bridge = await follow(logoutCallback.href);

    if (bridge.url.origin !== 'https://inna.is' || bridge.url.pathname !== '/auth/island/callback')
      throw new SafeError('Inna electronic-ID login did not reach the expected access page.');

    // The trusted callback embeds its Inna JWT; never execute upstream JavaScript or decode identity claims.
    const tokens = new Set(
      [
        ...bridge.text.matchAll(
          /(["'])(eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\1/g,
        ),
      ].map((match) => match[2]),
    );

    if (tokens.size !== 1)
      throw new SafeError('Inna login returned an unsupported access-token shape.');
    const token = [...tokens][0];

    if (!token) throw new SafeError('Inna login did not return an access token.');
    const access = await json('https://inna.is/auth/access', accessSchema, undefined, token);

    const terms = await json(
      'https://inna.is/auth/user-terms-confirmed',
      z.object({ confirmed: z.boolean() }),
      undefined,
      token,
    );

    if (!terms.confirmed)
      throw new SafeError(
        'Review and accept Inna terms yourself in the browser, then sign in again.',
      );

    // Student contexts keep their position in the full list: the handoff addresses an entry by index.
    const candidates = access.flatMap((entry, index) =>
      entry.is_access && entry.system === 1 ? [{ entry, index }] : [],
    );

    const chosen =
      candidates.find((candidate) => candidate.entry.user_id === options.preferredUserId) ??
      candidates[0];

    if (!chosen)
      throw new SafeError(
        'Select the intended school in the browser and import its private session.',
      );

    const { entry } = chosen;

    const params = new URLSearchParams({
      i: String(chosen.index),
      system: String(entry.system),
      user_id: String(entry.user_id),
      status: String(entry.status),
    });

    const school = await json(
      `https://inna.is/auth/system?${params}`,
      z.object({ url: z.string() }),
      {},
      token,
    );

    const schoolUrl = trustedUrl(school.url);

    if (schoolUrl.origin !== 'https://nam.inna.is' || schoolUrl.pathname !== '/auth/token')
      throw new SafeError('Inna did not return the expected school-session handoff.');
    const finished = await follow(schoolUrl.href);

    if (
      finished.url.origin !== 'https://nam.inna.is' ||
      finished.url.pathname !== '/Components/Students/Students.html'
    )
      throw new SafeError('Inna login did not finish in the supported student application.');

    const schoolJar = new CookieJar();

    for (const cookie of await jar.getCookies('https://nam.inna.is/')) {
      if (['SESSION', 'JSESSIONID', 'XSRF-TOKEN'].includes(cookie.key)) {
        cookie.secure = true;
        await schoolJar.setCookie(cookie, 'https://nam.inna.is/');
      }
    }

    const innaCookies = await jar.getCookies('https://inna.is/');
    const idToken = innaCookies.find((c) => c.key === 'id_token')?.value;

    return { jar: schoolJar, token: idToken ?? token };
  } catch (error) {
    if (signal.aborted) throw new SafeError('Inna login cancelled or timed out.');

    if (error instanceof SafeError) throw error;
    throw new SafeError(
      'Inna login returned an unexpected response. Complete sign-in in the browser.',
    );
  }
}
