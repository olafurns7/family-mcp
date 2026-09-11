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
import { collectionSchema } from '../src/collection.js';
import { promptCredentials } from '../src/credentials.js';
import { InfoMentorHttp, parseForms } from '../src/http.js';
import { authenticate, importSession, login } from '../src/login.js';
import { createServer } from '../src/server.js';
import {
  captureSession,
  LOGIN_URL,
  overviewSchema,
  messagesSchema,
  messageSchema,
  notificationsSchema,
  PARENT_URL,
  readSession,
  sessionStatusSchema,
  writeSession,
} from '../src/session.js';

const nativeFetch = globalThis.fetch;

const credentials = { username: '0101991239', password: 'synthetic-password' };

const parent = {
  account: {
    currentUser: { id: 'parent-1' },
    pupils: [
      { id: 'child-1', name: 'Synthetic child', selected: true },
      { id: 'child-2 & sibling', name: 'Synthetic sibling', selected: false },
    ],
  },
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

const siblingEntry = { ...entry, title: 'Sund' };

const loginHtml =
  '<form method="POST" action="./"><input type="hidden" name="__VIEWSTATE" value="fresh&amp;state"><input type="hidden" name="__EVENTVALIDATION" value="fresh-validation"><input type="hidden" name="__VIEWSTATEGENERATOR" value="generator"></form>';

const relayHtml =
  '<form id="openid_message" method="post" action="https://im1.infomentor.is/Production/Mentor/"><input type="hidden" name="oauth_token" value="synthetic&amp;token"></form>';

const message = {
  id: 41,
  messageContextType: 'General',
  sentUser: { id: 12, displayName: 'Synthetic teacher' },
  isNew: true,
  messageSubject: 'Skólaferð',
  timeSent: '11.09.2026 09:00',
};

const notifications = ['New', 'Seen', 'Read', 'Cleared'].map((state, index) => ({
  id: index + 1,
  title: 'Synthetic notification',
  subTitle: 'Bring lunch',
  subjectsCourses: '',
  dateSent: '11.09.2026',
  appType: 'Message',
  state,
  type: 'MessageCreated',
  url: '/#/message/show/41',
  pupilIM2Id: index,
  pupilSourceId: `synthetic-${index}`,
  currentlySelectedPupil: index % 2 === 0,
}));

function fixture() {
  const requests: { url: string; method: string; body: string; cookies: string }[] = [];

  const selection = {
    id: 'child-1',
    overrideUrl: '',
    ignoreSwitch: false,
    failTimetable: false,
  };

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
            'Set-Cookie': '.ASPXAUTH=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure',
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

        return Response.json(/(?:^|; )IMHome=(?:synthetic|other)(?:;|$)/.test(cookies));
      }

      if (cookies.includes('IMHome=other')) {
        if (input.href === PARENT_URL) {
          const model = {
            ...parent,
            account: {
              currentUser: { id: 'parent-2' },
              pupils: [
                {
                  id: 'only-child',
                  name: 'Another account child',
                  selected: true,
                  switchPupilUrl: null,
                },
              ],
            },
          };

          return new Response(
            `<script>IMHome.home.homeData = ${JSON.stringify(model)}; IMHome.home.init(IMHome.home.homeData);</script>`,
          );
        }

        if (input.pathname === '/timetable/timetable/appData')
          return Response.json({ items: [{ ...entry, title: 'Another account timetable' }] });
        throw new Error('Unexpected request in the other account');
      }

      if (input.href === PARENT_URL) {
        const model = {
          ...parent,
          account: {
            currentUser: { id: 'parent-1' },
            pupils: parent.account.pupils.map((pupil, index) => ({
              ...pupil,
              selected: pupil.id === selection.id,
              switchPupilUrl:
                selection.overrideUrl || `/Account/PupilSwitcher/SwitchPupil/${101 + index}`,
            })),
          },
        };

        return new Response(
          `<script>IMHome.home.homeData = ${JSON.stringify(model)}; IMHome.home.init(IMHome.home.homeData);</script>`,
        );
      }

      if (/^\/Account\/PupilSwitcher\/SwitchPupil\/(101|102)$/.test(input.pathname)) {
        assert.equal(method, 'GET');
        const pupil = parent.account.pupils[Number(input.pathname.split('/').at(-1)) - 101];
        assert.ok(pupil);

        if (!selection.ignoreSwitch) selection.id = pupil.id;

        return new Response(null, {
          status: 302,
          headers: {
            Location: PARENT_URL,
            'Set-Cookie': `selectedChild=${encodeURIComponent(selection.id)}; Secure; HttpOnly; Path=/`,
          },
        });
      }

      if (input.pathname === '/timetable/timetable/appData') {
        assert.equal(method, 'POST');
        assert.match(cookies, /IMHome=synthetic/);

        if (selection.failTimetable) return new Response('private-upstream-value', { status: 500 });

        if (selection.id !== 'child-1')
          assert.ok(cookies.includes(`selectedChild=${encodeURIComponent(selection.id)}`));

        return Response.json({ items: [selection.id === 'child-1' ? entry : siblingEntry] });
      }

      if (input.pathname === '/Message/message/GetMessages') {
        assert.equal(method, 'POST');
        assert.match(cookies, /IMHome=synthetic/);
        const fields = new URLSearchParams(body);

        if (fields.get('messageText') === 'malformed')
          return new Response('{"items":"private-upstream-value"}');

        if (fields.get('messageText') === '') {
          assert.equal(fields.get('pageSize'), '100');
          assert.equal(fields.get('page'), '1');

          return Response.json({
            items: fields.get('inbox') === 'true' ? [message] : [],
            more: false,
          });
        }

        assert.equal(fields.get('inbox'), 'false');
        assert.equal(fields.get('sentItems'), 'true');
        assert.equal(fields.get('messageText'), 'Skólaferð & nesti');
        assert.equal(fields.get('page'), '2');
        assert.equal(fields.get('pageSize'), '1');

        return Response.json({ items: [message], page: 0, more: true });
      }

      if (input.pathname === '/Message/message/GetMessage') {
        assert.equal(method, 'POST');
        assert.equal(new URLSearchParams(body).get('id'), '41');

        return Response.json({
          ...message,
          messageBody: '<p>Bring lunch</p>',
          messageBodyPlainText: 'Bring lunch',
          toUsers: [{ id: 13, displayName: 'Synthetic parent' }],
          messageFolder: 'Inbox',
        });
      }

      if (input.pathname === '/NotificationApp/NotificationApp/appData') {
        assert.equal(method, 'POST');

        return Response.json({
          notifications: notifications.map((item) => ({
            ...item,
            currentlySelectedPupil:
              selection.id === 'child-1'
                ? item.currentlySelectedPupil
                : !item.currentlySelectedPupil,
          })),
        });
      }

      throw new Error('Unexpected synthetic endpoint');
    },
  );

  return { requests, selection, restore: () => fetcher.mock.restore() };
}

async function savedSession(value = 'synthetic') {
  const jar = new CookieJar();
  await jar.setCookie(`IMHome=${value}; Secure; HttpOnly; Path=/`, PARENT_URL);

  return captureSession(jar);
}

test('private login and eleven MCP tools select children and read school data without changing read state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-http-'));
  const file = join(directory, 'private/session.json');

  const environment = {
    INFOMENTOR_USERNAME: process.env['INFOMENTOR_USERNAME'],
    INFOMENTOR_PASSWORD: process.env['INFOMENTOR_PASSWORD'],
    INFOMENTOR_CREDENTIALS_FILE: process.env['INFOMENTOR_CREDENTIALS_FILE'],
  };

  const routes = fixture();
  const server = createServer({ sessionFile: file });
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  try {
    for (const name of Object.keys(environment)) delete process.env[name];
    await assert.rejects(login({ sessionFile: file, timeoutMs: 50 }), {
      code: 'INVALID_CONFIGURATION',
    });
    assert.equal(routes.requests.length, 0);
    process.env['INFOMENTOR_USERNAME'] = credentials.username;
    await assert.rejects(login({ sessionFile: file, timeoutMs: 50 }), {
      code: 'INVALID_CONFIGURATION',
    });
    assert.equal(routes.requests.length, 0);
    process.env['INFOMENTOR_PASSWORD'] = credentials.password;
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 11);
    assert.ok(tools.every((tool) => tool.outputSchema));
    assert.ok(!tools.some((tool) => tool.name.includes('browser')));

    const started = await client.callTool({
      name: 'infomentor_login',
      arguments: {},
    });

    assert.equal(setupStatusSchema.parse(started.structuredContent).state, 'running');
    let state = 'running';

    for (let step = 0; step < 200 && state === 'running'; step++) {
      await delay(10);
      const status = await client.callTool({ name: 'infomentor_setup_status', arguments: {} });
      const progress = setupStatusSchema.parse(status.structuredContent);
      assert.equal(progress.loginUrl, undefined);
      assert.equal(JSON.stringify(status).includes(credentials.password), false);
      state = progress.state;
    }

    assert.equal(state, 'succeeded');
    const stored = await readSession(file);
    assert.equal(stored.version, 2);
    assert.ok(stored.cookies.some((cookie) => cookie.key === 'IMHome'));
    assert.ok(stored.cookies.every((cookie) => cookie.value && cookie.key !== '.ASPXAUTH'));
    assert.equal((await readFile(file, 'utf8')).includes(credentials.password), false);

    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    const result = await client.callTool({ name: 'infomentor_get_overview', arguments: {} });
    const overview = overviewSchema.parse(result.structuredContent);
    assert.deepEqual(overview.children, parent.account.pupils);
    assert.deepEqual(overview.timetable, [entry]);
    assert.match(overview.text, /Íslenska/);

    const messagesResult = await client.callTool({
      name: 'infomentor_get_messages',
      arguments: { folder: 'sent', search: 'Skólaferð & nesti', page: 2, pageSize: 1 },
    });

    const listed = messagesSchema.parse(messagesResult.structuredContent);
    assert.deepEqual(listed.items, [message]);
    assert.equal(listed.page, 2);
    assert.equal(listed.more, true);

    const detailResult = await client.callTool({
      name: 'infomentor_get_message',
      arguments: { id: 41 },
    });

    const detail = messageSchema.parse(detailResult.structuredContent).message;
    assert.equal(detail.messageBodyPlainText, 'Bring lunch');
    assert.equal(detail.isNew, true);
    assert.ok(!('messageBody' in detail));

    for (const [arguments_, expectedIds] of [
      [{}, [1, 2, 3]],
      [{ selectedChildOnly: true }, [1, 3]],
      [{ includeCleared: true }, [1, 2, 3, 4]],
    ] as const) {
      const feed = await client.callTool({
        name: 'infomentor_get_notifications',
        arguments: arguments_,
      });

      assert.deepEqual(
        notificationsSchema.parse(feed.structuredContent).notifications.map((item) => item.id),
        expectedIds,
      );
    }

    const beforeInvalid = routes.requests.length;
    assert.equal(
      (await client.callTool({ name: 'infomentor_get_message', arguments: { id: -1 } })).isError,
      true,
    );
    assert.equal(
      (await client.callTool({ name: 'infomentor_get_messages', arguments: { pageSize: 101 } }))
        .isError,
      true,
    );
    assert.equal(
      (await client.callTool({ name: 'infomentor_select_child', arguments: { childId: '' } }))
        .isError,
      true,
    );
    assert.equal(routes.requests.length, beforeInvalid);

    const switching = client.callTool({
      name: 'infomentor_select_child',
      arguments: { childId: 'child-2 & sibling' },
    });

    const queuedOverview = client.callTool({ name: 'infomentor_get_overview', arguments: {} });

    for (const response of await Promise.all([switching, queuedOverview])) {
      const switched = overviewSchema.parse(response.structuredContent);
      assert.equal(switched.children.find((child) => child.selected)?.id, 'child-2 & sibling');
      assert.deepEqual(switched.timetable, [siblingEntry]);
      assert.ok(!JSON.stringify(response).includes('switchPupilUrl'));
    }

    const switchRequests = () => routes.requests.filter(({ url }) => url.includes('/SwitchPupil/'));

    const noOp = await client.callTool({
      name: 'infomentor_select_child',
      arguments: { childId: 'child-2 & sibling' },
    });

    assert.notEqual(noOp.isError, true);
    assert.equal(switchRequests().length, 1);

    const siblingFeed = await client.callTool({
      name: 'infomentor_get_notifications',
      arguments: { selectedChildOnly: true },
    });

    assert.deepEqual(
      notificationsSchema.parse(siblingFeed.structuredContent).notifications.map(({ id }) => id),
      [2],
    );

    const siblingMessages = await client.callTool({
      name: 'infomentor_get_messages',
      arguments: { folder: 'sent', search: 'Skólaferð & nesti', page: 2, pageSize: 1 },
    });

    assert.deepEqual(messagesSchema.parse(siblingMessages.structuredContent).items, [message]);

    const unknownChild = await client.callTool({
      name: 'infomentor_select_child',
      arguments: { childId: 'not-registered' },
    });

    assert.equal(unknownChild.isError, true);
    assert.equal(switchRequests().length, 1);

    for (const url of [
      'https://evil.test/Account/PupilSwitcher/SwitchPupil/101',
      'https://im1.infomentor.is/Account/PupilSwitcher/SwitchPupil/101',
      '/Message/message/DeleteMessage/101',
      '/Account/PupilSwitcher/SwitchPupil/101?private=synthetic',
    ]) {
      routes.selection.overrideUrl = url;
      const beforeRejectedUrl: number = routes.requests.length;

      const refused = await client.callTool({
        name: 'infomentor_select_child',
        arguments: { childId: 'child-1' },
      });

      assert.equal(refused.isError, true);
      assert.ok(!JSON.stringify(refused).includes(url));
      assert.equal(switchRequests().length, 1);
      assert.deepEqual(
        routes.requests.slice(beforeRejectedUrl).map(({ url: requested }) => requested),
        [PARENT_URL + 'authentication/authentication/isauthenticated/', PARENT_URL, PARENT_URL],
      );
    }

    routes.selection.overrideUrl = '';
    routes.selection.ignoreSwitch = true;

    const unconfirmed = await client.callTool({
      name: 'infomentor_select_child',
      arguments: { childId: 'child-1' },
    });

    assert.equal(unconfirmed.isError, true);
    assert.equal(routes.selection.id, 'child-2 & sibling');
    routes.selection.ignoreSwitch = false;

    const restored = await client.callTool({
      name: 'infomentor_select_child',
      arguments: { childId: 'child-1' },
    });

    assert.deepEqual(
      overviewSchema.parse(restored.structuredContent).children,
      parent.account.pupils,
    );
    assert.equal(
      tools.find(({ name }) => name === 'infomentor_select_child')?.annotations?.readOnlyHint,
      false,
    );

    routes.selection.failTimetable = true;

    const partial = await client.callTool({
      name: 'infomentor_select_child',
      arguments: { childId: 'child-2 & sibling' },
    });

    assert.equal(partial.isError, true);
    assert.match(JSON.stringify(partial), /Selection may have changed/);
    assert.ok(!JSON.stringify(partial).includes('private-upstream-value'));
    assert.equal(routes.selection.id, 'child-2 & sibling');
    routes.selection.failTimetable = false;

    const otherFile = join(directory, 'other/session.json');
    await writeSession(await savedSession('other'), otherFile);
    const otherClient = new InfoMentorClient({ sessionFile: otherFile });

    try {
      const onlyChild = await otherClient.selectChild({ childId: 'only-child' });
      assert.deepEqual(onlyChild.children, [
        { id: 'only-child', name: 'Another account child', selected: true },
      ]);
      assert.equal(onlyChild.timetable?.[0]?.title, 'Another account timetable');
      await assert.rejects(otherClient.selectChild({ childId: 'child-2 & sibling' }), {
        code: 'INVALID_CONFIGURATION',
      });
      assert.equal((await otherClient.getOverview()).children[0]?.id, 'only-child');
      assert.equal(routes.selection.id, 'child-2 & sibling');
    } finally {
      await otherClient.close();
    }

    await client.callTool({ name: 'infomentor_select_child', arguments: { childId: 'child-1' } });

    const malformed = await client.callTool({
      name: 'infomentor_get_messages',
      arguments: { search: 'malformed' },
    });

    assert.equal(malformed.isError, true);
    assert.ok(!JSON.stringify(malformed).includes('private-upstream-value'));
    assert.ok(
      !routes.requests.some(({ url }) =>
        /ViewedMessage|UpdateNotificationState|SendMessage|DeleteMessage/i.test(url),
      ),
    );
    assert.ok(
      tools
        .filter((tool) =>
          [
            'infomentor_get_messages',
            'infomentor_get_message',
            'infomentor_get_notifications',
          ].includes(tool.name),
        )
        .every((tool) => tool.annotations?.readOnlyHint),
    );
    const freshClient = new InfoMentorClient({ sessionFile: file });

    try {
      assert.equal((await freshClient.getSessionStatus()).authenticated, true);
    } finally {
      await freshClient.close();
    }

    const baselineResult = await client.callTool({
      name: 'infomentor_collect_updates',
      arguments: {},
    });

    assert.equal(baselineResult.isError, undefined);
    const baseline = collectionSchema.parse(baselineResult.structuredContent);
    assert.equal(baseline.baseline, true);
    assert.deepEqual(baseline.updates, []);
    assert.equal(baseline.children.length, 2);

    const unchanged = collectionSchema.parse(
      (
        await client.callTool({
          name: 'infomentor_collect_updates',
          arguments: { cursor: baseline.cursor },
        })
      ).structuredContent,
    );

    assert.equal(unchanged.cursor, baseline.cursor);
    assert.deepEqual(unchanged.updates, []);
    assert.equal(routes.selection.id, 'child-1');

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

    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

test('expired sessions renew once with private credentials, preserve account and child, and persist cookies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-refresh-'));
  const file = join(directory, 'session.json');
  const credentialsFile = join(directory, 'credentials.json');
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
  const routes = fixture();
  const fetchEndpoint = globalThis.fetch;
  let expired = false;
  let redirectParent = false;
  let expireMessage = false;
  let rejectPassword = false;
  let wrongAccount = false;
  let failureStatus = 0;
  let passwordSubmissions = 0;

  const fetcher = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.ok(input instanceof URL);
      const body = String(init?.body ?? '');

      if (body.includes('txtLykilord')) {
        passwordSubmissions++;

        if (rejectPassword) return new Response(loginHtml);
        expired = false;
        redirectParent = false;
        routes.selection.id = 'child-1';
      }

      if (input.pathname.endsWith('/isauthenticated/')) {
        if (failureStatus) return new Response('', { status: failureStatus });

        if (expired) return Response.json(false);
      }

      if (expired && input.href === PARENT_URL) return new Response('', { status: 401 });

      if (redirectParent && input.href === PARENT_URL)
        return new Response(null, {
          status: 302,
          headers: { Location: PARENT_URL + 'authentication/authentication/login' },
        });

      if (redirectParent && input.pathname === '/authentication/authentication/login')
        return new Response(relayHtml);

      if (input.pathname === '/Message/message/GetMessage' && expireMessage) {
        expireMessage = false;
        expired = true;

        return new Response('', { status: 401 });
      }

      const response = await fetchEndpoint(input, init);

      if (input.href === PARENT_URL && wrongAccount)
        return new Response((await response.text()).replace('parent-1', 'different-parent'));

      if (input.pathname === '/Message/message/GetMessage')
        response.headers.append('Set-Cookie', 'rotation=kept; Secure; HttpOnly; Path=/');

      return response;
    },
  );

  let client = new InfoMentorClient({ sessionFile: file, credentialsFile });

  try {
    // A missing/deleted session needs explicit login, even when credentials are configured.
    assert.equal((await client.getSessionStatus()).authenticated, false);
    assert.equal(passwordSubmissions, 0);
    await login({ sessionFile: file, credentialsFile });
    assert.equal((await readSession(file)).accountId, 'parent-1');
    await client.selectChild({ childId: 'child-2 & sibling' });
    expired = true;
    const beforeRefresh = passwordSubmissions;
    const overviews = await Promise.all([client.getOverview(), client.getOverview()]);
    assert.equal(passwordSubmissions, beforeRefresh + 1);
    assert.ok(
      overviews.every(
        (overview) => overview.children.find((child) => child.selected)?.id === 'child-2 & sibling',
      ),
    );
    assert.deepEqual(overviews[0]?.timetable, [siblingEntry]);
    expireMessage = true;
    const bodyBefore = passwordSubmissions;
    assert.equal((await client.getMessage({ id: 41 })).message.messageBodyPlainText, 'Bring lunch');
    assert.equal(passwordSubmissions, bodyBefore + 1, 'mid-read expiry gets exactly one recovery');
    assert.ok(
      (await readSession(file)).cookies.some(
        (cookie) => cookie.key === 'rotation' && cookie.value === 'kept',
      ),
    );
    expireMessage = true;
    const collectionBefore = passwordSubmissions;
    const collected = await client.collectUpdates({ includeExisting: true });
    assert.equal(passwordSubmissions, collectionBefore + 1);
    assert.equal(
      routes.selection.id,
      'child-2 & sibling',
      'mid-collection expiry restores the pre-collection child',
    );
    assert.ok(
      collected.updates.some((update) => update.kind === 'message' && update.childIds.length === 2),
    );
    await client.close();
    client = new InfoMentorClient({ sessionFile: file, credentialsFile });
    const restartBefore = passwordSubmissions;
    assert.equal((await client.getSessionStatus()).authenticated, true);
    assert.equal(
      passwordSubmissions,
      restartBefore,
      'a new process reuses persisted renewed cookies',
    );
    redirectParent = true;
    const redirectBefore = passwordSubmissions;
    await client.getOverview();
    assert.equal(
      passwordSubmissions,
      redirectBefore + 1,
      'a known login redirect renews even when isauthenticated returned true',
    );

    for (const status of [403, 429, 500]) {
      failureStatus = status;
      const count: number = passwordSubmissions;
      await assert.rejects(client.getOverview());
      assert.equal(
        passwordSubmissions,
        count,
        'non-authentication failures never submit credentials',
      );
      // A 429 deliberately keeps the HTTP client's cooldown, so use a new client for the next case.
      await client.close();
      client = new InfoMentorClient({ sessionFile: file, credentialsFile });
    }

    failureStatus = 0;

    for (const mode of ['rejected', 'wrong-account']) {
      expired = true;
      rejectPassword = mode === 'rejected';
      wrongAccount = mode === 'wrong-account';
      const before = await readFile(file, 'utf8');
      const count: number = passwordSubmissions;
      await assert.rejects(client.getOverview(), { code: 'LOGIN_REQUIRED' });
      assert.equal(passwordSubmissions, count + 1);
      assert.equal(
        await readFile(file, 'utf8'),
        before,
        'failed recovery must preserve the prior session',
      );
      assert.ok(!before.includes(credentials.password));
    }

    rejectPassword = false;
    wrongAccount = false;
    expired = false;
    await client.logout();
    assert.equal((await client.getSessionStatus()).authenticated, false);
    await client.close();
    const legacyFile = join(directory, 'legacy.json');
    await writeSession(await savedSession(), legacyFile);
    client = new InfoMentorClient({ sessionFile: legacyFile, credentialsFile });
    expired = true;
    const legacyCount = passwordSubmissions;
    await assert.rejects(client.getOverview(), { code: 'LOGIN_REQUIRED' });
    assert.equal(
      passwordSubmissions,
      legacyCount,
      'an unverified expired legacy account cannot silently change',
    );
    expired = false;
    await client.getOverview();
    assert.equal((await readSession(legacyFile)).accountId, 'parent-1');
  } finally {
    await client.close();
    fetcher.mock.restore();
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

          if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) {
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
