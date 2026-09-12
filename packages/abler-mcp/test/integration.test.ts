import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod/v4';

import { AblerClient, childSchedulesInput, scheduleInput } from '../src/api.js';
import { captureCookies, importCookies, loadSession, ORIGIN, saveSession } from '../src/auth.js';
import { createServer } from '../src/server.js';

const requestBodySchema = z.object({
  operationName: z.string(),
  variables: z.object({
    first: z.number().optional(),
    cursor: z.string().nullable().optional(),
    filter: z
      .object({ participant: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  }),
});

const eventBase = {
  name: 'Practice',
  from: '2026-09-11T16:00:00Z',
  to: '2026-09-11T17:00:00Z',
  ageGroup: { id: 'age-group', name: 'Team' },
  currentPlayerAttendance: [],
};

const cookie = {
  name: 'refreshToken',
  value: 'private-refresh',
  domain: 'www.abler.io',
  path: '/',
  expires: Date.now() / 1000 + 3600,
};

test('private cookie import, renewal, pagination, validation, and safe failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-test-'));
  const path = join(directory, 'session.json');

  try {
    await assert.rejects(
      importCookies({ cookies: [{ ...cookie, domain: 'unrelated.example' }] }),
      /refreshToken/,
    );
    await assert.rejects(importCookies({ cookies: [{ ...cookie, expires: 0 }] }), /refreshToken/);
    await assert.rejects(
      importCookies({ cookies: [{ ...cookie, value: 'x\r\nInjected: bad' }] }),
      /Invalid/,
    );

    const jar = await importCookies({
      cookies: [
        cookie,
        { ...cookie, name: '_analytics' },
        { ...cookie, name: 'id_token', value: 'private-stale', expires: Date.now() / 1000 + 55 },
      ],
    });

    await saveSession(path, jar);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('_analytics');
    let renewals = 0;
    let queries = 0;

    const request = async (url: string, options: RequestInit) => {
      expect(url.startsWith(ORIGIN)).toBe(true);
      expect(options.redirect).toBe('error');
      const headers = new Headers(options.headers);

      if (url.endsWith('/oauth/token')) {
        renewals++;
        expect(headers.get('cookie')).toContain('refreshToken=');
        const response = Response.json({ access_token: 'private-access' });
        response.headers.append(
          'Set-Cookie',
          `id_token=private-access; Path=/; Max-Age=600; HttpOnly`,
        );
        response.headers.append(
          'Set-Cookie',
          `refreshToken=rotated-${renewals}; Path=/; Max-Age=3600; HttpOnly`,
        );

        return response;
      }

      queries++;
      expect(headers.get('cookie')).toContain('id_token=private-access');
      const saved = await loadSession(path);
      expect((await saved.getCookies(ORIGIN)).find((c) => c.key === 'refreshToken')?.value).toBe(
        `rotated-${renewals}`,
      );

      const body = requestBodySchema.parse(
        await new Request('https://example.test', options).json(),
      );

      if (queries === 1)
        return Response.json({ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] });

      if (body.operationName === 'Schedule') {
        expect(body.variables.filter).toEqual({
          dateFrom: '2026-09-11',
          dateTo: '2026-09-30',
          label: ['TRAINING'],
        });

        return Response.json({
          data: {
            schedule: {
              edges: [{ node: { ...eventBase, eventId: body.variables.cursor || 'one' } }],
              pageInfo: { hasNextPage: !body.variables.cursor, endCursor: 'opaque-next' },
            },
          },
        });
      }

      return Response.json({ errors: [{ message: 'private-refresh private-access' }] });
    };

    const client = new AblerClient(path, request);
    const filter = { from: '2026-09-11', to: '2026-09-30', types: ['TRAINING' as const], first: 1 };
    const first = await client.schedule(filter);
    assert(first.pageInfo.endCursor);

    const second = await client.schedule({
      ...filter,
      after: first.pageInfo.endCursor,
    });

    expect(first.events[0]?.eventId).toBe('one');
    expect(second.events[0]?.eventId).toBe('opaque-next');
    expect(second.pageInfo.hasNextPage).toBe(false);
    expect(renewals).toBe(2);
    await assert.rejects(client.schedule({ from: '2026-02-30' }));
    await assert.rejects(client.schedule({ from: '2026-09-30', to: '2026-09-11' }));
    await assert.rejects(client.schedule({ first: 101 }));
    assert.throws(() => scheduleInput.parse({ participantId: 'child-a' }));
    await assert.rejects(client.schedule({ participantIds: [] }));
    await assert.rejects(client.status(), /Abler rejected the request/);
    const stored = await loadSession(path);
    const access = (await stored.getCookies(ORIGIN)).find((c) => c.key === 'id_token');
    assert(access);
    expect(access.TTL()).toBeGreaterThan(500000);
    expect(access.TTL()).toBeLessThanOrEqual(600000);
    expect(access.secure).toBe(true);
    await stored.setCookie('refreshToken=deleted; Path=/; Max-Age=0', ORIGIN);
    await saveSession(path, stored);
    await assert.rejects(loadSession(path), /expired/);
    await saveSession(path, jar);

    const revoked = new AblerClient(path, async () =>
      Response.json({ error: 'private-refresh' }, { status: 401 }),
    );

    await assert.rejects(revoked.status(), /expired or was revoked/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('AblerClient stops reading API responses after 4 MiB', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-large-response-'));
  const path = join(directory, 'session.json');

  const accessCookie = {
    ...cookie,
    name: 'id_token',
    value: 'private-access',
    expires: Date.now() / 1000 + 3600,
  };

  await saveSession(path, await importCookies([cookie, accessCookie]));
  let chunks = 0;
  let cancelled = false;

  const client = new AblerClient(
    path,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );

  try {
    await assert.rejects(client.status(), /Abler returned an invalid API response/);
    assert.ok(chunks >= 5);
    assert.equal(cancelled, true);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Chrome capture is limited to loopback and to the Abler tab', async () => {
  await assert.rejects(captureCookies('https://example.com'), /loopback/);

  const mockChrome = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/json/list')
        return Response.json([
          {
            type: 'page',
            url: 'https://unrelated.example',
            webSocketDebuggerUrl: 'ws://unrelated.example',
          },
          {
            type: 'page',
            url: `${ORIGIN}/coach`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/1`,
          },
        ]);

      if (server.upgrade(request)) return undefined;

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const request = z
          .object({
            id: z.number(),
            method: z.string(),
            params: z.object({ urls: z.array(z.string()) }),
          })
          .parse(JSON.parse(String(message)));

        expect(request.method).toBe('Network.getCookies');
        expect(request.params.urls).toEqual([`${ORIGIN}/oauth/token`, `${ORIGIN}/graphql`]);
        socket.send(JSON.stringify({ id: request.id, result: { cookies: [cookie] } }));
      },
    },
  });

  try {
    const jar = await captureCookies(`http://127.0.0.1:${mockChrome.port}`);
    expect(await jar.getCookieString(ORIGIN)).toBe('refreshToken=private-refresh');
  } finally {
    await mockChrome.stop(true);
  }
});

test('groups and event return validated success data, and auth CLI paths stay local', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-targeted-test-'));
  const path = join(directory, 'session.json');

  try {
    const idToken = {
      ...cookie,
      name: 'id_token',
      value: 'private-access',
      expires: Date.now() / 1000 + 3600,
    };

    await saveSession(path, await importCookies({ cookies: [cookie, idToken] }));

    const request = async (_url: string, options: RequestInit) => {
      const body = z
        .object({ operationName: z.string() })
        .parse(await new Request('https://example.test', options).json());

      if (body.operationName === 'Groups')
        return Response.json({
          data: {
            me: {
              userAgeGroups: [
                {
                  id: 'age-group',
                  name: 'U12',
                  isActive: true,
                  sport: { id: 'sport', name: 'Football', unknown: 'removed' },
                  groups: [{ id: 'subgroup', name: 'Blue', label: 'B', unknown: 'removed' }],
                  unknown: 'removed',
                },
              ],
            },
          },
        });

      return Response.json({
        data: {
          event: {
            edges: [
              {
                node: {
                  ...eventBase,
                  eventId: 'event-a',
                  unknown: 'removed',
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };

    const client = new AblerClient(path, request);
    assert.deepEqual(await client.groups(), [
      {
        id: 'age-group',
        name: 'U12',
        isActive: true,
        sport: { id: 'sport', name: 'Football' },
        groups: [{ id: 'subgroup', name: 'Blue', label: 'B' }],
      },
    ]);
    assert.deepEqual(await client.event({ eventId: 'event-a', ageGroupId: 'age-group' }), {
      ...eventBase,
      eventId: 'event-a',
    });

    const runCli = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
        cwd: resolve('.'),
        env: { ...process.env, ABLER_SESSION_FILE: join(directory, 'missing.json') },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      return {
        exit: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    };

    const status = await runCli(['auth', 'status']);
    assert.equal(status.exit, 1);
    assert.match(status.stderr, /No saved Abler session/);
    const logout = await runCli(['auth', 'logout']);
    assert.equal(logout.exit, 0);
    assert.match(logout.stdout, /failed-import candidates removed/);
    const help = await runCli(['--help']);
    assert.equal(help.exit, 0);
    assert.match(help.stdout, /saved session and failed-import candidates/);
    const capture = await runCli(['auth', 'capture', 'https://example.com']);
    assert.equal(capture.exit, 1);
    assert.match(capture.stderr, /loopback/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all six Abler tools complete MCP round trips with optional and null upstream fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-mcp-roundtrip-'));
  const path = join(directory, 'session.json');

  const children = [
    { id: 'child-a', displayName: 'Alex' },
    { id: 'child-b', displayName: 'Jamie' },
  ];

  const event = {
    eventId: 'event-a',
    name: 'Practice',
    description: null,
    from: '2026-09-11T16:00:00Z',
    to: null,
    arrivalTime: null,
    locationDetails: null,
    locationAddress: null,
    locationLink: null,
    ageGroup: { id: 'age-group', name: 'U12' },
    groups: [{ id: 'subgroup', name: 'Blue' }],
    currentPlayerAttendance: children.map((player) => ({
      player,
      status: null,
      coachStatus: null,
    })),
  };

  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    const { operationName } = z
      .object({ operationName: z.string(), variables: z.record(z.string(), z.unknown()) })
      .parse(await new Request('https://example.test', init).json());

    switch (operationName) {
      case 'SessionStatus':
        return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });
      case 'Profile':
        return Response.json({
          data: { me: { id: 'parent', displayName: 'Parent', children } },
        });
      case 'Groups':
        return Response.json({
          data: {
            me: {
              userAgeGroups: [
                {
                  id: 'age-group',
                  name: 'U12',
                  groups: [{ id: 'subgroup', name: 'Blue', label: null }],
                  sport: null,
                },
              ],
            },
          },
        });
      case 'Schedule':
        return Response.json({
          data: {
            schedule: {
              edges: [{ node: event }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      case 'Event':
        return Response.json({
          data: {
            event: {
              edges: [{ node: event }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      default:
        throw new Error('Unexpected Abler operation.');
    }
  };

  const accessCookie = {
    ...cookie,
    name: 'id_token',
    value: 'private-access',
    expires: Date.now() / 1000 + 3600,
  };

  await saveSession(path, await importCookies([cookie, accessCookie]));

  const abler = new AblerClient(path, request);
  const server = createServer(abler);
  const client = new Client({ name: 'abler-roundtrip', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const results = new Map<string, Awaited<ReturnType<typeof client.callTool>>>();

    for (const [name, args] of [
      ['auth_status', {}],
      ['get_profile', {}],
      ['list_groups', {}],
      ['list_schedule', {}],
      ['list_child_schedules', {}],
      ['get_event', { eventId: 'event-a', ageGroupId: 'age-group' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
      assert.ok(result.structuredContent, `${name} should return structured output`);
      results.set(name, result);
    }

    assert.equal(results.size, 6);
    assert.deepEqual(
      z
        .object({ events: z.array(z.object({ description: z.null(), to: z.null() })) })
        .parse(results.get('list_schedule')?.structuredContent).events,
      [{ description: null, to: null }],
    );
    assert.equal(
      z
        .object({ groups: z.array(z.object({ sport: z.null() })) })
        .parse(results.get('list_groups')?.structuredContent).groups[0]?.sport,
      null,
    );
  } finally {
    await client.close();
    await server.close();
    await abler.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP executable exposes only read tools and reports missing auth without protocol noise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-mcp-test-'));
  const client = new Client({ name: 'abler-check', version: '1.0.0' });

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['src/cli.ts'],
    env: { ...process.env, ABLER_SESSION_FILE: join(directory, 'missing.json') },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      'auth_status',
      'get_event',
      'get_profile',
      'list_child_schedules',
      'list_groups',
      'list_schedule',
    ]);
    expect(tools.every((tool) => tool.outputSchema)).toBe(true);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const result = await client.callTool({ name: 'auth_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('No saved Abler session');

    const typo = await client.callTool({
      name: 'list_child_schedules',
      arguments: { childId: 'only-this-child' },
    });

    expect(typo.isError).toBe(true);
    const invalid = await client.callTool({ name: 'list_schedule', arguments: { first: 0 } });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SIGTERM aborts an in-flight Abler fetch and releases its session lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-shutdown-'));
  const path = join(directory, 'session.json');
  const preload = join(directory, 'never-fetch.js');
  await saveSession(
    path,
    await importCookies([cookie, { ...cookie, name: 'id_token', value: 'private-access' }]),
  );
  await writeFile(
    preload,
    `globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      process.stderr.write('FETCH_STARTED\\n');
      const signal = init?.signal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });\n`,
    { mode: 0o600 },
  );
  const client = new Client({ name: 'abler-shutdown-test', version: '1.0.0' });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--preload', preload, 'src/cli.ts'],
    cwd: resolve('.'),
    env: { ...process.env, ABLER_SESSION_FILE: path },
    stderr: 'pipe',
  });

  const fetchStarted = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  transport.stderr?.on('data', (chunk) => {
    if (String(chunk).includes('FETCH_STARTED')) fetchStarted.resolve();
  });
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The SDK transport exposes only onclose.
  transport.onclose = () => stopped.resolve();

  let pending: Promise<unknown> | undefined;

  try {
    await client.connect(transport);
    const pid = transport.pid;
    assert.ok(pid);
    pending = client.callTool({ name: 'auth_status', arguments: {} });
    void pending.catch(() => {});
    await fetchStarted.promise;
    await stat(`${path}.lock`);
    process.kill(pid, 'SIGTERM');
    await stopped.promise;
    await pending.catch(() => {});
    assert.equal(transport.pid, null);
    await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
    assert.deepEqual((await readdir(directory)).toSorted(), ['never-fetch.js', 'session.json']);
  } finally {
    if (transport.pid !== null) process.kill(transport.pid, 'SIGKILL');
    await pending?.catch(() => {});
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('child schedules separate siblings by ID, retain empty children, and paginate independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-children-test-'));
  const path = join(directory, 'session.json');

  const linkedChildren = [
    { id: 'child-a', displayName: 'Alex' },
    { id: 'child-b', displayName: 'Alex' },
    { id: 'child-c', displayName: 'Jamie' },
  ] as const;

  let noChildren = false;
  const requests: { child: string; cursor: string | null }[] = [];

  try {
    await saveSession(
      path,
      await importCookies({ cookies: [cookie, { ...cookie, name: 'id_token' }] }),
    );

    const request = async (_url: string, init: RequestInit) => {
      const body = requestBodySchema.parse(await new Request('https://example.test', init).json());

      if (body.operationName === 'Profile')
        return Response.json({
          data: {
            me: {
              id: 'parent',
              displayName: 'Parent',
              children: noChildren ? [] : linkedChildren,
            },
          },
        });
      expect(body.operationName).toBe('Schedule');
      expect(body.variables.first).toBe(1);
      assert(body.variables.filter?.participant);
      expect(body.variables.filter.participant).toHaveLength(1);
      const child = body.variables.filter.participant[0];
      const cursor = body.variables.cursor;
      assert(child && cursor !== undefined);
      requests.push({ child, cursor });

      return Response.json({
        data: {
          schedule: {
            edges:
              child === 'child-c'
                ? []
                : [
                    {
                      node: {
                        ...eventBase,
                        eventId: cursor ? 'next-event' : 'shared-event',
                        currentPlayerAttendance: [
                          { player: linkedChildren[0], status: 'G', coachStatus: 'P' },
                          { player: linkedChildren[1], status: 'N', coachStatus: null },
                        ],
                      },
                    },
                  ],
            pageInfo: {
              hasNextPage: child === 'child-a' && !cursor,
              endCursor: child === 'child-a' ? 'a-next' : null,
            },
          },
        },
      });
    };

    const client = new AblerClient(path, request);
    expect((await client.profile()).childNamesById).toEqual({
      'child-a': 'Alex',
      'child-b': 'Alex',
      'child-c': 'Jamie',
    });
    const result = await client.childSchedules({ first: 1 });
    assert.deepEqual(
      result.children.map((c) => c.child),
      linkedChildren,
    );
    expect(result.children[0]?.events[0]).toMatchObject({
      eventId: 'shared-event',
      attendance: [{ status: 'G', coachStatus: 'P' }],
    });
    expect(result.children[1]?.events[0]).toMatchObject({
      eventId: 'shared-event',
      attendance: [{ status: 'N', coachStatus: null }],
    });
    expect(result.children[2]).toEqual({
      child: linkedChildren[2],
      events: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    expect(result.children.map((c) => c.pageInfo.hasNextPage)).toEqual([true, false, false]);

    const next = await client.childSchedules({
      childIds: ['child-a'],
      first: 1,
      afterByChild: { 'child-a': 'a-next' },
    });

    expect(next.children).toHaveLength(1);
    expect(next.children[0]?.events[0]?.eventId).toBe('next-event');
    expect(requests).toEqual([
      { child: 'child-a', cursor: null },
      { child: 'child-b', cursor: null },
      { child: 'child-c', cursor: null },
      { child: 'child-a', cursor: 'a-next' },
    ]);
    await assert.rejects(client.childSchedules({ childIds: ['unlinked'] }), /Unknown child/);
    await assert.rejects(
      client.childSchedules({ childIds: ['child-a'], afterByChild: { 'child-b': 'b-next' } }),
      /unselected child/,
    );
    await assert.rejects(client.childSchedules({ from: '2026-09-30', to: '2026-09-11' }));
    assert.throws(() => childSchedulesInput.parse({ childId: 'child-a' }));
    assert.throws(() => childSchedulesInput.parse({ participantIds: ['child-a'] }));
    noChildren = true;
    expect(await client.childSchedules()).toEqual({ children: [] });
    expect(requests).toHaveLength(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('separate processes serialize rotating credentials and logout waits for an in-flight request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-concurrency-'));
  const path = join(directory, 'session.json');
  let current = cookie.value;
  let rotations = 0;
  let hold = false;
  const { promise: refreshing, resolve: started } = Promise.withResolvers<void>();
  const { promise: proceed, resolve: release } = Promise.withResolvers<void>();

  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/oauth/token') {
        if (!request.headers.get('cookie')?.includes(`refreshToken=${current}`))
          return new Response(null, { status: 401 });
        current = `rotated-${++rotations}`;

        if (hold) {
          started();
          await proceed;
        }

        const response = Response.json({ access_token: 'access' });
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=600; HttpOnly');
        response.headers.append(
          'Set-Cookie',
          `refreshToken=${current}; Path=/; Max-Age=3600; HttpOnly`,
        );

        return response;
      }

      return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });
    },
  });

  const env = {
    ...process.env,
    ABLER_TEST_FILE: path,
    ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.port}`,
  };

  const code = `import { AblerClient } from ${JSON.stringify(pathToFileURL(resolve('src/api.ts')).href)};
    const request = (url, init) => fetch(new URL(new URL(url).pathname, process.env.ABLER_TEST_ORIGIN), init);
    console.log(JSON.stringify(await new AblerClient(process.env.ABLER_TEST_FILE, request).status(true)));`;

  const run = () =>
    Bun.spawn([process.execPath, '--eval', code], { env, stdout: 'pipe', stderr: 'pipe' });

  try {
    await saveSession(path, await importCookies([cookie]));
    const processes = [run(), run(), run()];

    const results = await Promise.all(
      processes.map(async (p) => ({
        exit: await p.exited,
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
      })),
    );

    expect(results.map((r) => r.exit)).toEqual([0, 0, 0]);
    expect(
      results.every(
        (r) => z.object({ authenticated: z.boolean() }).parse(JSON.parse(r.out)).authenticated,
      ),
    ).toBe(true);
    expect(results.every((r) => r.err === '')).toBe(true);
    expect(rotations).toBe(3);
    hold = true;
    const active = run();
    await refreshing;

    const logout = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { removeSession } from ${JSON.stringify(pathToFileURL(resolve('src/auth.ts')).href)};
      const removal = removeSession(process.env.ABLER_TEST_FILE);
      console.log("started");
      await removal;`,
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    );

    const reader = logout.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('started');
    expect(await Bun.file(path).exists()).toBe(true);
    release();
    expect(await active.exited).toBe(0);
    expect(await logout.exited).toBe(0);
    expect(await Bun.file(path).exists()).toBe(false);
    expect((await readdir(directory)).length).toBe(0);
  } finally {
    release();
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test('unsafe session files, malformed pages, stalled cursors, and wrong events fail explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-validation-'));
  const path = join(directory, 'session.json');

  try {
    await saveSession(path, await importCookies([cookie, { ...cookie, name: 'id_token' }]));

    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await assert.rejects(loadSession(path), /owner-only/);
      await chmod(path, 0o600);
      await symlink(path, join(directory, 'link.json'));
      await assert.rejects(loadSession(join(directory, 'link.json')), /symlink/);
    }

    type JsonFixture =
      | string
      | number
      | boolean
      | null
      | JsonFixture[]
      | { [key: string]: JsonFixture };

    type TestPage = {
      edges: { node: { [key: string]: JsonFixture } }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };

    let page: TestPage = { edges: [], pageInfo: { hasNextPage: true, endCursor: null } };

    const client = new AblerClient(path, async () =>
      Response.json({ data: { schedule: page, event: page } }),
    );

    await assert.rejects(client.schedule());
    page = { edges: [{ node: {} }], pageInfo: { hasNextPage: false, endCursor: null } };
    await assert.rejects(client.schedule());
    page = {
      edges: [{ node: { ...eventBase, eventId: 'event-a' } }],
      pageInfo: { hasNextPage: true, endCursor: 'same' },
    };
    await assert.rejects(client.schedule({ after: 'same' }), /did not advance/);
    await assert.rejects(
      client.event({ eventId: 'event-b', ageGroupId: 'age-group' }),
      /different event/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed import retains a rotated candidate without overwriting the existing session, and a later verified import removes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-import-'));
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const path = join(sessions, 'session.json');

  try {
    await saveSession(path, await importCookies([cookie]));
    const original = await readFile(path, 'utf8');
    const source = join(directory, 'cookies.json');
    await writeFile(source, JSON.stringify([cookie]), { mode: 0o600 });
    const preload = join(directory, 'upstream.ts');
    await writeFile(
      preload,
      `globalThis.fetch = async url => {
      if (url.endsWith('/oauth/token')) {
        const response = Response.json({ access_token: 'access' });
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=600');
        response.headers.append('Set-Cookie', 'refreshToken=recovery-token; Path=/; Max-Age=3600');
        return response;
      }
      return Response.json({ errors: [{ message: 'recovery-token secret' }] });
    };`,
    );

    const child = Bun.spawn(
      [process.execPath, '--preload', preload, 'src/cli.ts', 'auth', 'import', source],
      {
        env: { ...process.env, ABLER_SESSION_FILE: path },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    expect(await child.exited).toBe(1);
    const error = await new Response(child.stderr).text();
    expect(error).toContain('candidate is retained');
    expect(error).not.toContain('recovery-token');
    expect(await readFile(path, 'utf8')).toBe(original);
    const candidates = (await readdir(sessions)).filter((name) => name.endsWith('.pending'));
    expect(candidates).toHaveLength(1);
    const [candidateName] = candidates;
    assert(candidateName);
    const candidate = join(sessions, candidateName);
    expect((await stat(candidate)).mode & 0o777).toBe(0o600);
    expect(await (await loadSession(candidate)).getCookieString(ORIGIN)).toContain(
      'refreshToken=recovery-token',
    );
    // A later verified import supersedes the retained candidate.
    await writeFile(
      preload,
      `globalThis.fetch = async url => {
      if (url.endsWith('/oauth/token')) {
        const response = Response.json({ access_token: 'access' });
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=600');
        response.headers.append('Set-Cookie', 'refreshToken=verified-token; Path=/; Max-Age=3600');
        return response;
      }
      return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });
    };`,
    );

    const verified = Bun.spawn(
      [process.execPath, '--preload', preload, 'src/cli.ts', 'auth', 'import', source],
      {
        env: { ...process.env, ABLER_SESSION_FILE: path },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    expect(await verified.exited).toBe(0);
    expect(await new Response(verified.stdout).text()).toContain('saved and verified');
    expect((await readdir(sessions)).filter((name) => name.endsWith('.pending'))).toHaveLength(0);
    expect(await (await loadSession(path)).getCookieString(ORIGIN)).toContain(
      'refreshToken=verified-token',
    );

    await writeFile(
      preload,
      `globalThis.fetch = async url => {
      if (url.endsWith('/oauth/token')) {
        const response = Response.json({ access_token: 'access' });
        response.headers.append('Set-Cookie', 'id_token=access; Path=/; Max-Age=600');
        response.headers.append('Set-Cookie', 'refreshToken=recovery-token; Path=/; Max-Age=3600');
        return response;
      }
      return Response.json({ errors: [{ message: 'recovery-token secret' }] });
    };`,
    );

    const failedAgain = Bun.spawn(
      [process.execPath, '--preload', preload, 'src/cli.ts', 'auth', 'import', source],
      { env: { ...process.env, ABLER_SESSION_FILE: path }, stdout: 'pipe', stderr: 'pipe' },
    );

    expect(await failedAgain.exited).toBe(1);
    expect((await readdir(sessions)).some((name) => name.endsWith('.pending'))).toBe(true);

    const logout = Bun.spawn([process.execPath, 'src/cli.ts', 'auth', 'logout'], {
      env: { ...process.env, ABLER_SESSION_FILE: path },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await logout.exited).toBe(0);
    expect(await new Response(logout.stdout).text()).toContain('failed-import candidates removed');
    assert.deepEqual(await readdir(sessions), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
