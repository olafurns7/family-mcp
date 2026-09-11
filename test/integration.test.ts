import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CookieJar } from 'tough-cookie';
import { InfoMentorClient, setupStatusSchema } from '../src/client.js';
import { promptCredentials } from '../src/credentials.js';
import { InfoMentorHttp, parseForms } from '../src/http.js';
import { authenticate, importSession, login } from '../src/login.js';
import { createServer } from '../src/server.js';
import {
  captureSession,
  LOGIN_URL,
  overviewSchema,
  PARENT_URL,
  readSession,
  sessionStatusSchema,
  writeSession,
} from '../src/session.js';

const nativeFetch = globalThis.fetch;

const credentials = { username: 'synthetic-user', password: 'synthetic-password' };

const parent = {
  account: { pupils: [{ id: 'child-1', name: 'Synthetic child', selected: true }] },
  apps: [{ codeName: 'timetable' }],
};

const entry = {
  start: '2026-09-11T09:00:00',
  end: '2026-09-11T10:00:00',
  title: 'Íslenska',
  startTime: '09:00',
  endTime: '10:00',
  notes: { roomInfo: '', timetableNotes: '', tutors: '' },
  allDay: false,
  establishmentName: 'Synthetic school',
};

const parentHtml = `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`;

const loginHtml =
  '<form method="POST" action="./"><input type="hidden" name="__VIEWSTATE" value="fresh&amp;state"><input type="hidden" name="__EVENTVALIDATION" value="fresh-validation"><input type="hidden" name="__VIEWSTATEGENERATOR" value="generator"></form>';

const relayHtml =
  '<form id="openid_message" method="post" action="https://im1.infomentor.is/Production/Mentor/"><input type="hidden" name="oauth_token" value="synthetic&amp;token"></form>';

function fixture() {
  const requests: { url: string; method: string; body: string; cookies: string }[] = [];

  const fetcher = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.ok(input instanceof URL);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? 'GET';
      const body = String(init?.body ?? '');
      const cookies = headers.get('cookie') ?? '';
      requests.push({ url: input.href, method, body, cookies });
      assert.equal(init?.redirect, 'manual');

      if (input.href === LOGIN_URL && method === 'GET')
        return new Response(loginHtml, {
          headers: { 'Set-Cookie': 'preflight=synthetic; Secure; HttpOnly; Path=/' },
        });

      if (input.href === LOGIN_URL && method === 'POST') {
        const fields = new URLSearchParams(body);
        assert.equal(fields.get('__VIEWSTATE'), 'fresh&state');
        assert.equal(fields.get('__EVENTVALIDATION'), 'fresh-validation');
        assert.equal(fields.get('login_ascx$txtNotandanafn'), credentials.username);
        assert.equal(fields.get('login_ascx$txtLykilord'), credentials.password);
        assert.equal(fields.get('login_ascx$btnLogin'), 'Innskrá');
        assert.match(cookies, /preflight=synthetic/);
        assert.equal(headers.get('origin'), new URL(LOGIN_URL).origin);

        return new Response(null, {
          status: 302,
          headers: { Location: PARENT_URL + 'authentication/authentication/login' },
        });
      }

      if (input.pathname === '/authentication/authentication/login') {
        assert.equal(method, 'GET');
        assert.equal(cookies, ''); // Host-only cookies cannot leak across the parent/login hosts.

        return new Response(relayHtml);
      }

      if (input.pathname === '/Production/Mentor/') {
        assert.equal(new URLSearchParams(body).get('oauth_token'), 'synthetic&token');
        assert.equal(headers.get('origin'), new URL(PARENT_URL).origin);

        return new Response(null, {
          status: 303,
          headers: {
            Location: PARENT_URL + 'Authentication/Authentication/LoginCallback?token=synthetic',
          },
        });
      }

      if (input.pathname.includes('LoginCallback'))
        return new Response(null, {
          status: 302,
          headers: {
            Location: PARENT_URL,
            'Set-Cookie': 'IMHome=synthetic; Secure; HttpOnly; Path=/',
          },
        });

      if (input.pathname.endsWith('/isauthenticated/')) {
        assert.equal(method, 'POST');

        return Response.json(cookies.includes('IMHome=synthetic'));
      }

      if (input.href === PARENT_URL) return new Response(parentHtml);

      if (input.pathname === '/timetable/timetable/appData') {
        assert.equal(method, 'POST');
        assert.match(cookies, /IMHome=synthetic/);

        return Response.json({ items: [entry] });
      }

      throw new Error('Unexpected synthetic endpoint');
    },
  );

  return { requests, restore: () => fetcher.mock.restore() };
}

async function savedSession() {
  const jar = new CookieJar();
  await jar.setCookie('IMHome=synthetic; Secure; HttpOnly; Path=/', PARENT_URL);

  return captureSession(jar);
}

test('HTTP login relays fresh forms, reuses cookies, and exposes all six MCP operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-http-'));
  const file = join(directory, 'private/session.json');
  const credentialsFile = join(directory, 'credentials.json');
  const routes = fixture();
  const server = createServer({ sessionFile: file });
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  try {
    await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 6);
    assert.ok(tools.every((tool) => tool.outputSchema));
    assert.ok(!tools.some((tool) => tool.name.includes('browser')));

    const started = await client.callTool({
      name: 'infomentor_login',
      arguments: { credentialsFile },
    });

    assert.equal(setupStatusSchema.parse(started.structuredContent).state, 'running');
    let state = 'running';

    for (let step = 0; step < 200 && state === 'running'; step++) {
      await delay(10);
      const status = await client.callTool({ name: 'infomentor_setup_status', arguments: {} });
      state = setupStatusSchema.parse(status.structuredContent).state;
    }

    assert.equal(state, 'succeeded');
    const stored = await readSession(file);
    assert.equal(stored.version, 2);
    assert.equal((await readFile(file, 'utf8')).includes(credentials.password), false);

    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    const result = await client.callTool({ name: 'infomentor_get_overview', arguments: {} });
    const overview = overviewSchema.parse(result.structuredContent);
    assert.deepEqual(overview.children, parent.account.pupils);
    assert.deepEqual(overview.timetable, [entry]);
    assert.match(overview.text, /Íslenska/);
    const freshClient = new InfoMentorClient({ sessionFile: file });

    try {
      assert.equal((await freshClient.getSessionStatus()).authenticated, true);
    } finally {
      await freshClient.close();
    }

    await client.callTool({ name: 'infomentor_logout', arguments: {} });
    assert.equal(
      sessionStatusSchema.parse(
        (await client.callTool({ name: 'infomentor_session_status', arguments: {} }))
          .structuredContent,
      ).authenticated,
      false,
    );
    assert.equal(
      routes.requests.filter((request) => request.body.includes('txtLykilord')).length,
      1,
    );
  } finally {
    await client.close();
    await server.close();
    routes.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejected login, unsafe redirects, challenges, rate limits and malformed authentication fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-rejected-'));
  const file = join(directory, 'session.json');
  await writeSession(await savedSession(), file);
  const before = await readFile(file, 'utf8');

  try {
    for (const mode of ['rejected', 'redirect', 'challenge', 'rate', 'malformed']) {
      let calls = 0;

      const fetcher = mock.method(globalThis, 'fetch', async () => {
        calls++;

        if (mode === 'redirect')
          return new Response(null, {
            status: 307,
            headers: { Location: 'https://evil.test/?private=synthetic' },
          });

        if (mode === 'challenge')
          return new Response('<title>Just a moment</title>', { status: 403 });

        if (mode === 'rate')
          return new Response('', { status: 429, headers: { 'Retry-After': '120' } });

        return new Response(mode === 'malformed' ? '{bad-json}' : 'false');
      });

      try {
        const http = new InfoMentorHttp();

        if (mode === 'rejected') assert.equal(await http.isAuthenticated(), false);
        else
          await assert.rejects(
            http.isAuthenticated(),
            (error: Error) => !error.message.includes('private=synthetic'),
          );

        if (mode === 'rate') {
          await assert.rejects(http.isAuthenticated(), { code: 'RATE_LIMITED' });
          assert.equal(calls, 1);
        }

        await assert.rejects(importSession(file, { sessionFile: file }));
        assert.equal(await readFile(file, 'utf8'), before);
      } finally {
        fetcher.mock.restore();
      }
    }

    const fetcher = mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          loginHtml.replace('action="./"', 'action="https://other.infomentor.is/password"'),
        ),
    );

    try {
      await assert.rejects(authenticate(new InfoMentorHttp(), { ...credentials }), {
        code: 'UNEXPECTED_PAGE',
      });
    } finally {
      fetcher.mock.restore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled login/import cannot replace the previous account at the atomic commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-commit-'));
  const file = join(directory, 'session.json');
  const transfer = join(directory, 'transfer.json');
  const credentialsFile = join(directory, 'credentials.json');
  const routes = fixture();
  await writeSession(await savedSession(), file);
  await writeSession(await savedSession(), transfer);
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
  const before = await readFile(file, 'utf8');
  const originalWrite = fs.writeFile.bind(fs);

  try {
    for (const request of [{ credentialsFile }, { importFile: transfer }]) {
      const written = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();

      const writer = mock.method(
        fs,
        'writeFile',
        async (...args: Parameters<typeof fs.writeFile>) => {
          await originalWrite(...args);

          if (String(args[0]).startsWith(file + '.')) {
            written.resolve();
            await finish.promise;
          }
        },
      );

      syncBuiltinESMExports();
      const client = new InfoMentorClient({ sessionFile: file });

      try {
        client.startLogin(request);
        await written.promise;
        const cancelled = client.cancelSetup();
        finish.resolve();
        assert.equal((await cancelled).state, 'cancelled');
        assert.equal(await readFile(file, 'utf8'), before);
        assert.deepEqual((await readdir(directory)).toSorted(), [
          'credentials.json',
          'session.json',
          'transfer.json',
        ]);
      } finally {
        finish.resolve();
        await client.close();
        writer.mock.restore();
        syncBuiltinESMExports();
      }
    }
  } finally {
    routes.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP cancellation and login deadlines abort in-flight requests; closing a client drains reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-cancel-'));
  const file = join(directory, 'session.json');
  const credentialsFile = join(directory, 'credentials.json');
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
  await writeSession(await savedSession(), file);
  let active = 0;

  const fetcher = mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit) => {
      active++;

      try {
        await delay(60_000, undefined, { signal: init?.signal ?? undefined });

        return new Response('true');
      } finally {
        active--;
      }
    },
  );

  try {
    await assert.rejects(login({ credentialsFile, sessionFile: file, timeoutMs: 30 }), {
      code: 'LOGIN_TIMEOUT',
    });
    assert.equal(active, 0);
    const client = new InfoMentorClient({ sessionFile: file });

    try {
      const reading = assert.rejects(client.getOverview(), { code: 'CANCELLED' });
      await delay(10);
      await client.close();
      await reading;
      assert.equal(active, 0);
    } finally {
      await client.close();
    }
  } finally {
    fetcher.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('private loopback login form rejects cross-origin submissions and closes after use or cancellation', async () => {
  const spawn = childProcess.spawn.bind(childProcess);

  const opener = mock.method(childProcess, 'spawn', () =>
    spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }),
  );

  syncBuiltinESMExports();
  const controller = new AbortController();
  const ready = Promise.withResolvers<string>();
  const pending = promptCredentials(controller.signal, (url) => ready.resolve(url));

  try {
    const url = await ready.promise;
    const page = await nativeFetch(url);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const form = parseForms(await page.text())[0];
    assert.ok(form);
    form.fields.set('username', credentials.username);
    form.fields.set('password', credentials.password);

    const wrongOrigin = await nativeFetch(url, {
      method: 'POST',
      headers: { Origin: 'https://evil.test' },
      body: form.fields,
    });

    assert.equal(wrongOrigin.status, 403);

    const posted = await nativeFetch(url, {
      method: 'POST',
      headers: { Origin: new URL(url).origin },
      body: form.fields,
    });

    assert.equal(posted.status, 200);
    assert.deepEqual(await pending, credentials);
    await assert.rejects(nativeFetch(url));
    const cancelled = new AbortController();
    const waiting = assert.rejects(promptCredentials(cancelled.signal), { code: 'CANCELLED' });
    cancelled.abort();
    await waiting;
  } finally {
    controller.abort();
    await pending.catch(() => {});
    opener.mock.restore();
    syncBuiltinESMExports();
  }
});
