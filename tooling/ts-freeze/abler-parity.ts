// Freezes what the TypeScript Abler CLI and server do in every scenario of
// rust/abler-mcp/tests/ts/parity.ts, and in the drop-in cases the ledger names `abler/contract/*`,
// for rust/abler-mcp/tests/replay.rs. Run once per set from the repository root with Bun 1.4.2 at
// the commit named in the provenance:
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 FAMILY_MCP_STORE_TEST_SEAM=1 \
//     bun tooling/ts-freeze/abler-parity.ts rust/abler-mcp/tests/fixtures/parity
//
// parity.ts ran each scenario once against the TypeScript CLI (rewrite.ts preloaded) and once
// against the binary, each in its own scratch home and against one fake Abler, and compared the two.
// This runs the TypeScript side alone, every step of it, and keeps each upstream exchange in order:
// the request (method, path with its query, the four headers parity.ts recorded, body) and the
// response the fake served (status, headers, body). Each scenario of a parity.ts loop
// (`refresh-${mode}`, `graphql-${mode}`) is its own file. MCP traffic is raw newline-delimited
// JSON-RPC, and each answer is kept as the line the server wrote. The fake and the scenario tables
// are parity.ts's, copied between the markers below; the copied code changed only where this
// workspace's lint requires (marked `lint:`) and in layout (oxfmt), not in behaviour. Every value is
// synthetic. PR 3 deletes this script with the TypeScript sources.
import { strict as assert } from 'node:assert';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as z from 'zod/v4';

import {
  SessionStoreError,
  defaultKeyProvider,
  defaultSecretRecordPath,
  withSecretStore,
} from '../../packages/session-store/src/index.ts';

const [output, set = 'parity', only] = process.argv.slice(2);

if (output === undefined || !['parity', 'contract'].includes(set))
  throw new RangeError('Usage: abler-parity.ts OUTPUT_DIRECTORY [parity|contract] [CASE]');

if (existsSync(output) && readdirSync(output).length)
  throw new RangeError('The output directory must be empty or absent.');

// Every home keeps its store in scratch folders through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError(
    'Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.',
  );

const repo = resolve(import.meta.dir, '../..');

const cli = join(repo, 'packages/abler-mcp/src/cli.ts');

const rewrite = join(repo, 'rust/abler-mcp/tests/ts/rewrite.ts');

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ts-freeze-abler-'));

// ---- parity.ts (41d6f98): the fake Abler ----
type Seen = { path: string; headers: Record<string, string>; body: string };

const noneSeen: Seen[] = [];

const fake = {
  mode: 'ok',
  accessAge: 3600,
  serial: 0,
  refresh: 'r0',
  access: '',
  // lint: a typed constant, not an assertion.
  seen: noneSeen,
  used: new Set<string>(),
};

function reset(): void {
  Object.assign(fake, { mode: 'ok', accessAge: 3600, serial: 0, refresh: 'r0', access: '' });
  fake.seen = [];
  fake.used = new Set();
}

// lint: a JSON value, a string told apart by a schema, not `typeof`.
function json(body: Json, status = 200, setCookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });

  for (const cookie of setCookies) headers.append('Set-Cookie', cookie);

  const text = z.string().safeParse(body);

  return new Response(text.success ? text.data : JSON.stringify(body), { status, headers });
}

function rotate(): string[] {
  fake.serial += 1;
  fake.refresh = `r${fake.serial}`;
  fake.access = `a${fake.serial}`;

  return [
    `id_token=${fake.access}; Path=/; Max-Age=${fake.accessAge}; HttpOnly; Secure`,
    `refreshToken=${fake.refresh}; Path=/oauth; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    '_ga=GA1.2; Path=/; Domain=abler.io',
  ];
}

const person = (id: string, displayName: string) => ({ id, displayName });

// lint: `groups` added by Object.assign, not a conditional spread; the key order is parity.ts's.
const event = (id: string, players: string[], ageGroup = 'g1') =>
  Object.assign(
    {
      eventId: id,
      name: `Practice ${id}`,
      type: 'TRAINING',
      description: id === 'e1' ? null : 'Bring water',
      from: '2026-10-10T17:00:00Z',
      to: id === 'e2' ? null : '2026-10-10T18:00:00Z',
      status: 'ACTIVE',
      arrivalTime: id === 'e3' ? '17:45' : 15,
      locationDetails: 'Hall',
      locationLink: null,
      ageGroup: { id: ageGroup, name: 'U10', extra: true },
    },
    id === 'e2' ? null : { groups: [{ id: 's1', name: 'A' }] },
    {
      currentPlayerAttendance: players.map((player) => ({
        status: 'ATTENDING',
        coachStatus: player === '2' ? 'CONFIRMED' : null,
        player: person(player, `Player ${player}`),
      })),
      unknownField: 'dropped',
    },
  );

const message = {
  id: 'm1',
  messageBody: 'Hello <b>team</b>',
  createdAt: '2026-10-01T10:00:00Z',
  creator: person('u2', 'Coach'),
  attachments: [
    { id: 'f1', fileName: 'a.pdf', description: null, contentType: 'application/pdf', size: 3 },
  ],
  recipient: { isRead: false },
};

// lint: the variables the fake reads, parsed by a schema, not a dictionary of unknown values.
const graphqlBody = z.object({
  operationName: z.string(),
  variables: z.looseObject({
    cursor: z.string().nullable().optional(),
    filter: z.looseObject({ participant: z.array(z.string()).optional() }).optional(),
    id: z.unknown().optional(),
    ageGroupId: z.unknown().optional(),
  }),
});

type Variables = z.infer<typeof graphqlBody>['variables'];

// lint: the return type is inferred.
function data(operation: string, variables: Variables) {
  const mode = fake.mode;

  switch (operation) {
    case 'SessionStatus':
      return {
        me: mode === 'badShape' ? { id: 'u1' } : { id: 'u1', displayName: 'Parent', email: 'x' },
      };
    case 'Profile': {
      const children = [person('c1', 'Ann'), { ...person('2', 'Bo'), age: 9 }, person('10', 'Cy')];

      if (mode === 'protoChild')
        children.push(person('constructor', 'K'), person('__proto__', 'P'));

      return { me: mode === 'meNull' ? null : { ...person('u1', 'Parent'), children } };
    }

    case 'Groups':
      return {
        me: {
          userAgeGroups: [
            {
              id: 'g1',
              name: 'U10',
              isActive: true,
              groups: [
                { id: 's1', name: 'A', label: null },
                { id: 's2', name: 'B' },
              ],
              sport: { id: 'sp', name: 'Football', z: 1 },
            },
            { id: 'g2', name: 'U12', sport: null },
          ],
        },
      };
    case 'Schedule': {
      // lint: both read from the parsed variables, not asserted.
      const cursor = variables.cursor;
      const filter = variables.filter;
      const participant = filter?.participant?.[0];

      const all =
        cursor === null ? [event('e1', ['c1', '2']), event('e2', ['c1'])] : [event('e3', ['2'])];

      const events = all.filter(
        (e) => !participant || e.currentPlayerAttendance.some((a) => a.player.id === participant),
      );

      const pageInfo =
        mode === 'stuckCursor'
          ? { hasNextPage: true, endCursor: cursor ?? 'n1' }
          : mode === 'incompleteCursor'
            ? { hasNextPage: true, endCursor: null }
            : cursor === null && events.length
              ? { hasNextPage: true, endCursor: 'n1' }
              : { hasNextPage: false, endCursor: null };

      return { schedule: { edges: events.map((node) => ({ node, cursor: 'x' })), pageInfo } };
    }

    case 'Event': {
      const edges =
        mode === 'eventMissing'
          ? []
          : [
              {
                node: event(
                  mode === 'eventMismatch' ? 'other' : String(variables.id),
                  ['c1'],
                  String(variables.ageGroupId),
                ),
              },
            ];

      return { event: { edges, pageInfo: { hasNextPage: false, endCursor: null } } };
    }

    case 'Conversations':
      return {
        getMessageUnreadCount: 3,
        message: {
          edges: [
            {
              node: {
                id: 'k1',
                name: 'Team',
                conversationType: 'GROUP',
                membersCount: 12,
                unreadCount: 2,
                messageGroup: { id: 'mg', name: 'U10' },
                user1: null,
                messages: { edges: [{ node: message }] },
              },
            },
            {
              node: {
                id: 'k2',
                name: null,
                conversationType: 'DIRECT',
                unreadCount: 1.5,
                user1: person('u1', 'Parent'),
                user2: person('u2', 'Coach'),
                messages: { edges: [] },
              },
            },
            { node: { id: 'k3', conversationType: 'DIRECT', unreadCount: 0, messages: null } },
          ],
          pageInfo: { hasNextPage: false, endCursor: 'k3' },
        },
      };
    case 'ConversationMessages':
      return {
        conversationMessages: {
          edges: [
            { node: message },
            {
              node: {
                id: 'm2',
                createdAt: '2026-10-02T10:00:00Z',
                messageBody: null,
                creator: null,
                attachments: null,
                recipient: { isRead: null },
              },
            },
            { node: { id: 'm3', createdAt: '2026-10-03T10:00:00Z', recipient: {} } },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'm3' },
        },
      };
    default:
      return null;
  }
}

/** True the first time a once-only mode applies. */
function first(mode: string): boolean {
  if (fake.mode !== mode || fake.used.has(mode)) return false;
  fake.used.add(mode);

  return true;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Other processes probe loopback ports; only Abler's two endpoints are recorded.
  if (url.pathname !== '/oauth/token' && url.pathname !== '/graphql') return json({}, 404);
  const body = await request.text();
  const headers: Record<string, string> = {};

  for (const name of ['cookie', 'accept', 'content-type', 'content-length']) {
    const value = request.headers.get(name);

    if (value !== null) headers[name] = value;
  }

  fake.seen.push({ path: url.pathname, headers, body });

  const sent = Object.fromEntries(
    (request.headers.get('cookie') ?? '')
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );

  if (url.pathname === '/oauth/token') {
    switch (fake.mode) {
      case 'refresh401':
        return json({ error: 'invalid_grant' }, 401);
      case 'refresh403':
        return json({}, 403);
      case 'refresh500':
        return json({ error: 'secret detail' }, 500);
      case 'refreshNotJson':
        return json('<html>', 200);
      case 'refreshError':
        return json({ access_token: 't', error: 'x' }, 200, rotate());
      case 'refreshNoIdToken':
        return json({ access_token: 't' }, 200, rotate().slice(1));
      case 'refreshRedirect':
        return new Response(null, { status: 302, headers: { Location: '/elsewhere' } });
      case 'badCookieDomain':
        return json({ access_token: 't' }, 200, ['refreshToken=evil; Domain=evil.example; Path=/']);
    }

    if (sent.refreshToken !== fake.refresh) return json({ error: 'invalid_grant' }, 401);

    return json({ access_token: 't', token_type: 'Bearer' }, 200, rotate());
  }

  if (sent.id_token !== fake.access) return json({ errors: [{ message: 'unauthorized' }] }, 401);

  // lint: parsed by a schema, not asserted.
  const { operationName, variables } = graphqlBody.parse(JSON.parse(body));

  if (first('graphql401Once')) return json({}, 401);

  if (first('unauthenticatedOnce'))
    return json({ errors: [{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }] });

  switch (fake.mode) {
    case 'graphqlErrors':
      return json({
        data: data(operationName, variables),
        errors: [{ message: 'private detail' }],
      });
    case 'errorsCodeNumber':
      return json({ data: data(operationName, variables), errors: [{ extensions: { code: 5 } }] });
    case 'graphql500':
      fake.access = `e${++fake.serial}`;

      return json({ errors: [] }, 500, [`id_token=${fake.access}; Path=/; Max-Age=3600`]);
    case 'noData':
      return json({ data: null });
    case 'badJson':
      return json('{"data":');
    case 'bigBody':
      return json(`{"data":{"me":"${'a'.repeat(4 * 1024 * 1024)}"}}`);
  }

  return json({ data: data(operationName, variables) });
}

type Step =
  | { cli: string[]; stdin?: string }
  | { serve: [string, unknown][]; surface?: boolean }
  | { mode: string; accessAge?: number }
  | { file: string; text: string; permissions?: number };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

const exported = JSON.stringify([
  {
    name: 'refreshToken',
    value: 'r0',
    domain: '.abler.io',
    path: '/oauth',
    expirationDate: 4102444800,
    httpOnly: true,
  },
  { name: 'id_token', value: 'stale', domain: 'www.abler.io', path: '/', expires: 1 },
  { name: '_ga', value: 'GA1', domain: '.abler.io' },
  { name: 'other', value: 'x', domain: 'example.com' },
]);

const legacy = JSON.stringify({
  version: 1,
  cookies: [
    {
      name: 'refreshToken',
      value: 'r0',
      domain: 'www.abler.io',
      path: '/oauth',
      expires: 4102444800,
      httpOnly: true,
      secure: true,
    },
  ],
});

const importing: Step = { cli: ['auth', 'import', '-'], stdin: exported };

const sessionFile = '.config/abler-mcp/session.json';

const toolCalls: [string, unknown][] = [
  ['auth_status', {}],
  ['get_profile', {}],
  ['list_groups', {}],
  ['list_schedule', {}],
  [
    'list_schedule',
    {
      from: '2026-10-01',
      to: '2026-10-31',
      types: ['TRAINING'],
      groupIds: ['s1'],
      participantIds: ['c1'],
      first: 5,
      after: 'n1',
    },
  ],
  ['list_child_schedules', {}],
  ['list_child_schedules', { childIds: ['2'], afterByChild: { '2': 'n1' }, types: [] }],
  ['list_child_schedules', { childIds: ['nope'] }],
  ['list_child_schedules', { childIds: ['c1'], afterByChild: { '2': 'n1' } }],
  ['get_event', { eventId: 'e7', ageGroupId: 'g9' }],
  ['list_conversations', {}],
  ['list_conversations', { first: 50, after: 'k0' }],
  ['list_messages', { conversationId: 'k1' }],
  ['list_messages', { conversationId: 'k1', first: 1, after: 'm0' }],
  ['nope', {}],
];

const invalidInputs: [string, unknown][] = [
  ['auth_status', { extra: 1 }],
  ['get_profile', { b: 1, a: 2, '1': 3 }],
  ['list_groups', { __proto__: 1 }],
  ['list_schedule', { first: 0 }],
  ['list_schedule', { first: 101, after: '' }],
  ['list_schedule', { first: 2.5 }],
  ['list_schedule', { first: 1e300 }],
  ['list_schedule', { first: '5' }],
  ['list_schedule', { from: '2026-02-30' }],
  ['list_schedule', { from: '2026-10-02', to: '2026-10-01' }],
  ['list_schedule', { from: '2026-10-02', to: '2026-10-01', x: 1 }],
  ['list_schedule', { from: '2026-10-02', to: '2026-10-01', first: 0 }],
  ['list_schedule', { from: 5, to: '2026-10-01' }],
  ['list_schedule', { types: 'TRAINING' }],
  ['list_schedule', { types: ['TRAINING', 'X'] }],
  ['list_schedule', { types: ['TRAINING', 'MATCH', 'GENERAL', 'CLASSES', 'MATCH'] }],
  ['list_schedule', { groupIds: [] }],
  ['list_schedule', { groupIds: [''] }],
  ['list_schedule', { participantIds: Array.from({ length: 21 }, (_, at) => `p${at}`) }],
  ['list_schedule', { after: 'x'.repeat(1025) }],
  ['list_schedule', { after: null }],
  ['list_child_schedules', { participantIds: ['c1'] }],
  ['list_child_schedules', { after: 'n1' }],
  ['list_child_schedules', { afterByChild: { c1: '' } }],
  ['list_child_schedules', { afterByChild: { '': 'n1' } }],
  ['list_child_schedules', { afterByChild: [] }],
  ['list_child_schedules', { childIds: [], first: 0, afterByChild: 1 }],
  ['get_event', {}],
  ['get_event', { eventId: 'e1' }],
  ['get_event', { eventId: '', ageGroupId: 'x'.repeat(257) }],
  ['list_conversations', { first: 51 }],
  ['list_messages', { first: 0 }],
  ['list_messages', { conversationId: 7, extra: true }],
  ['list_messages', { conversationId: '\u{1F600}'.repeat(129) }],
];

const refreshModes = [
  'refresh401',
  'refresh403',
  'refresh500',
  'refreshNotJson',
  'refreshError',
  'refreshNoIdToken',
  'refreshRedirect',
  'badCookieDomain',
];

const graphqlModes = [
  'graphql401Once',
  'unauthenticatedOnce',
  'graphqlErrors',
  'errorsCodeNumber',
  'graphql500',
  'noData',
  'badJson',
  'bigBody',
  'badShape',
  'meNull',
  'stuckCursor',
  'incompleteCursor',
  'eventMissing',
  'eventMismatch',
  'protoChild',
];

const failingReads: [string, unknown][] = [
  ['auth_status', {}],
  ['get_profile', {}],
  ['list_schedule', { after: 'n1' }],
  ['get_event', { eventId: 'e1', ageGroupId: 'g1' }],
  ['list_child_schedules', {}],
  ['list_conversations', {}],
];

const scenarios: Scenario[] = [
  { name: 'surface', steps: [{ serve: [], surface: true }] },
  {
    name: 'no-session',
    steps: [
      {
        serve: [
          ['auth_status', {}],
          ['get_profile', {}],
        ],
      },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'retry-candidate'] },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'logout'] },
      { cli: ['auth', 'status'] },
    ],
  },
  { name: 'tools', steps: [importing, { serve: toolCalls }, { cli: ['auth', 'status'] }] },
  { name: 'inputs', steps: [{ serve: invalidInputs }] },
  {
    name: 'cli',
    steps: [
      ['--help'],
      ['-h'],
      ['--version'],
      ['-v'],
      ['-hv'],
      ['--nope'],
      ['--help=1'],
      ['auth'],
      ['auth', 'nope'],
      ['auth', 'status', 'x'],
      ['auth', 'import'],
      ['auth', 'import', ''],
      ['--browser', 'x', 'auth', 'status'],
      ['auth', 'status', '--timeout', '5'],
      ['serve', 'x'],
      ['x'],
      ['auth', 'login', 'x'],
      ['auth', 'login', '--timeout', '0'],
      ['--timeout=1.5', 'auth', 'login'],
      ['auth', 'login', '--timeout', '-1'],
      ['auth', 'logout', 'x', 'y'],
      ['auth', 'retry-candidate', 'x'],
    ].map((args) => ({ cli: args })),
  },
  {
    name: 'import-errors',
    steps: [
      { cli: ['auth', 'import', '-'], stdin: '{"cookies":' },
      {
        cli: ['auth', 'import', '-'],
        stdin: JSON.stringify([{ name: 'id_token', value: 'a', domain: 'abler.io' }]),
      },
      {
        cli: ['auth', 'import', '-'],
        stdin: JSON.stringify([{ name: 'refreshToken', value: 'a b', domain: 'abler.io' }]),
      },
      {
        cli: ['auth', 'import', '-'],
        stdin: JSON.stringify({
          cookies: [{ name: 'refreshToken', value: 'r0', domain: 'www.abler.io', path: 'x' }],
        }),
      },
      { cli: ['auth', 'import', '-'], stdin: ' '.repeat(4 * 1024 * 1024 + 1) },
      { cli: ['auth', 'import', 'missing.json'] },
      { file: 'loose.json', text: exported, permissions: 0o644 },
      { cli: ['auth', 'import', 'loose.json'] },
      { file: 'cookies.json', text: exported, permissions: 0o600 },
      { cli: ['auth', 'import', 'cookies.json'] },
      { cli: ['auth', 'status'] },
    ],
  },
  {
    name: 'verification',
    steps: [
      { mode: 'refresh500' },
      importing,
      { cli: ['auth', 'status'] },
      { mode: 'ok' },
      { cli: ['auth', 'retry-candidate'] },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'retry-candidate'] },
    ],
  },
  {
    name: 'expired-import',
    steps: [{ mode: 'refresh401' }, importing, { cli: ['auth', 'retry-candidate'] }],
  },
  {
    name: 'migrate',
    steps: [
      { file: sessionFile, text: legacy },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
      { file: sessionFile, text: legacy },
      { file: `${sessionFile}.old.pending`, text: legacy },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'logout'] },
      { cli: ['auth', 'status'] },
    ],
  },
  {
    name: 'migrate-candidate',
    steps: [
      { file: `${sessionFile}.a.pending`, text: '{"broken":' },
      { file: `${sessionFile}.b.pending`, text: legacy },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'retry-candidate'] },
      { cli: ['auth', 'status'] },
    ],
  },
  {
    name: 'legacy-rotation',
    steps: [
      { mode: 'ok', accessAge: 30 },
      { file: sessionFile, text: legacy },
      {
        serve: [
          ['get_profile', {}],
          ['auth_status', {}],
        ],
      },
      { file: `${sessionFile}.bad`, text: '' },
      { file: sessionFile, text: '[]' },
      { serve: [['auth_status', {}]] },
    ],
  },
  {
    name: 'session-file-env',
    env: { ABLER_SESSION_FILE: 'custom/../custom/legacy.json' },
    steps: [
      { file: 'custom/legacy.json', text: legacy },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
    ],
  },
  {
    name: 'collision',
    env: { ABLER_SESSION_FILE: '.config/abler-mcp/session.enc.json' },
    steps: [importing, { cli: ['auth', 'logout'] }],
  },
  ...refreshModes.map((mode) => ({
    name: `refresh-${mode}`,
    steps: [
      { mode: 'ok', accessAge: 30 },
      importing,
      { mode },
      {
        serve: [
          ['auth_status', {}],
          ['auth_status', {}],
        ],
      },
      // lint: `satisfies`, not an assertion.
    ] satisfies Step[],
  })),
  ...graphqlModes.map((mode) => ({
    name: `graphql-${mode}`,
    // lint: `satisfies`, not an assertion.
    steps: [importing, { mode }, { serve: failingReads }] satisfies Step[],
  })),
];

// ---- end of parity.ts ----

type Answer = { status: number; headers: Record<string, string | string[]>; body: string };

type Exchange = {
  request: { method: string; path: string; headers: Record<string, string | null>; body: string };
  response: Answer;
};

/** The headers parity.ts recorded of each request (`null` when absent). */
const COMPARED = ['cookie', 'accept', 'content-type', 'content-length'];

/** Response headers that belong to the transport, not to Abler's answer. */
const TRANSPORT = new Set([
  'set-cookie',
  'date',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);

/** Every exchange of Abler's two endpoints, in the order the requests arrived. */
const exchanges: Exchange[] = [];

/** parity.ts's `handle`, recording what it was asked and what it answered. */
async function recorded(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // As parity.ts: other processes probe loopback ports; only Abler's two endpoints are recorded.
  if (url.pathname !== '/oauth/token' && url.pathname !== '/graphql') return handle(request);

  const headers: Record<string, string | null> = {};

  for (const name of COMPARED) headers[name] = request.headers.get(name);

  const body = await request.clone().text();
  const response = await handle(request);
  const kept: Record<string, string | string[]> = {};

  for (const [name, value] of response.headers) if (!TRANSPORT.has(name)) kept[name] = value;

  const cookies = response.headers.getSetCookie();

  if (cookies.length) kept['set-cookie'] = cookies;

  exchanges.push({
    request: { method: request.method, path: url.pathname + url.search, headers, body },
    response: { status: response.status, headers: kept, body: await response.clone().text() },
  });

  return response;
}

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: recorded });

const origin = `http://127.0.0.1:${server.port}`;

/** parity.ts's environment of a run in `home`, with a temporary folder outside it. */
function environment(home: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: `${home}.tmp`,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    ABLER_TEST_ORIGIN: origin,
    ...extra,
  };
}

/**
 * What no output may hold: a cookie assignment, or a cookie value the fake or a scenario hands out
 * (`r0` and its rotations `rN`, the access tokens `aN`, `stale`, the analytics `GA1`).
 */
const LEAKS = [/refreshToken=|id_token=/, /\b[ar]\d+\b/, /\bGA1\b/, /\bstale\b/];

function leaks(at: string, text: string): void {
  for (const leak of LEAKS)
    if (leak.test(text)) throw new RangeError(`${at}: an output matches ${leak}.`);
}

/** How far a cookie expiry may lie from the scenario's start and still be one the fake set. */
const RELATIVE_SPAN = 40 * 24 * 3600 * 1000;

/**
 * Per home: `<home>` for the scratch home, `<candidate-id>` for a candidate's random ID, and each
 * cookie's `expires` as a string: within 40 days of the scenario's start, `<now+Nks>` (N the offset
 * in kiloseconds, rounded: Max-Age 30 is 0, 600 is 1, 3600 is 4, 2592000 is 2592, and a scenario
 * would need minutes to cross a rounding boundary); otherwise `<at:S>`, S the value rounded to
 * whole seconds (the export's 2100 expiry, 0 and -1 for an expired or session cookie).
 */
const jsonValue = z.json();

type Json = z.infer<typeof jsonValue>;

class Names {
  constructor(
    private readonly home: string,
    readonly start: number,
  ) {}

  fresh(text: string): string {
    return text.replaceAll(realpathSync(this.home), '<home>').replaceAll(this.home, '<home>');
  }

  expires(seconds: number): string {
    const offset = seconds * 1000 - this.start;

    return Math.abs(offset) < RELATIVE_SPAN
      ? `<now${offset < 0 ? '-' : '+'}${Math.abs(Math.round(offset / 1_000_000))}ks>`
      : `<at:${Math.round(seconds)}>`;
  }

  /** A JSON value with every `expires` named and candidate IDs hidden. */
  named(value: Json): Json {
    if (Array.isArray(value)) return value.map((item) => this.named(item));

    const object = z.record(z.string(), jsonValue).safeParse(value);

    if (!object.success) return value;

    return Object.fromEntries(
      Object.entries(object.data).map(([key, item]) => {
        const seconds = z.number().safeParse(item);

        if (key === 'expires' && seconds.success) return [key, this.expires(seconds.data)];

        if (key === 'id' && z.uuid().safeParse(item).success) return [key, '<candidate-id>'];

        return [key, this.named(item)];
      }),
    );
  }

  /** A JSON text named, or any other text with the home named. */
  text(text: string): Json {
    try {
      return this.named(jsonValue.parse(JSON.parse(text)));
    } catch {
      return this.fresh(text);
    }
  }
}

function command(args: string[]): string[] {
  return [process.execPath, '--preload', rewrite, cli, ...args];
}

/** What the freeze recorded: CLI runs, tool results, those with structured content, requests. */
const coverage = { cli: 0, tools: 0, structured: 0, requests: 0 };

/** A tool call's answer, as far as the coverage counts read it. */
const toolAnswer = z.looseObject({
  result: z
    .looseObject({ content: z.unknown().optional(), structuredContent: z.unknown().optional() })
    .optional(),
});

async function runCli(
  home: string,
  names: Names,
  env: Record<string, string>,
  step: { cli: string[]; stdin?: string },
) {
  const start = exchanges.length;

  const child = Bun.spawn(command(step.cli), {
    cwd: home,
    env: environment(home, env),
    stdin: step.stdin === undefined ? 'ignore' : new Blob([step.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  leaks(home, stdout + stderr);
  coverage.cli += 1;

  return {
    ...step,
    code,
    stdout: names.fresh(stdout),
    stderr: names.fresh(stderr),
    exchanges: exchanges.slice(start),
  };
}

/** The protocol version and client the replay sends too. */
const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'abler-parity', version: '1.0.0' },
};

const toolArguments = z.record(z.string(), jsonValue);

type Arguments = z.infer<typeof toolArguments>;

type Params = typeof INITIALIZE | { name: string; arguments: Arguments } | Record<string, never>;

type Outgoing = { id?: number; method: string; params?: Params };

/** A message the server wrote: an answer carries an id, a notification none. */
const incomingMessage = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
});

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);

      if (line.trim()) yield line;
    }
  }
}

/** `abler-mcp serve` over raw JSON-RPC, as one MCP client for the server's life. */
class Server {
  private readonly child;

  private readonly incoming;

  private id = 0;

  constructor(home: string, env: Record<string, string>) {
    this.child = Bun.spawn(command(['serve']), {
      cwd: home,
      env: environment(home, env),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.incoming = lines(this.child.stdout);
  }

  async send(outgoing: Outgoing): Promise<void> {
    await this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...outgoing })}\n`);
    await this.child.stdin.flush();
  }

  /** The answer to a new request, with the notifications before it. */
  async request(
    method: string,
    params: Params,
  ): Promise<{ notifications: string[]; answer: string }> {
    const id = this.id++;
    await this.send({ id, method, params });
    const notifications: string[] = [];

    for (;;) {
      const next = await this.incoming.next();

      if (next.done === true) throw new RangeError(`The server closed before answering ${id}.`);

      const parsed = incomingMessage.parse(JSON.parse(next.value));

      if (parsed.id === undefined) {
        notifications.push(next.value);
        continue;
      }

      if (parsed.id !== id)
        throw new RangeError(`An answer to ${JSON.stringify(parsed.id)}, not ${id}.`);

      return { notifications, answer: next.value };
    }
  }

  async initialize(): Promise<string> {
    const { answer } = await this.request('initialize', INITIALIZE);
    await this.send({ method: 'notifications/initialized' });

    return answer;
  }

  async close(): Promise<{ code: number | null; stderr: string }> {
    await this.child.stdin.end();

    const [stderr, code] = await Promise.all([
      new Response(this.child.stderr).text(),
      this.child.exited,
    ]);

    return { code, stderr };
  }
}

type Result = {
  call: [string, unknown];
  notifications?: unknown[];
  answer: string;
  exchanges: Exchange[];
};

async function runServe(
  home: string,
  names: Names,
  env: Record<string, string>,
  step: { serve: [string, unknown][]; surface?: boolean },
) {
  const mcp = new Server(home, env);
  const initialize = await mcp.initialize();
  const list = step.surface === true ? (await mcp.request('tools/list', {})).answer : undefined;
  const results: Result[] = [];

  for (const [name, args] of step.serve) {
    const start = exchanges.length;

    const { notifications, answer } = await mcp.request('tools/call', {
      name,
      arguments: toolArguments.parse(args),
    });

    leaks(home, answer + notifications.join(''));
    const { result } = toolAnswer.parse(JSON.parse(answer));

    if (result?.content !== undefined) coverage.tools += 1;

    if (result?.structuredContent !== undefined) coverage.structured += 1;
    results.push(
      Object.assign(
        { call: [name, args] satisfies [string, unknown] },
        notifications.length
          ? {
              notifications: notifications.map((line) =>
                z.unknown().parse(JSON.parse(names.fresh(line))),
              ),
            }
          : undefined,
        { answer: names.fresh(answer), exchanges: exchanges.slice(start) },
      ),
    );
  }

  const { code, stderr } = await mcp.close();
  leaks(home, stderr);

  return Object.assign({ serve: true }, list === undefined ? undefined : { initialize, list }, {
    results,
    code,
    stderr: names.fresh(stderr),
  });
}

/** The store's record and its key: encrypted or random bytes; `stored` reads the record. */
const STORE_FILES = /^(\.config\/abler-mcp\/session\.enc|\.local\/share\/family-mcp\/keys\/.*)$/;

/** Every path under `home` (a folder ends in `/`) with its permission bits, sorted. */
function files(home: string, names: Names): string[] {
  return readdirSync(home, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const raw = relative(home, join(entry.parentPath, entry.name));
      const info = lstatSync(join(home, raw));
      const mode = (info.mode & 0o777).toString(8);

      return info.isDirectory() ? `${names.fresh(raw)}/ ${mode}` : `${names.fresh(raw)} ${mode}`;
    })
    .toSorted();
}

/** The text of every other file under `home` by path, a JSON text with its expiries named. */
function texts(home: string, names: Names): Record<string, Json> {
  return Object.fromEntries(
    readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(home, join(entry.parentPath, entry.name)))
      .filter((path) => !STORE_FILES.test(path))
      .toSorted()
      .map((path) => [names.fresh(path), names.text(readFileSync(join(home, path), 'utf8'))]),
  );
}

/** Run `work` with `home`'s environment in this process (the store paths follow it). */
async function inHome<T>(home: string, work: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  Object.assign(process.env, environment(home));

  try {
    return await work();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

type Stored = { store: 'none' } | { record: Json } | { error: string };

/** What the store holds: no store, the decrypted record (named), or the error code. */
async function stored(home: string, names: Names): Promise<Stored> {
  return inHome(home, async () => {
    // parity.ts's options.
    const options = {
      path: defaultSecretRecordPath('abler-mcp'),
      server: 'abler-mcp',
      profile: 'default',
      purpose: 'session',
      schema: 1,
      maxBytes: 262_144 * 2 + 4096,
      keys: defaultKeyProvider({ server: 'abler-mcp', profile: 'default' }),
    };

    if (!existsSync(options.path) && !existsSync(`${options.path}.marker`))
      return { store: 'none' };

    try {
      const text = await withSecretStore(options, (opened) => opened.read());

      return { record: text === null ? null : names.text(text) };
    } catch (error) {
      return { error: error instanceof SessionStoreError ? error.code : 'unknown' };
    }
  });
}

async function run(scenario: Scenario) {
  const home = join(scratch, scenario.name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(`${home}.tmp`, { recursive: true, mode: 0o700 });
  const names = new Names(home, Date.now());
  reset();
  const start = exchanges.length;
  const env = scenario.env ?? {};
  const steps: object[] = [];

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(home, names, env, step));
    else if ('serve' in step) steps.push(await runServe(home, names, env, step));
    else if ('mode' in step) {
      Object.assign(fake, { mode: step.mode, accessAge: step.accessAge ?? fake.accessAge });
      steps.push(step);
    } else {
      // parity.ts's `write`.
      const path = join(home, step.file);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, step.text, { mode: step.permissions ?? 0o600 });
      chmodSync(path, step.permissions ?? 0o600);
      steps.push(step);
    }
  }

  const requests = exchanges.length - start;
  assert.equal(
    requests,
    fake.seen.length,
    `${scenario.name}: every request the fake saw is recorded`,
  );

  return Object.assign(
    { steps, id: `abler/${set}/${scenario.name}` },
    scenario.env ? { env: scenario.env } : undefined,
    { requests, files: files(home, names), texts: texts(home, names) },
    await stored(home, names),
  );
}

/**
 * Long runs of one character inside JSON strings become `\u0001<character>*<count>\u0001`; the
 * replay expands them. No frozen value holds a U+0001.
 */
function pack(text: string): string {
  if (text.includes('\\u0001')) throw new RangeError('A frozen value holds a U+0001.');

  return text.replaceAll(
    /(?<!\\)([^\\"])\1{1023,}/g,
    (sequence: string, unit: string) => `\\u0001${unit}*${sequence.length}\\u0001`,
  );
}

/** One step per line, so a fixture's diff names the step that changed. */
function layout(frozen: { steps: object[] }): string {
  const { steps, ...rest } = frozen;
  const head = JSON.stringify(rest);

  return `{"steps":[\n${steps.map((step) => JSON.stringify(step)).join(',\n')}\n],${head.slice(1)}\n`;
}

try {
  mkdirSync(output, { recursive: true });

  for (const scenario of scenarios) {
    if (only !== undefined && scenario.name !== only) continue;
    const frozen = await run(scenario);
    coverage.requests += frozen.requests;
    writeFileSync(join(output, `${scenario.name}.json`), pack(layout(frozen)));
  }
} finally {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`frozen ${set}: ${JSON.stringify(coverage)}\n`);
