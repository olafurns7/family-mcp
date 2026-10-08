import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { z } from 'zod';
import { InnaClient, REFRESH_BEFORE_EXPIRY_MS } from '../src/client.js';
import type { User } from '../src/schemas.js';

const NOW = Date.parse('2040-01-02T12:00:00Z');

const MINUTE = 60_000;

const user: User = {
  userId: 1,
  studentId: '2',
  schoolId: '3',
  studentName: 'Synthetic student',
  name: 'Synthetic guardian',
  schoolLong: 'Synthetic school',
  defaultTermId: '4',
  isGuardian: true,
  logInType: '2',
  olderThan18: false,
  registerAbsenceGuardian: '1',
  registerAbsenceUnder18: '0',
  registerAbsenceOver18: '1',
  registerAbsence: '1',
  student18RegisterAbsence: '1',
  registerLeave: '1',
  student18RegisterLeave: '1',
  registerIllnessTomorrow: '1',
};

const savedFileSchema = z.object({
  jar: z.string(),
  token: z.string().optional(),
  tokenRefreshedAt: z.number(),
});

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function encodeJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// JWT-shaped synthetic values: only exp and iat matter to the client.
function token(label: string, expiresInMs: number): string {
  return [
    encodeJson({ alg: 'HS256', typ: 'JWT' }),
    encodeJson({ exp: Math.floor((NOW + expiresInMs) / 1000), iat: Math.floor(NOW / 1000) }),
    `synthetic-signature-${label}-padding`,
  ].join('.');
}

// nam.inna.is answers every visitor with SESSION, JSESSIONID and XSRF-TOKEN cookies.
function visitor(location: string, sessionValue: string): Response {
  return new Response(null, {
    status: 302,
    headers: [
      ['Location', location],
      ['Set-Cookie', `SESSION=${sessionValue}; Path=/; Secure; HttpOnly`],
      ['Set-Cookie', 'JSESSIONID=synthetic-jsession; Path=/; Secure; HttpOnly'],
      ['Set-Cookie', 'XSRF-TOKEN=synthetic-xsrf; Path=/'],
    ],
  });
}

const FIRST = token('first', 50 * MINUTE);

const REFRESHED = token('refreshed', 60 * MINUTE);

// Live shape: nam.inna.is hands every visitor SESSION, JSESSIONID and XSRF-TOKEN, even on a
// refused handoff; the session only signs in once the redirects reach the student application.
class Inna {
  readonly calls: string[] = [];
  readonly live = new Set(['synthetic-alive']);
  readonly refreshable = new Set([FIRST, REFRESHED]);
  refreshes = 0;
  handoffSignsIn = true;

  refresh(init: RequestInit): Response {
    this.refreshes += 1;

    const body = z.object({ token: z.string() }).parse(JSON.parse(z.string().parse(init.body)));

    return this.refreshable.has(body.token)
      ? Response.json({ token: REFRESHED })
      : new Response(null, { status: 401 });
  }

  readonly fetch = async (value: string, init: RequestInit): Promise<Response> => {
    const url = new URL(value);
    const headers = new Headers(init.headers);
    const cookie = headers.get('cookie') ?? '';
    const session = /(?:^|; )SESSION=([^;]+)/.exec(cookie)?.[1];
    const bearer = headers.get('authorization');

    this.calls.push(`${url.host}${url.pathname}`);

    switch (`${url.host}${url.pathname}`) {
      case 'nam.inna.is/api/UserData/GetLoggedInUser':
        return session && this.live.has(session)
          ? Response.json(user)
          : new Response(null, { status: 401 });
      case 'inna.is/auth/refresh':
        return this.refresh(init);
      case 'inna.is/auth/access':
        expect(bearer).toBe(`Bearer ${REFRESHED}`);

        return Response.json([
          { system: 2, user_id: 9, status: 1, is_access: true },
          { system: 1, user_id: 1, status: 1, is_access: true },
        ]);
      case 'inna.is/auth/user-terms-confirmed':
        expect(bearer).toBe(`Bearer ${REFRESHED}`);

        return Response.json({ confirmed: true });
      case 'inna.is/auth/system':
        expect(init.method).toBe('POST');
        expect(bearer).toBe(`Bearer ${REFRESHED}`);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          i: '1',
          system: '1',
          user_id: '1',
          status: '1',
        });

        return Response.json({ url: 'http://nam.inna.is/auth/token?token=synthetic-handoff' });
      case 'nam.inna.is/auth/token':
        expect(bearer).toBeNull();

        return visitor('/auth/system?i=1', 'synthetic-visitor');
      case 'nam.inna.is/auth/system':
        expect(session).toBe('synthetic-visitor');

        if (this.handoffSignsIn) this.live.add('synthetic-fresh');

        return visitor('/Components/Students/Students.html#!/home', 'synthetic-fresh');
      case 'nam.inna.is/Components/Students/Students.html':
        expect(session).toBe('synthetic-fresh');

        return new Response('<html>Synthetic student application</html>');
      default:
        throw new Error(`Unexpected synthetic request ${url.host}${url.pathname}`);
    }
  };
}

async function setup(options: { session: string; token: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'inna-renewal-'));
  directories.push(directory);
  const path = join(directory, 'session.json');
  const jar = new CookieJar();

  for (const cookie of [
    `SESSION=${options.session}; Path=/; Secure; HttpOnly`,
    'JSESSIONID=synthetic-old; Path=/; Secure; HttpOnly',
    'XSRF-TOKEN=synthetic-xsrf; Path=/; Secure',
  ])
    await jar.setCookie(cookie, 'https://nam.inna.is/');

  await writeFile(
    path,
    JSON.stringify({
      version: 3,
      jar: JSON.stringify(await jar.serialize()),
      account: { userId: 1, studentId: '2', schoolId: '3' },
      students: {},
      pauseUntil: 0,
      token: options.token,
      tokenRefreshedAt: 0,
    }),
    { mode: 0o600 },
  );

  const inna = new Inna();
  inna.refreshable.add(options.token);
  const logs: string[] = [];

  const client = new InnaClient({
    sessionFile: path,
    fetch: inna.fetch,
    now: () => NOW,
    log: (message) => logs.push(message),
  });

  const saved = async () => savedFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));

  const sessionCookie = async () =>
    (await CookieJar.deserialize((await saved()).jar))
      .getCookiesSync('https://nam.inna.is/')
      .find((cookie) => cookie.key === 'SESSION')?.value;

  return { client, inna, logs, saved, sessionCookie };
}

function expectNoSecrets(logs: string[]): void {
  for (const line of logs) {
    expect(line).not.toContain('synthetic-signature');
    expect(line).not.toContain('synthetic-handoff');
    expect(line).not.toContain('synthetic-fresh');
  }
}

test('renewal follows the handoff redirects like the web application and saves the signed-in session', async () => {
  const { client, inna, logs, saved, sessionCookie } = await setup({
    session: 'synthetic-dead',
    token: FIRST,
  });

  expect(await client.status()).toMatchObject({ authenticated: true });
  expect(inna.calls).toEqual([
    'nam.inna.is/api/UserData/GetLoggedInUser',
    'inna.is/auth/refresh',
    'inna.is/auth/access',
    'inna.is/auth/user-terms-confirmed',
    'inna.is/auth/system',
    'nam.inna.is/auth/token',
    'nam.inna.is/auth/system',
    'nam.inna.is/Components/Students/Students.html',
    // Verification of the renewed session, then the status read and its context re-check.
    'nam.inna.is/api/UserData/GetLoggedInUser',
    'nam.inna.is/api/UserData/GetLoggedInUser',
    'nam.inna.is/api/UserData/GetLoggedInUser',
  ]);
  expect(await sessionCookie()).toBe('synthetic-fresh');
  expect(await saved()).toMatchObject({ token: REFRESHED, tokenRefreshedAt: NOW });
  expect(logs.map((line) => line.replace(/^\S+ /, ''))).toEqual([
    'Session expired, attempting automatic renewal',
    'Attempting session renewal',
    'Inna token refreshed (expires 2040-01-02T13:00:00.000Z)',
    'School handoff: /auth/token 302 -> /auth/system 302 -> /Components/Students/Students.html 200',
    'Session renewed successfully',
  ]);
  expectNoSecrets(logs);
});

test('a refreshed token is saved even when the renewed session fails verification', async () => {
  const { client, inna, logs, saved, sessionCookie } = await setup({
    session: 'synthetic-dead',
    token: FIRST,
  });

  inna.handoffSignsIn = false;

  await assert.rejects(client.status(), /Inna sign-in is required/);
  expect(await saved()).toMatchObject({ token: REFRESHED, tokenRefreshedAt: NOW });
  expect(await sessionCookie()).toBe('synthetic-dead');
  expect(logs.map((line) => line.replace(/^\S+ /, ''))).toContain(
    'Session renewal verification failed',
  );
  expectNoSecrets(logs);
});

test('calls and keep-alive refresh a token inside the margin before the request and save it at once', async () => {
  for (const run of [
    (client: InnaClient) => client.status(),
    (client: InnaClient) => client.keepAlive(),
  ]) {
    const { client, inna, saved } = await setup({
      session: 'synthetic-alive',
      token: token('due', REFRESH_BEFORE_EXPIRY_MS - MINUTE),
    });

    await run(client);
    expect(inna.refreshes).toBe(1);
    expect(inna.calls.slice(0, 2)).toEqual([
      'inna.is/auth/refresh',
      'nam.inna.is/api/UserData/GetLoggedInUser',
    ]);
    expect(await saved()).toMatchObject({ token: REFRESHED, tokenRefreshedAt: NOW });
  }
});

test('no proactive refresh with time to spare or for a lapsed token', async () => {
  for (const expiresIn of [REFRESH_BEFORE_EXPIRY_MS + MINUTE, -MINUTE]) {
    const issued = token('case', expiresIn);
    const { client, inna, saved } = await setup({ session: 'synthetic-alive', token: issued });

    expect(await client.status()).toMatchObject({ authenticated: true });
    expect(await client.keepAlive()).toEqual({ status: 'kept' });
    expect(inna.refreshes).toBe(0);
    expect((await saved()).token).toBe(issued);
  }
});

test('keep-alive keeps retrying renewal with the saved token after a failed renewal', async () => {
  const { client, inna, saved, sessionCookie } = await setup({
    session: 'synthetic-dead',
    token: FIRST,
  });

  inna.handoffSignsIn = false;
  expect(await client.keepAlive()).toEqual({ status: 'signInRequired' });
  expect((await saved()).token).toBe(REFRESHED);

  inna.handoffSignsIn = true;
  expect(await client.keepAlive()).toEqual({ status: 'renewed' });
  expect(await sessionCookie()).toBe('synthetic-fresh');
  expect(await client.keepAlive()).toEqual({ status: 'kept' });
});
