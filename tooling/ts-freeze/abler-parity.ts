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
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as z from 'zod/v4';

import {
  SessionStoreError,
  defaultKeyProvider,
  defaultSecretRecordPath,
  withSecretStore,
} from '../../packages/session-store/src/index.ts';
import { importCookies, saveSession } from '../../packages/abler-mcp/src/auth.ts';

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

// parity.ts's preload, or for the contract set one that also routes the default Chrome debugging
// endpoint and honours ABLER_TEST_FORCE_REFRESH (abler-rewrite.ts).
const rewrite =
  set === 'parity'
    ? join(repo, 'rust/abler-mcp/tests/ts/rewrite.ts')
    : join(repo, 'tooling/ts-freeze/abler-rewrite.ts');

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

/** A response body the client had to stop reading: `endless` zero bytes per write, unbounded. */
type Unbounded = { status: number; headers: Record<string, string>; endless: number };

type Exchange = {
  request: { method: string; path: string; headers: Record<string, string | null>; body: string };
  response?: Answer | Unbounded;
  /** A request to the default Chrome debugging endpoint, not to Abler. */
  chrome?: true;
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
    ABLER_TEST_ORIGIN: set === 'contract' ? caseOrigin : origin,
    ...extra,
  };
}

/**
 * What no output may hold: a cookie assignment, or a cookie value the fake or a scenario hands out
 * (`r0` and its rotations `rN`, the access tokens `aN`, `stale`, the analytics `GA1`).
 */
const LEAKS = [
  /refreshToken=|id_token=/,
  /\b[ar]\d+\b/,
  /\bGA1\b/,
  /\bstale\b/,
  // The contract set's: its cookie values and the markers its cases plant.
  /private-refresh|private-access|offline-access|rotated-\d|PRIVATE_EXCEPTION_MARKER|private-domain-marker/,
];

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
  step: { cli: string[]; stdin?: string; stdinFolder?: true },
  args = step.cli,
) {
  const start = exchanges.length;
  // The contract set's standard input that cannot be read: a folder.
  const folder = step.stdinFolder === true ? openSync(home, 'r') : undefined;

  const child = Bun.spawn(command(args), {
    cwd: home,
    env: environment(home, env),
    stdin: folder ?? (step.stdin === undefined ? 'ignore' : new Blob([timed(step.stdin)])),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (folder !== undefined) closeSync(folder);

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

  constructor(home: string, env: Record<string, string>, args = ['serve']) {
    this.child = Bun.spawn(command(args), {
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

// ---- the contract set ----

/**
 * An expiry `N` seconds from now, written `"<in:N>"` (a JSON string) in a fixture's file text or
 * standard input; the freeze and the replay write the whole seconds it names, as a number. The
 * drop-ins computed `Date.now() / 1000 + N`; whole seconds keep a text's byte length the same on
 * every run (until 2286), which the 4 MiB limit cases need.
 */
const IN = /"<in:(-?\d+)>"/g;

function timed(text: string): string {
  const now = Math.floor(Date.now() / 1000);

  return text.replaceAll(IN, (_match, seconds: string) => String(now + Number(seconds)));
}

/** A response body of `chunk` zero bytes, written again and again until the client goes. */
class Endless {
  chunks = 0;

  cancelled = false;

  constructor(readonly chunk: number) {}
}

type CaseAnswer = (url: string, init: RequestInit) => Response | Endless | Promise<Response>;

/** The running case's upstream: the fetch its drop-in injected. A throw drops the connection. */
let answerCase: CaseAnswer = () => {
  throw new RangeError('No contract case is running.');
};

/** The last unbounded answer, for its case's check. */
let lastEndless: Endless | undefined;

/** A request's body as UTF-8 text; never lossy. */
async function bytesOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);

  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * The contract set's loopback upstream, as rust-abler.ts's `upstream` served each drop-in's fetch:
 * every request reaches the case's answer as `https://www.abler.io<path>` (or, under
 * `/chrome-9222`, as `http://127.0.0.1:9222<path>`) with `redirect: 'error'`, and is recorded with
 * what it was answered. A loopback port scanner's `GET /` gets a 404 and no record.
 */
const caseServer = createServer((incoming, out) => {
  (async () => {
    const url = incoming.url ?? '/';

    if (incoming.method === 'GET' && url === '/') {
      out.writeHead(404).end();

      return;
    }

    const chrome = url.startsWith('/chrome-9222/');
    const path = chrome ? url.slice('/chrome-9222'.length) : url;
    const asked: Record<string, string | null> = {};

    for (const name of COMPARED) asked[name] = incoming.headers[name]?.toString() ?? null;

    const headers = new Headers();

    for (const [name, value] of Object.entries(incoming.headers))
      for (const item of [value ?? []].flat()) headers.append(name, item);

    const body = await bytesOf(incoming);
    const method = incoming.method ?? '';
    const exchange: Exchange = { request: { method, path, headers: asked, body } };

    if (chrome) exchange.chrome = true;

    exchanges.push(exchange);
    const aborted = new AbortController();
    out.once('close', () => aborted.abort());
    let response: Response | Endless;

    try {
      response = await answerCase(
        `${chrome ? 'http://127.0.0.1:9222' : 'https://www.abler.io'}${path}`,
        {
          method,
          headers,
          body: body === '' ? null : body,
          redirect: 'error',
          signal: aborted.signal,
        },
      );
    } catch {
      // A failed fetch: the connection drops, recorded as status 0.
      exchange.response = { status: 0, headers: {}, body: '' };
      incoming.socket.destroy();

      return;
    }

    if (response instanceof Endless) {
      lastEndless = response;
      exchange.response = { status: 200, headers: {}, endless: response.chunk };
      const closed = new Promise<void>((done) => out.once('close', done));
      const client = { gone: false };
      out.once('close', () => (client.gone = true));
      out.writeHead(200);

      // A write after the client went fails; `client.gone` ends the loop.
      out.on('error', () => undefined);

      while (!client.gone) {
        response.chunks += 1;

        if (out.write(Buffer.alloc(response.chunk)))
          await new Promise((done) => setImmediate(done));
        else await Promise.race([new Promise((done) => out.once('drain', done)), closed]);
      }

      response.cancelled = true;

      return;
    }

    const kept: Record<string, string | string[]> = {};

    for (const [name, value] of response.headers) if (!TRANSPORT.has(name)) kept[name] = value;

    const cookies = response.headers.getSetCookie();

    if (cookies.length) kept['set-cookie'] = cookies;

    const text = await response.text();
    exchange.response = { status: response.status, headers: kept, body: text };
    out.writeHead(response.status, kept);
    out.end(text);
  })().catch(() => incoming.socket.destroy());
});

await new Promise<void>((done) => caseServer.listen({ host: '127.0.0.1', port: 0 }, done));

const caseAddress = caseServer.address();

if (!(caseAddress instanceof Object)) throw new RangeError('No contract upstream port.');

const caseOrigin = `http://127.0.0.1:${caseAddress.port}`;

/** A CLI run of the contract set, for a case's check. */
type CliRun = { code: number | null; stdout: string; stderr: string; exchanges: Exchange[] };

/** A tool call's outcome, for a case's check: its structured content, or its error text. */
type Outcome = { ok: true; value: Json } | { ok: false; text: string };

const toolOutcome = z.object({
  result: z.object({
    content: z.array(z.looseObject({ text: z.string().optional() })),
    structuredContent: jsonValue.optional(),
    isError: z.boolean().optional(),
  }),
});

function outcome(answer: string): Outcome {
  const { result } = toolOutcome.parse(JSON.parse(answer));

  return result.isError === true
    ? { ok: false, text: result.content[0]?.text ?? '' }
    : { ok: true, value: result.structuredContent ?? null };
}

type CaseStep =
  | { file: string; text: string; permissions?: number }
  | { chmod: string; permissions: number }
  | { symlink: string; target: string }
  | { link: string; target: string }
  | { remove: string }
  | {
      cli: string[];
      stdin?: string;
      stdinFolder?: true;
      env?: Record<string, string>;
      check?: (ran: CliRun) => void;
    }
  | { serve: [string, Json]; env?: Record<string, string>; check?: (got: Outcome) => void }
  | { open: true; args?: string[]; list?: true; check?: (list: string) => void }
  | { call: [string, Json]; check?: (got: Outcome) => void }
  | { close: true }
  | { snapshot: true; check?: (store: Stored) => void }
  | { secrets: string[]; under: string[] }
  | { set: () => void };

type Case = {
  name: string;
  env: Record<string, string>;
  answer: CaseAnswer;
  steps: CaseStep[];
  /** The drop-in's assertions on the whole run, if any. */
  after?: (requests: Exchange[]) => void;
};

/** A drop-in's `fixture` cookie: `refreshToken=private-refresh` for Abler's host, an hour left. */
const COOKIE = {
  name: 'refreshToken',
  value: 'private-refresh',
  domain: 'www.abler.io',
  path: '/',
  expires: '<in:3600>',
};

/** `saveSession(path, await importCookies(cookies))`'s text, its expiries `"<in:N>"` again. */
async function session(cookies: object[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const jar = await importCookies(
    z.array(jsonValue).parse(JSON.parse(timed(JSON.stringify(cookies)))),
  );

  const path = join(scratch, 'session-text.json');
  await saveSession(path, jar);
  let text = readFileSync(path, 'utf8');
  rmSync(path);

  for (const seconds of new Set([...JSON.stringify(cookies).matchAll(IN)].map((m) => m[1])))
    text = text.replaceAll(`"expires":${now + Number(seconds)},`, `"expires":"<in:${seconds}>",`);

  assert.ok(!/"expires":\d/.test(text), `an expiry was left absolute: ${text}`);

  return text;
}

const offline: CaseAnswer = () => {
  throw new Error('UNEXPECTED_FETCH');
};

/** A CLI run the drop-in expected to fail with `diagnostic` on stderr and nothing on stdout. */
const rejected =
  (diagnostic: string, exact = false) =>
  (ran: CliRun) => {
    assert.equal(ran.code, 1, ran.stderr);
    assert.equal(ran.stdout, '');

    if (exact) assert.equal(ran.stderr.trim(), diagnostic);
    else assert.ok(ran.stderr.includes(diagnostic), ran.stderr);
  };

/** A tool call the drop-in expected to fail, perhaps with `pattern` in its text. */
const refused = (pattern?: RegExp) => (got: Outcome) => {
  assert.ok(!got.ok, JSON.stringify(got));

  if (pattern !== undefined) assert.match(got.text, pattern);
};

/** A tool call the drop-in expected to succeed with `expected`, or with any value. */
const gave = (expected?: Json) => (got: Outcome) => {
  assert.ok(got.ok, JSON.stringify(got));

  if (expected !== undefined) assert.deepEqual(got.value, expected);
};

const MARKER = 'PRIVATE_EXCEPTION_MARKER';

const SESSION = { ABLER_SESSION_FILE: '<home>/session.json' };

/** integration.test.ts's `eventBase`. */
const eventBase = {
  name: 'Practice',
  from: '2026-09-11T16:00:00Z',
  to: '2026-09-11T17:00:00Z',
  ageGroup: { id: 'age-group', name: 'Team' },
  currentPlayerAttendance: [],
};

/** The parsed body of a GraphQL request. */
const graphqlRequest = z.object({
  operationName: z.string(),
  query: z.string(),
  variables: z.record(z.string(), jsonValue),
});

async function requestBody(init: RequestInit) {
  return graphqlRequest.parse(await new Request('https://example.test', init).json());
}

/** integration.test.ts:98: auth import refuses unsafe files and oversized input. */
async function importRefusals(): Promise<Case> {
  const oversized = ' '.repeat(4 * 1024 * 1024 + 1);
  const target = '<home>/cookies.json';

  return {
    name: 'import-refusals',
    env: SESSION,
    answer: offline,
    steps: [
      { file: 'cookies.json', text: JSON.stringify([COOKIE]) },
      { chmod: 'cookies.json', permissions: 0o644 },
      { cli: ['auth', 'import', target], stdin: '', check: rejected('owner-only') },
      { chmod: 'cookies.json', permissions: 0o666 },
      { cli: ['auth', 'import', target], stdin: '', check: rejected('owner-only') },
      { chmod: 'cookies.json', permissions: 0o600 },
      { symlink: 'symlink.json', target },
      { cli: ['auth', 'import', '<home>/symlink.json'], stdin: '', check: rejected('symlink') },
      // A symbolic link's own mode differs between macOS and Linux; it is not left in the home.
      { remove: 'symlink.json' },
      { link: 'hardlink.json', target: 'cookies.json' },
      { cli: ['auth', 'import', '<home>/hardlink.json'], stdin: '', check: rejected('hard link') },
      { cli: ['auth', 'import', target], stdin: '', check: rejected('hard link') },
      { remove: 'hardlink.json' },
      { cli: ['auth', 'import', '<home>'], stdin: '', check: rejected('regular file') },
      { cli: ['auth', 'import', '<home>/missing.json'], stdin: '', check: rejected('Cannot read') },
      { file: 'cookies.json', text: oversized },
      { cli: ['auth', 'import', target], stdin: '', check: rejected('4 MiB limit') },
      { cli: ['auth', 'import', '-'], stdin: oversized, check: rejected('4 MiB limit') },
      {
        cli: ['auth', 'import', '-'],
        stdin: 'é'.repeat(2 * 1024 * 1024 + 1),
        check: rejected('4 MiB limit'),
      },
    ],
    after: (requests) => assert.deepEqual(requests, []),
  };
}

/** An import the drop-in expected to save and verify. */
const accepted = (ran: CliRun) => {
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stderr, '');
  assert.ok(ran.stdout.includes('saved and verified'), ran.stdout);
};

/** A store holding the access cookie the verification set. */
const verified = (store: Stored) =>
  assert.ok(JSON.stringify(store).includes('"name":"id_token","value":"offline-access"'));

/** integration.test.ts:165: auth import accepts private browser exports at the byte limit. */
async function importAcceptsPrivateExports(): Promise<Case> {
  const { expires, ...browserCookie } = COOKIE;

  const browserExport = JSON.stringify({
    cookies: [
      { ...browserCookie, expirationDate: expires },
      { name: '_analytics', value: 'é' },
    ],
    origins: [],
  });

  const atLimit =
    browserExport + ' '.repeat(4 * 1024 * 1024 - Buffer.byteLength(timed(browserExport)));

  const secrets = {
    secrets: ['private-refresh', 'offline-access', '_analytics'],
    under: ['.config', '.local'],
  };

  return {
    name: 'import-accepts-private-exports',
    env: SESSION,
    answer: async (url, init) => {
      if (url === 'https://www.abler.io/oauth/token') {
        if (
          new Headers(init.headers).get('cookie')?.includes('refreshToken=private-refresh') !== true
        )
          throw new Error('Missing imported credential');

        return Response.json(
          { access_token: 'offline-access' },
          { headers: { 'Set-Cookie': 'id_token=offline-access; Path=/; Max-Age=600' } },
        );
      }

      if (
        url === 'https://www.abler.io/graphql' &&
        (await requestBody(init)).operationName === 'SessionStatus'
      )
        return Response.json({ data: { me: { id: 'offline-parent', displayName: 'Parent' } } });

      throw new Error('UNEXPECTED_FETCH');
    },
    steps: [
      { file: 'cookies.json', text: atLimit },
      { cli: ['auth', 'import', '<home>/cookies.json'], stdin: atLimit, check: accepted },
      { snapshot: true, check: verified },
      secrets,
      { cli: ['auth', 'import', '-'], stdin: atLimit, check: accepted },
      { snapshot: true, check: verified },
      secrets,
    ],
  };
}

/** integration.test.ts:232: a malformed cookie domain is a fixed error and changes nothing. */
async function malformedCookieDomains(): Promise<Case> {
  const text = await session([COOKIE, { ...COOKIE, name: 'id_token' }]);
  const check = refused(/^Abler returned an invalid authentication cookie\.$/);

  return {
    name: 'malformed-cookie-domains',
    env: SESSION,
    answer: () =>
      Response.json(
        {},
        {
          headers: {
            'Set-Cookie': 'id_token=offline; Domain=private-domain-marker.example; Path=/',
          },
        },
      ),
    steps: [
      { file: 'session.json', text },
      { serve: ['auth_status', {}], check },
      { snapshot: true },
      { serve: ['auth_status', {}], env: { ABLER_TEST_FORCE_REFRESH: '1' }, check },
      { snapshot: true },
    ],
    after: (requests) =>
      assert.deepEqual(
        requests.map((exchange) => exchange.request.path),
        ['/graphql', '/oauth/token'],
      ),
  };
}

/** integration.test.ts:269: the CLI's safe diagnostics, and no unreviewed text. */
async function cliSafeDiagnostics(): Promise<Case> {
  let answer: CaseAnswer = offline;

  const fails = (expected: string) => (ran: CliRun) => {
    rejected(expected, true)(ran);
    assert.ok(!ran.stderr.includes(MARKER));
  };

  return {
    name: 'cli-safe-diagnostics',
    env: SESSION,
    answer: (url, init) => answer(url, init),
    steps: [
      { file: 'session.json', text: await session([COOKIE, { ...COOKIE, name: 'id_token' }]) },
      {
        set: () =>
          (answer = () =>
            Response.json(
              {},
              { headers: { 'Set-Cookie': `id_token=offline; Domain=${MARKER}.example; Path=/` } },
            )),
      },
      {
        cli: ['auth', 'status'],
        stdin: '',
        check: fails('Abler returned an invalid authentication cookie.'),
      },
      {
        set: () =>
          (answer = () => Response.json({ data: { me: { id: MARKER, displayName: null } } })),
      },
      { cli: ['auth', 'status'], stdin: '', check: fails('Abler MCP failed.') },
      { set: () => (answer = offline) },
      // rust-abler.ts: a standard input that throws before it yields is one the binary cannot
      // read, a folder; the drop-in's three throws are that one behaviour.
      { cli: ['auth', 'import', '-'], stdinFolder: true, check: fails('Abler MCP failed.') },
      {
        cli: ['auth', 'import', '-'],
        stdin: `${'\u0000'.repeat(4 * 1024 * 1024)}x`,
        check: fails('Cookie JSON input exceeds the 4 MiB limit.'),
      },
      {
        cli: ['auth', 'import'],
        stdin: '',
        check: fails('Provide a cookie JSON file, or - for stdin.'),
      },
      {
        cli: ['auth', 'import', '-'],
        stdin: MARKER,
        check: fails(
          'Import failed: provide valid browser cookie JSON containing an unexpired Abler refreshToken.',
        ),
      },
      {
        cli: ['auth', 'login', '--timeout', '0'],
        stdin: '',
        check: fails('Provide a positive whole number for --timeout.'),
      },
      {
        cli: ['auth', 'status', '--timeout', '1'],
        stdin: '',
        check: fails(
          'The browser, timeout, and keep-browser options are only valid with auth login.',
        ),
      },
      {
        cli: ['unknown'],
        stdin: '',
        check: fails('Invalid command. Run abler-mcp --help for usage.'),
      },
      {
        cli: [`--${MARKER}`],
        stdin: '',
        check: fails('Invalid command-line options. Run abler-mcp --help for usage.'),
      },
      {
        cli: ['auth', 'capture', MARKER],
        stdin: '',
        check: fails('Use a loopback Chrome debugging URL, such as http://127.0.0.1:9222.'),
      },
      { cli: ['auth', 'capture'], stdin: '', check: fails('Cannot connect to Chrome debugging.') },
      { set: () => (answer = () => new Response(MARKER)) },
      { cli: ['auth', 'capture'], stdin: '', check: fails('Invalid Chrome debugging response.') },
      { set: () => (answer = offline) },
      {
        cli: ['auth', 'login', '--browser', '<home>/missing-browser'],
        stdin: '',
        check: fails(
          "No Chromium-family browser found. Install Chrome, Chromium, Brave, or Edge, or set ABLER_BROWSER/--browser to its executable. Use 'abler-mcp auth capture <URL>' or 'abler-mcp auth import <file>'.",
        ),
      },
    ],
  };
}

/** integration.test.ts:523: a response is read to 4 MiB, then cancelled. */
async function fourMibResponseCap(): Promise<Case> {
  return {
    name: 'four-mib-response-cap',
    env: SESSION,
    answer: () => new Endless(1024 * 1024),
    steps: [
      {
        file: 'session.json',
        text: await session([COOKIE, { ...COOKIE, name: 'id_token', value: 'private-access' }]),
      },
      { serve: ['auth_status', {}], check: refused(/Abler returned an invalid API response/) },
    ],
    after: () => {
      assert.ok(lastEndless !== undefined && lastEndless.chunks >= 5, String(lastEndless?.chunks));
      assert.equal(lastEndless.cancelled, true);
    },
  };
}

/** integration.test.ts:567: groups and event, and the auth CLI paths that stay local. */
async function groupsAndEvent(): Promise<Case> {
  const missing = { ABLER_SESSION_FILE: '<home>/missing.json' };

  return {
    name: 'groups-and-event',
    env: SESSION,
    answer: async (_url, init) => {
      if ((await requestBody(init)).operationName === 'Groups')
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
            edges: [{ node: { ...eventBase, eventId: 'event-a', unknown: 'removed' } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    },
    steps: [
      {
        file: 'session.json',
        text: await session([COOKIE, { ...COOKIE, name: 'id_token', value: 'private-access' }]),
      },
      {
        serve: ['list_groups', {}],
        check: gave({
          groups: [
            {
              id: 'age-group',
              name: 'U12',
              isActive: true,
              sport: { id: 'sport', name: 'Football' },
              groups: [{ id: 'subgroup', name: 'Blue', label: 'B' }],
            },
          ],
        }),
      },
      {
        serve: ['get_event', { eventId: 'event-a', ageGroupId: 'age-group' }],
        check: gave({ ...eventBase, eventId: 'event-a' }),
      },
      { cli: ['auth', 'status'], env: missing, check: rejected('No saved Abler session') },
      {
        cli: ['auth', 'logout'],
        env: missing,
        check: (ran: CliRun) => {
          assert.equal(ran.code, 0);
          assert.match(ran.stdout, /failed-import candidates removed/);
        },
      },
      {
        cli: ['--help'],
        env: missing,
        check: (ran: CliRun) => {
          assert.equal(ran.code, 0);
          assert.match(ran.stdout, /saved session and failed-import candidates/);
        },
      },
      {
        cli: ['auth', 'capture', 'https://example.com'],
        env: missing,
        check: rejected('loopback'),
      },
    ],
  };
}

/** integration.test.ts:669: conversations and messages, their fixed variables and their checks. */
async function conversationsAndMessages(): Promise<Case> {
  let body = '{}';

  const respond = (page: Json) => () => {
    body = JSON.stringify({ data: page });
  };

  const fullMessage = {
    id: 'message-a',
    messageBody: 'Synthetic practice note',
    createdAt: '2026-09-11T16:00:00.000Z',
    creator: { id: 'coach', displayName: 'Coach', unknown: 'removed' },
    attachments: [
      {
        id: 'file-a',
        fileName: 'plan.pdf',
        description: 'Synthetic plan',
        contentType: 'application/pdf',
        path: 'removed',
      },
      { id: 'file-b', fileName: 'map.png', description: null, contentType: 'image/png' },
    ],
    recipient: { isRead: false, unknown: 'removed' },
    unknown: 'removed',
  };

  const sparseMessage = {
    id: 'message-b',
    messageBody: null,
    createdAt: '2026-09-10T08:30:00.000Z',
    creator: null,
    attachments: [],
    recipient: { isRead: null },
  };

  const expectedFull = {
    id: 'message-a',
    body: 'Synthetic practice note',
    createdAt: '2026-09-11T16:00:00.000Z',
    sender: { id: 'coach', displayName: 'Coach' },
    read: false,
    attachments: [
      {
        id: 'file-a',
        fileName: 'plan.pdf',
        description: 'Synthetic plan',
        contentType: 'application/pdf',
      },
      { id: 'file-b', fileName: 'map.png', description: null, contentType: 'image/png' },
    ],
  };

  const expectedSparse = {
    id: 'message-b',
    body: null,
    createdAt: '2026-09-10T08:30:00.000Z',
    sender: null,
    read: null,
    attachments: [],
  };

  const conversationPage = {
    getMessageUnreadCount: 3,
    message: {
      edges: [
        {
          node: {
            id: 'conversation-a',
            name: 'Team chat',
            conversationType: 'GROUP_CHAT',
            membersCount: 12,
            unreadCount: 2,
            messageGroup: { id: 'message-group', name: 'U12', unknown: 'removed' },
            user1: { id: 'coach', displayName: 'Coach', unknown: 'removed' },
            user2: { id: 'parent', displayName: 'Parent' },
            messages: { edges: [{ node: fullMessage }] },
            lastMessage: 'removed',
            unknown: 'removed',
          },
        },
        {
          node: {
            id: 'conversation-b',
            name: null,
            conversationType: 'CHAT',
            membersCount: null,
            unreadCount: 0,
            messageGroup: null,
            user1: { id: 'parent', displayName: 'Parent' },
            user2: null,
            messages: { edges: [{ node: sparseMessage }] },
          },
        },
        {
          node: {
            id: 'conversation-c',
            conversationType: 'FUTURE_TYPE',
            unreadCount: 1,
            user1: null,
            messages: { edges: [] },
          },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'cursor-b' },
    },
  };

  const incomplete = { edges: [], pageInfo: { hasNextPage: true, endCursor: null } };
  const incompleteCursor = refused(/Invalid input or unexpected upstream data/);
  const stalled = refused(/did not advance/);

  return {
    name: 'conversations-and-messages',
    env: SESSION,
    answer: () => new Response(body),
    steps: [
      {
        file: 'session.json',
        text: await session([COOKIE, { ...COOKIE, name: 'id_token', value: 'private-access' }]),
      },
      { set: respond(conversationPage) },
      {
        serve: ['list_conversations', { first: 5, after: 'cursor-a' }],
        check: gave({
          unreadCount: 3,
          conversations: [
            {
              id: 'conversation-a',
              name: 'Team chat',
              type: 'GROUP_CHAT',
              membersCount: 12,
              unreadCount: 2,
              group: { id: 'message-group', name: 'U12' },
              participants: [
                { id: 'coach', displayName: 'Coach' },
                { id: 'parent', displayName: 'Parent' },
              ],
              latestMessage: expectedFull,
            },
            {
              id: 'conversation-b',
              name: null,
              type: 'CHAT',
              membersCount: null,
              unreadCount: 0,
              group: null,
              participants: [{ id: 'parent', displayName: 'Parent' }],
              latestMessage: expectedSparse,
            },
            {
              id: 'conversation-c',
              name: null,
              type: 'FUTURE_TYPE',
              membersCount: null,
              unreadCount: 1,
              group: null,
              participants: [],
              latestMessage: null,
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-b' },
        }),
      },
      { serve: ['list_conversations', {}], check: gave() },
      // A missing total is unavailable data, not zero unread messages.
      { set: respond({ ...conversationPage, getMessageUnreadCount: null }) },
      { serve: ['list_conversations', {}], check: refused() },
      {
        set: respond({
          conversationMessages: {
            edges: [{ node: fullMessage }, { node: { ...sparseMessage, recipient: null } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      },
      {
        serve: ['list_messages', { conversationId: 'conversation-a', first: 2 }],
        check: gave({
          messages: [expectedFull, expectedSparse],
          pageInfo: { hasNextPage: false, endCursor: null },
        }),
      },
      {
        serve: ['list_messages', { conversationId: 'conversation-a', after: 'cursor-a' }],
        check: gave(),
      },
      {
        set: respond({
          getMessageUnreadCount: 0,
          message: incomplete,
          conversationMessages: incomplete,
        }),
      },
      { serve: ['list_conversations', {}], check: incompleteCursor },
      { serve: ['list_messages', { conversationId: 'conversation-a' }], check: incompleteCursor },
      {
        set: respond({
          getMessageUnreadCount: 0,
          message: {
            edges: [{ node: { id: 'conversation-a', conversationType: 'CHAT', unreadCount: 0 } }],
            pageInfo: { hasNextPage: true, endCursor: 'same' },
          },
          conversationMessages: {
            edges: [{ node: sparseMessage }],
            pageInfo: { hasNextPage: true, endCursor: 'same' },
          },
        }),
      },
      { serve: ['list_conversations', { after: 'same' }], check: stalled },
      {
        serve: ['list_messages', { conversationId: 'conversation-a', after: 'same' }],
        check: stalled,
      },
      { serve: ['list_conversations', { first: 0 }], check: refused() },
      { serve: ['list_conversations', { first: 51 }], check: refused() },
      {
        serve: ['list_messages', { conversationId: 'conversation-a', first: 0 }],
        check: refused(),
      },
      {
        serve: ['list_messages', { conversationId: 'conversation-a', first: 51 }],
        check: refused(),
      },
      { serve: ['list_messages', { conversationId: '' }], check: refused() },
      { serve: ['list_conversations', { conversationId: 'conversation-a' }], check: refused() },
      {
        serve: ['list_messages', { conversationId: 'conversation-a', cursor: 'x' }],
        check: refused(),
      },
    ],
    after: (requests) => {
      const sent = requests.map((exchange) =>
        graphqlRequest.parse(JSON.parse(exchange.request.body)),
      );

      assert.deepEqual(
        sent.map(({ operationName, variables }) => [operationName, variables]),
        [
          ['Conversations', { first: 5, cursor: 'cursor-a' }],
          ['Conversations', { first: 20, cursor: null }],
          ['Conversations', { first: 20, cursor: null }],
          [
            'ConversationMessages',
            { pagination: { first: 2, after: null }, conversationIds: ['conversation-a'] },
          ],
          [
            'ConversationMessages',
            { pagination: { first: 20, after: 'cursor-a' }, conversationIds: ['conversation-a'] },
          ],
          ['Conversations', { first: 20, cursor: null }],
          [
            'ConversationMessages',
            { pagination: { first: 20, after: null }, conversationIds: ['conversation-a'] },
          ],
          ['Conversations', { first: 20, cursor: 'same' }],
          [
            'ConversationMessages',
            { pagination: { first: 20, after: 'same' }, conversationIds: ['conversation-a'] },
          ],
        ],
      );

      // Neither document asks for attachment URLs, pictures, members, or the null preview field.
      for (const { query } of sent)
        assert.doesNotMatch(query, /\b(?:path|picture|initials|members|lastMessage)\b/);
    },
  };
}

/** integration.test.ts:929: all eight tools round trip over one server, null fields kept. */
async function toolRoundTrips(): Promise<Case> {
  const children = [
    { id: 'child-a', displayName: 'Alex' },
    { id: 'child-b', displayName: 'Jamie' },
  ];

  const roundTripEvent = {
    eventId: 'event-a',
    name: 'Practice',
    description: null,
    from: '2026-09-11T16:00:00Z',
    to: null,
    arrivalTime: 15, // Abler sends minutes before start as a number
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

  const roundTripNode = {
    id: 'message-a',
    messageBody: 'Synthetic practice note',
    createdAt: '2026-09-11T16:00:00.000Z',
    creator: { id: 'coach', displayName: 'Coach' },
    attachments: [
      { id: 'file-a', fileName: 'plan.pdf', description: null, contentType: 'application/pdf' },
    ],
    recipient: { isRead: null },
  };

  const page = { hasNextPage: false, endCursor: null };

  const answers = new Map(
    Object.entries({
      SessionStatus: { me: { id: 'parent', displayName: 'Parent' } },
      Profile: { me: { id: 'parent', displayName: 'Parent', children } },
      Groups: {
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
      Schedule: { schedule: { edges: [{ node: roundTripEvent }], pageInfo: page } },
      Event: { event: { edges: [{ node: roundTripEvent }], pageInfo: page } },
      Conversations: {
        getMessageUnreadCount: 1,
        message: {
          edges: [
            {
              node: {
                id: 'conversation-a',
                name: null,
                conversationType: 'CHAT',
                membersCount: 2,
                unreadCount: 1,
                messageGroup: null,
                user1: { id: 'parent', displayName: 'Parent' },
                user2: null,
                messages: { edges: [{ node: roundTripNode }] },
              },
            },
          ],
          pageInfo: page,
        },
      },
      ConversationMessages: {
        conversationMessages: { edges: [{ node: roundTripNode }], pageInfo: page },
      },
    }),
  );

  const roundTripMessage = {
    id: 'message-a',
    body: 'Synthetic practice note',
    createdAt: '2026-09-11T16:00:00.000Z',
    sender: { id: 'coach', displayName: 'Coach' },
    read: null,
    attachments: [
      { id: 'file-a', fileName: 'plan.pdf', description: null, contentType: 'application/pdf' },
    ],
  };

  const nulls = (read: (value: Json) => boolean) => (got: Outcome) => {
    gave()(got);
    assert.ok(got.ok && read(got.value), JSON.stringify(got));
  };

  const schedule = z.object({ events: z.array(z.object({ description: z.null(), to: z.null() })) });
  const groups = z.object({ groups: z.array(z.object({ sport: z.null() })) });

  return {
    name: 'tool-round-trips',
    env: SESSION,
    answer: async (_url, init) => {
      const found = answers.get((await requestBody(init)).operationName);

      if (found === undefined) throw new Error('Unexpected Abler operation.');

      return Response.json({ data: found });
    },
    steps: [
      {
        file: 'session.json',
        text: await session([COOKIE, { ...COOKIE, name: 'id_token', value: 'private-access' }]),
      },
      { open: true },
      { call: ['auth_status', {}], check: gave() },
      { call: ['get_profile', {}], check: gave() },
      {
        call: ['list_groups', {}],
        check: nulls((value) => groups.parse(value).groups[0]?.sport === null),
      },
      {
        call: ['list_schedule', {}],
        check: nulls((value) => schedule.parse(value).events.length === 1),
      },
      { call: ['list_child_schedules', {}], check: gave() },
      { call: ['get_event', { eventId: 'event-a', ageGroupId: 'age-group' }], check: gave() },
      {
        call: ['list_conversations', {}],
        check: gave({
          unreadCount: 1,
          conversations: [
            {
              id: 'conversation-a',
              name: null,
              type: 'CHAT',
              membersCount: 2,
              unreadCount: 1,
              group: null,
              participants: [{ id: 'parent', displayName: 'Parent' }],
              latestMessage: roundTripMessage,
            },
          ],
          pageInfo: page,
        }),
      },
      {
        call: ['list_messages', { conversationId: 'conversation-a' }],
        check: gave({ messages: [roundTripMessage], pageInfo: page }),
      },
      { close: true },
    ],
  };
}

/** integration.test.ts:1136: the bare executable serves read tools and reports missing auth. */
async function stdioReadToolsAndMissingAuth(): Promise<Case> {
  const notMissingAuth = (got: Outcome) => {
    refused()(got);
    assert.ok(!got.ok && !got.text.includes('No saved Abler session'), JSON.stringify(got));
  };

  const listed = z.object({
    result: z.object({
      tools: z.array(
        z.looseObject({
          name: z.string(),
          outputSchema: z.looseObject({}),
          annotations: z.looseObject({ readOnlyHint: z.literal(true) }),
        }),
      ),
    }),
  });

  return {
    name: 'stdio-read-tools-and-missing-auth',
    env: { ABLER_SESSION_FILE: '<home>/missing.json' },
    answer: offline,
    steps: [
      {
        open: true,
        args: [],
        list: true,
        check: (list: string) =>
          assert.deepEqual(
            listed
              .parse(JSON.parse(list))
              .result.tools.map((tool) => tool.name)
              .toSorted(),
            [
              'auth_status',
              'get_event',
              'get_profile',
              'list_child_schedules',
              'list_conversations',
              'list_groups',
              'list_messages',
              'list_schedule',
            ],
          ),
      },
      { call: ['auth_status', {}], check: refused(/No saved Abler session/) },
      { call: ['list_child_schedules', { childId: 'only-this-child' }], check: refused() },
      { call: ['list_schedule', { first: 0 }], check: refused() },
      { call: ['list_conversations', { first: 0 }], check: notMissingAuth },
      { call: ['list_conversations', { first: 51 }], check: notMissingAuth },
      { call: ['list_conversations', { conversationId: 'conversation-a' }], check: notMissingAuth },
      { call: ['list_messages', {}], check: notMissingAuth },
      { call: ['list_messages', { conversationId: '' }], check: notMissingAuth },
      {
        call: ['list_messages', { conversationId: 'conversation-a', first: 51 }],
        check: notMissingAuth,
      },
      {
        call: ['list_messages', { conversationId: 'conversation-a', markRead: true }],
        check: notMissingAuth,
      },
      { close: true },
    ],
    after: (requests) => assert.deepEqual(requests, []),
  };
}

/** integration.test.ts:1265: child schedules by sibling ID, empty children, own pagination. */
async function childSchedules(): Promise<Case> {
  const linkedChildren = [
    { id: 'child-a', displayName: 'Alex' },
    { id: 'child-b', displayName: 'Alex' },
    { id: 'child-c', displayName: 'Jamie' },
  ];

  let noChildren = false;

  const scheduleRequest = z.object({
    operationName: z.literal('Schedule'),
    variables: z.object({
      first: z.literal(1),
      cursor: z.string().nullable(),
      filter: z.looseObject({ participant: z.tuple([z.string()]) }),
    }),
  });

  const children = z.object({
    children: z.array(
      z.object({
        child: z.object({ id: z.string(), displayName: z.string() }),
        events: z.array(
          z.looseObject({
            eventId: z.string(),
            attendance: z.array(
              z.looseObject({ status: z.string(), coachStatus: z.string().nullable() }),
            ),
          }),
        ),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    ),
  });

  return {
    name: 'child-schedules',
    env: SESSION,
    answer: async (_url, init) => {
      const body = await requestBody(init);

      if (body.operationName === 'Profile')
        return Response.json({
          data: {
            me: { id: 'parent', displayName: 'Parent', children: noChildren ? [] : linkedChildren },
          },
        });

      const { variables } = scheduleRequest.parse(body);
      const [child] = variables.filter.participant;
      const { cursor } = variables;

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
                        eventId: cursor === null ? 'shared-event' : 'next-event',
                        currentPlayerAttendance: [
                          { player: linkedChildren[0], status: 'G', coachStatus: 'P' },
                          { player: linkedChildren[1], status: 'N', coachStatus: null },
                        ],
                      },
                    },
                  ],
            pageInfo: {
              hasNextPage: child === 'child-a' && cursor === null,
              endCursor: child === 'child-a' ? 'a-next' : null,
            },
          },
        },
      });
    },
    steps: [
      { file: 'session.json', text: await session([COOKIE, { ...COOKIE, name: 'id_token' }]) },
      {
        serve: ['get_profile', {}],
        check: (got: Outcome) => {
          gave()(got);
          assert.deepEqual(
            got.ok && z.looseObject({ childNamesById: jsonValue }).parse(got.value).childNamesById,
            { 'child-a': 'Alex', 'child-b': 'Alex', 'child-c': 'Jamie' },
          );
        },
      },
      {
        serve: ['list_child_schedules', { first: 1 }],
        check: (got: Outcome) => {
          gave()(got);
          const result = children.parse(got.ok ? got.value : null).children;
          assert.deepEqual(
            result.map((item) => item.child),
            linkedChildren,
          );
          assert.equal(result[0]?.events[0]?.eventId, 'shared-event');
          assert.deepEqual(
            result[0].events[0].attendance.map(({ status, coachStatus }) => [status, coachStatus]),
            [['G', 'P']],
          );
          assert.equal(result[1]?.events[0]?.eventId, 'shared-event');
          assert.deepEqual(
            result[1].events[0].attendance.map(({ status, coachStatus }) => [status, coachStatus]),
            [['N', null]],
          );
          assert.deepEqual(result[2], {
            child: linkedChildren[2],
            events: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          });
          assert.deepEqual(
            result.map((item) => item.pageInfo.hasNextPage),
            [true, false, false],
          );
        },
      },
      {
        serve: [
          'list_child_schedules',
          { childIds: ['child-a'], first: 1, afterByChild: { 'child-a': 'a-next' } },
        ],
        check: (got: Outcome) => {
          const result = children.parse(got.ok ? got.value : null).children;
          assert.equal(result.length, 1);
          assert.equal(result[0]?.events[0]?.eventId, 'next-event');
        },
      },
      {
        serve: ['list_child_schedules', { childIds: ['unlinked'] }],
        check: refused(/Unknown child/),
      },
      {
        serve: [
          'list_child_schedules',
          { childIds: ['child-a'], afterByChild: { 'child-b': 'b-next' } },
        ],
        check: refused(/unselected child/),
      },
      {
        serve: ['list_child_schedules', { from: '2026-09-30', to: '2026-09-11' }],
        check: refused(),
      },
      { serve: ['list_child_schedules', { childId: 'child-a' }], check: refused() },
      { serve: ['list_child_schedules', { participantIds: ['child-a'] }], check: refused() },
      { set: () => (noChildren = true) },
      { serve: ['list_child_schedules', {}], check: gave({ children: [] }) },
    ],
    after: (requests) =>
      assert.deepEqual(
        requests
          .map((exchange) =>
            z
              .looseObject({ operationName: z.string(), variables: jsonValue })
              .parse(JSON.parse(exchange.request.body)),
          )
          .filter((body) => body.operationName === 'Schedule')
          .map((body) => scheduleRequest.parse(body).variables)
          .map(({ cursor, filter }) => ({ child: filter.participant[0], cursor })),
        [
          { child: 'child-a', cursor: null },
          { child: 'child-b', cursor: null },
          { child: 'child-c', cursor: null },
          { child: 'child-a', cursor: 'a-next' },
        ],
      ),
  };
}

/** integration.test.ts:1503: unsafe session files, malformed pages, stalled cursors, wrong events. */
async function explicitFailures(): Promise<Case> {
  type Page = {
    edges: { node: Record<string, Json> }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };

  let page: Page = { edges: [], pageInfo: { hasNextPage: true, endCursor: null } };

  const pages = (next: Page) => () => {
    page = next;
  };

  return {
    name: 'explicit-failures',
    env: SESSION,
    answer: () => Response.json({ data: { schedule: page, event: page } }),
    steps: [
      { file: 'session.json', text: await session([COOKIE, { ...COOKIE, name: 'id_token' }]) },
      { chmod: 'session.json', permissions: 0o644 },
      { serve: ['auth_status', {}], check: refused(/owner-only/) },
      { chmod: 'session.json', permissions: 0o600 },
      { symlink: 'link.json', target: '<home>/session.json' },
      {
        serve: ['auth_status', {}],
        env: { ABLER_SESSION_FILE: '<home>/link.json' },
        check: refused(/symlink/),
      },
      // A symbolic link's own mode differs between macOS and Linux; it is not left in the home.
      { remove: 'link.json' },
      { serve: ['list_schedule', {}], check: refused() },
      { set: pages({ edges: [{ node: {} }], pageInfo: { hasNextPage: false, endCursor: null } }) },
      { serve: ['list_schedule', {}], check: refused() },
      {
        set: pages({
          edges: [{ node: { ...eventBase, eventId: 'event-a' } }],
          pageInfo: { hasNextPage: true, endCursor: 'same' },
        }),
      },
      { serve: ['list_schedule', { after: 'same' }], check: refused(/did not advance/) },
      {
        serve: ['get_event', { eventId: 'event-b', ageGroupId: 'age-group' }],
        check: refused(/different event/),
      },
    ],
  };
}

const CASES = [
  importRefusals,
  importAcceptsPrivateExports,
  malformedCookieDomains,
  cliSafeDiagnostics,
  fourMibResponseCap,
  groupsAndEvent,
  conversationsAndMessages,
  toolRoundTrips,
  stdioReadToolsAndMissingAuth,
  childSchedules,
  explicitFailures,
];

/** `<home>` in an argument, link target or environment value, as the case's home. */
function placed(home: string, text: string): string {
  return text.replaceAll('<home>', home);
}

/** A file's text under `home`'s `under` folders that holds one of `values`. */
function secretsUnder(home: string, values: string[], under: string[]): string[] {
  return under
    .flatMap((folder) =>
      existsSync(join(home, folder))
        ? readdirSync(join(home, folder), { recursive: true, withFileTypes: true })
        : [],
    )
    .flatMap((entry) => {
      const path = join(entry.parentPath, entry.name);

      return entry.isFile() && values.some((value) => readFileSync(path).includes(value))
        ? [relative(home, path)]
        : [];
    });
}

async function runCase(test: Case) {
  const home = join(scratch, test.name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(`${home}.tmp`, { recursive: true, mode: 0o700 });
  const names = new Names(home, Date.now());
  answerCase = test.answer;
  lastEndless = undefined;
  const start = exchanges.length;
  const steps: object[] = [];
  let mcp: Server | undefined;

  const env = (extra: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries({ ...test.env, ...extra }).map(([key, value]) => [key, placed(home, value)]),
    );

  for (const step of test.steps) {
    if ('set' in step) step.set();
    else if ('file' in step) {
      const path = join(home, step.file);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, timed(step.text), { mode: step.permissions ?? 0o600 });
      chmodSync(path, step.permissions ?? 0o600);
      steps.push(step);
    } else if ('chmod' in step) {
      chmodSync(join(home, step.chmod), step.permissions);
      steps.push(step);
    } else if ('symlink' in step) {
      symlinkSync(placed(home, step.target), join(home, step.symlink));
      steps.push(step);
    } else if ('link' in step) {
      linkSync(join(home, step.target), join(home, step.link));
      steps.push(step);
    } else if ('remove' in step) {
      rmSync(join(home, step.remove));
      steps.push(step);
    } else if ('cli' in step) {
      const ran = await runCli(
        home,
        names,
        env(step.env),
        step,
        step.cli.map((arg) => placed(home, arg)),
      );

      step.check?.(ran);
      steps.push(ran);
    } else if ('serve' in step) {
      const served = await runServe(home, names, env(step.env), { serve: [step.serve] });
      step.check?.(outcome(served.results[0]?.answer ?? ''));
      steps.push(Object.assign(served, step.env ? { env: step.env } : undefined));
    } else if ('open' in step) {
      mcp = new Server(home, env(), step.args ?? ['serve']);
      const initialize = await mcp.initialize();
      const list = step.list === true ? (await mcp.request('tools/list', {})).answer : undefined;
      leaks(home, initialize + (list ?? ''));

      if (list !== undefined) step.check?.(list);
      steps.push(
        Object.assign(
          { open: true },
          step.args ? { args: step.args } : undefined,
          { initialize: names.fresh(initialize) },
          list === undefined ? undefined : { list: names.fresh(list) },
        ),
      );
    } else if ('call' in step) {
      if (mcp === undefined) throw new RangeError(`${test.name}: a call before open.`);
      const [name, args] = step.call;
      const at = exchanges.length;

      const { notifications, answer } = await mcp.request('tools/call', {
        name,
        arguments: toolArguments.parse(args),
      });

      leaks(home, answer + notifications.join(''));
      const { result } = toolAnswer.parse(JSON.parse(answer));

      if (result?.content !== undefined) coverage.tools += 1;

      if (result?.structuredContent !== undefined) coverage.structured += 1;
      step.check?.(outcome(answer));
      steps.push(
        Object.assign(
          { call: step.call },
          notifications.length
            ? {
                notifications: notifications.map((line) =>
                  jsonValue.parse(JSON.parse(names.fresh(line))),
                ),
              }
            : undefined,
          { answer: names.fresh(answer), exchanges: exchanges.slice(at) },
        ),
      );
    } else if ('close' in step) {
      if (mcp === undefined) throw new RangeError(`${test.name}: a close before open.`);
      const { code, stderr } = await mcp.close();
      leaks(home, stderr);
      mcp = undefined;
      steps.push({ close: true, code, stderr: names.fresh(stderr) });
    } else if ('snapshot' in step) {
      const store = await stored(home, names);
      step.check?.(store);
      steps.push({ snapshot: { files: files(home, names), texts: texts(home, names), ...store } });
    } else {
      assert.deepEqual(
        secretsUnder(home, step.secrets, step.under),
        [],
        `${test.name}: a secret at rest`,
      );
      steps.push(step);
    }
  }

  if (mcp !== undefined) throw new RangeError(`${test.name}: a server left open.`);
  const requests = exchanges.slice(start);
  test.after?.(requests);

  return Object.assign(
    { steps, id: `abler/${set}/${test.name}`, env: test.env },
    { requests: requests.length, files: files(home, names), texts: texts(home, names) },
    await stored(home, names),
  );
}

/**
 * Long runs of one character inside JSON strings become `\u0001<character>*<count>\u0001`; the
 * replay expands them. No frozen value holds a U+0001.
 */
function pack(text: string): string {
  if (text.includes('\\u0001')) throw new RangeError('A frozen value holds a U+0001.');

  return text
    .replaceAll(
      /(?<!\\)([^\\"])\1{1023,}/g,
      (sequence: string, unit: string) => `\\u0001${unit}*${sequence.length}\\u0001`,
    )
    .replaceAll(
      // A control character's escape, such as the contract set's 4 MiB of `\u0000`.
      /(?<!\\)(\\u00[01][0-9a-f])\1{1023,}/g,
      (sequence: string, unit: string) => `\\u0001${unit}*${sequence.length / 6}\\u0001`,
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

  if (set === 'parity')
    for (const scenario of scenarios) {
      if (only !== undefined && scenario.name !== only) continue;
      const frozen = await run(scenario);
      coverage.requests += frozen.requests;
      writeFileSync(join(output, `${scenario.name}.json`), pack(layout(frozen)));
    }
  else
    for (const make of CASES) {
      const test = await make();

      if (only !== undefined && test.name !== only) continue;
      const frozen = await runCase(test);
      coverage.requests += frozen.requests;
      writeFileSync(join(output, `${test.name}.json`), pack(layout(frozen)));
    }
} finally {
  await server.stop(true);
  caseServer.closeAllConnections();
  caseServer.close();
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`frozen ${set}: ${JSON.stringify(coverage)}\n`);
