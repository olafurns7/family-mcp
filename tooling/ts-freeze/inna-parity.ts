// Freezes what the TypeScript Inna CLI and server do in every case of
// rust/inna-mcp/tests/ts/parity.ts, for rust/inna-mcp/tests/replay.rs. Run once from the
// repository root with Bun 1.4.2 at the commit named in the provenance:
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 FAMILY_MCP_STORE_TEST_SEAM=1 \
//     bun tooling/ts-freeze/inna-parity.ts rust/inna-mcp/tests/fixtures/parity
//
// parity.ts ran each scenario once against the TypeScript CLI (rewrite.ts preloaded) and once
// against the binary, each in its own scratch home, against one fake Inna (fake-inna.ts) and one
// clock file. This runs the TypeScript side alone, every step of it: a `swap` step, which ran the
// binary in the TypeScript home, runs the TypeScript server here, and the home as it stood before
// that step is recorded byte for byte, so that the replay plants what the TypeScript side wrote and
// the binary continues from it. Between the fake and the CLI sits a recording proxy, which keeps
// each upstream exchange in order: the request (method, URL, the headers fake-inna.ts compares,
// body) and the response the fake served (status, headers, body). For a GET answered 401 it also
// asks a copy of the fake's state what the renewal and the one retry parity.ts let the binary send
// would be answered, without changing the fake. MCP traffic is raw newline-delimited JSON-RPC, and
// each answer is kept as the line the server wrote. The scenario tables are parity.ts's, copied
// between the markers below; the copied code changed only where this workspace's lint requires
// (marked `lint:`) and in layout (oxfmt), not in behaviour. Every value is synthetic. PR 3 deletes
// this script with the TypeScript sources.
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as z from 'zod/v4';

import { setSystemTime } from 'bun:test';

import {
  SessionStoreError,
  defaultKeyProvider,
  defaultSecretRecordPath,
  withSecretStore,
} from '../../packages/session-store/src/index.ts';
import {
  RECORD_MAX_BYTES,
  cookieExportSchema,
  sessionJar,
} from '../../packages/inna-mcp/src/client.ts';
import {
  COOKIES,
  fresh,
  startFake,
  type Planted,
  type Seen,
  type State,
} from '../../rust/inna-mcp/tests/ts/fake-inna.ts';

const [output, set = 'parity', only] = process.argv.slice(2);

if (output === undefined || !['parity', 'contract'].includes(set))
  throw new RangeError('Usage: inna-parity.ts OUTPUT_DIRECTORY [parity|contract] [CASE]');

if (existsSync(output) && readdirSync(output).length)
  throw new RangeError('The output directory must be empty or absent.');

if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');

const repo = resolve(import.meta.dir, '../..');

const cli = join(repo, 'packages/inna-mcp/src/cli.ts');

// Routes the package's fetch to the proxy and its `Date.now` to the clock file.
const rewrite = join(repo, 'rust/inna-mcp/tests/ts/rewrite.ts');

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ts-freeze-inna-'));

const clock = join(scratch, 'now');

const NOW = Date.parse('2040-01-02T12:00:00Z');

type Current = { state: State; seen: Seen[] };

let current: Current = { state: fresh(), seen: [] };

const fake = await startFake(() => current);

type Answer = { status: number; headers: Record<string, string | string[]>; body: string };

type Exchange = {
  request: { method: string; url: string; headers: Record<string, string | null>; body: string };
  response?: Answer;
  /** What the renewal parity.ts let the binary send after this 401, and its one retry, got. */
  recovery?: { renewal: Answer; retry?: Answer };
};

/** fake-inna.ts COMPARED_HEADERS: what each request carried that both sides must agree on. */
const COMPARED = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'origin',
  'referer',
  'x-requested-by',
  'x-xsrf-token',
];

/** Every exchange the proxy has seen, in the order the requests arrived. */
const exchanges: Exchange[] = [];

/** A request's body as UTF-8 text, a leading byte order mark kept; never lossy. */
async function bytesOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);

  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

/** The fake's answer to `method path`, without the transport's own headers. */
async function forward(
  method: string,
  path: string,
  headers: Headers,
  body: string,
): Promise<Answer> {
  const init: RequestInit = { method, headers, redirect: 'manual' };

  if (method !== 'GET' && method !== 'HEAD') init.body = body;

  const response = await fetch(`${fake.origin}${path}`, init);

  const kept: Record<string, string | string[]> = {};

  for (const [name, value] of response.headers)
    if (
      ![
        'set-cookie',
        'date',
        'connection',
        'keep-alive',
        'content-length',
        'transfer-encoding',
      ].includes(name)
    )
      kept[name] = value;

  const cookies = response.headers.getSetCookie();

  if (cookies.length) kept['set-cookie'] = cookies;

  return { status: response.status, headers: kept, body: await response.text() };
}

async function proxy(incoming: IncomingMessage, out: ServerResponse): Promise<void> {
  const path = incoming.url ?? '/';
  const [, host = '', ...rest] = path.split('/');
  const url = new URL(`https://${host}/${rest.join('/')}`).href;
  const method = incoming.method ?? '';
  const recorded: Record<string, string | null> = {};

  for (const name of COMPARED) recorded[name] = incoming.headers[name]?.toString() ?? null;

  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers))
    if (!['host', 'connection', 'content-length'].includes(name))
      for (const item of [value ?? []].flat()) headers.append(name, item);

  const body = await bytesOf(incoming);
  const exchange: Exchange = { request: { method, url, headers: recorded, body } };
  exchanges.push(exchange);
  const answer = await forward(method, path, headers, body);
  exchange.response = answer;

  if (method === 'GET' && answer.status === 401) {
    // A copy of the fake's state answers the renewal and the retry, so the TypeScript run sees no
    // change.
    const kept = current;
    current = { state: structuredClone(kept.state), seen: [] };

    try {
      const renewal = await forward(
        'GET',
        '/nam.inna.is/api/UserData/GetLoggedInUser',
        headers,
        '',
      );

      exchange.recovery =
        renewal.status === 200
          ? { renewal, retry: await forward(method, path, headers, body) }
          : { renewal };
    } finally {
      current = kept;
    }
  }

  try {
    out.writeHead(answer.status, answer.headers);
    out.end(answer.body);
  } catch {
    // The client has gone (a cancelled call); the exchange is recorded all the same.
  }
}

const proxyServer = createServer((incoming, out) => void proxy(incoming, out));

await new Promise<void>((done) => proxyServer.listen({ host: '127.0.0.1', port: 0 }, done));

const address = proxyServer.address();

if (!(address instanceof Object)) throw new RangeError('No proxy port.');

const origin = `http://127.0.0.1:${address.port}`;

// parity.ts's LEGACY session holds a cookie jar whose creation times are the wall clock's; at the
// scenario clock instead, the frozen legacy file is the same on every run.
setSystemTime(new Date(NOW));

// ---- parity.ts (41d6f98): steps, inputs and scenarios ----
type Step =
  // `absent`: text neither side may print in this step.
  | { cli: string[]; stdin?: string; absent?: string }
  // Each side's `auth import` of the synthetic cookie export.
  | { seed: true; args?: string[] }
  // An older version's plaintext session file at this path under the home.
  | { legacy: string }
  | { upstream: Partial<State> }
  | { clock: number }
  | { serve: [string, unknown][]; args?: string[]; surface?: boolean; swap?: boolean }
  // One call, cancelled once Inna has seen a request to `when`: by the host
  // (`notifications/cancelled`), by the end of the server's stdin, or by a signal to it. `writes`:
  // the absence writes Inna must have received by the end of the step.
  | {
      cancel: [string, unknown];
      by: 'host' | 'stdin' | 'SIGINT' | 'SIGTERM';
      when: string;
      writes: number;
      args?: string[];
    }
  | { file: string; text: string; permissions?: number }
  | { directory: string; permissions: number };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

const storeFile = '.config/inna-mcp/session.enc';

/** A saved session as an older version left it in plaintext, with the synthetic cookies. */
const LEGACY = JSON.stringify({
  version: 2,
  jar: JSON.stringify(
    await (await sessionJar(cookieExportSchema.parse(JSON.parse(COOKIES)))).serialize(),
  ),
  account: { userId: 1, studentId: '2', schoolId: '3' },
  students: {},
  pauseUntil: 0,
});

const cookieFile = (cookies: object[]) => JSON.stringify(cookies);

const range = { dateFrom: '2040-01-02', dateTo: '2040-01-09' };

/** Every read tool, with each argument that changes what it asks Inna. */
const READS: [string, unknown][] = [
  ['inna_session_status', {}],
  ['inna_list_students', {}],
  ['inna_get_overview', {}],
  ['inna_get_timetable', range],
  ['inna_get_assignments', {}],
  ['inna_get_assignments', { type: 'exams' }],
  ['inna_get_assignments', { type: 'assignments' }],
  ['inna_get_assignment', { assignmentId: '5' }],
  ['inna_get_grades', {}],
  ['inna_get_grades', { termId: '4' }],
  ['inna_get_course_grades', { groupId: '7' }],
  ['inna_get_attendance', {}],
  ['inna_get_attendance', { termId: '4' }],
  ['inna_get_materials', { groupId: '7' }],
  ['inna_get_messages', {}],
  ['inna_get_messages', { rowFrom: 2, rowTo: 40 }],
  ['inna_get_message', { messageId: '11', type: 'A' }],
  ['inna_get_absences', range],
  ['inna_absence_status', {}],
];

const SIBLING_READS: [string, unknown][] = [
  ['inna_get_overview', { studentKey: '5' }],
  ['inna_session_status', { studentKey: '5' }],
  ['inna_list_students', {}],
  ['inna_get_timetable', { ...range, studentKey: '5' }],
  ['inna_get_absences', { ...range, studentKey: '5' }],
  ['inna_session_status', {}],
  ['inna_get_overview', { studentKey: '77' }],
  ['inna_get_overview', { studentKey: '9' }],
  ['inna_get_overview', {}],
];

const INVALID: [string, unknown][] = [
  ['inna_get_timetable', {}],
  ['inna_get_timetable', { dateFrom: '2040-01-03', dateTo: '2040-01-02' }],
  ['inna_get_timetable', { dateFrom: 'x', dateTo: '2040-01-02', q: 1 }],
  ['inna_get_absences', { dateFrom: '2040-02-30', dateTo: '2040-03-01' }],
  ['inna_get_assignments', { type: 'x' }],
  ['inna_get_assignment', { assignmentId: 'x' }],
  ['inna_get_assignment', { assignmentId: '1'.repeat(33) }],
  ['inna_get_grades', { termId: 5 }],
  ['inna_get_course_grades', {}],
  ['inna_get_messages', { rowFrom: 0 }],
  ['inna_get_messages', { rowFrom: 5, rowTo: 2 }],
  ['inna_get_messages', { rowFrom: 1, rowTo: 500 }],
  ['inna_get_messages', { rowFrom: 1.5 }],
  ['inna_get_message', { messageId: '11', type: 'a' }],
  ['inna_get_overview', { studentKey: 'x' }],
  ['inna_list_students', { x: 1 }],
  ['inna_session_status', { studentKey: 5 }],
  ['inna_absence_status', { x: 1 }],
];

/** Each failure Inna can answer one read with, then the same read once it answers again. */
const FAILURES: Step[] = [
  ...[
    { status: 401 },
    { status: 403 },
    { status: 302, headers: { location: 'https://example.invalid/credential-trap' } },
    { status: 500, body: 'Synthetic failure' },
    { status: 200, body: '<html>Synthetic</html>', headers: { 'content-type': 'text/html' } },
    { status: 200, body: '{}' },
    { status: 200, body: '{"assignmentId":' },
    { status: 404 },
  ].flatMap((planted) => [
    { upstream: { planted: { '/api/GetAssignments/GetAssignmentInfo': planted } } },
    // lint: `satisfies`, not an assertion.
    { serve: [['inna_get_assignment', { assignmentId: '5' }]] satisfies [string, unknown][] },
  ]),
  { upstream: { planted: { '/api/UserData/GetLoggedInUser': { status: 401 } } } },
  {
    serve: [
      ['inna_session_status', {}],
      ['inna_get_overview', {}],
      ['inna_list_students', {}],
    ],
  },
  // Rate limits last: each pause is saved, and the clock moves past it.
  ...['60', 'Fri, 03 Jan 2040 12:10:00 GMT', '', 'soon', '99999999'].flatMap((after, index) => [
    { clock: NOW + index * 86_400_000 },
    {
      upstream: {
        planted: {
          '/api/GetAssignments/GetAssignmentInfo': {
            status: 429,
            headers: after ? { 'retry-after': after } : {},
          },
        },
      },
    },
    // lint: `satisfies`, not an assertion.
    {
      serve: [
        ['inna_get_assignment', { assignmentId: '5' }],
        ['inna_get_overview', {}],
      ] satisfies [string, unknown][],
    },
  ]),
  { upstream: { planted: {} } },
  { serve: [['inna_get_overview', {}]] },
  // Past the longest pause, about three years.
  { clock: NOW + 4 * 365 * 86_400_000 },
  { serve: [['inna_get_overview', {}]] },
];

const WRITES = ['--allow-absence-writes'];

/** Fields a request adds or overrides; `q` is one the tools must refuse. */
type Extra = { kind?: string; dateTo?: string; reason?: string; studentKey?: string; q?: number };

// lint: the extra fields as a named type, not `object`.
const sick = (day: string, extra: Extra = {}) => ({
  kind: 'sick',
  dateFrom: day,
  dateTo: day,
  reason: ' Synthetic reason ',
  ...extra,
});

// lint: the extra fields as a named type, not `object`.
const leave = (dateFrom: string, dateTo: string, extra: Extra = {}) => ({
  kind: 'leave',
  dateFrom,
  dateTo,
  reason: 'Synthetic leave',
  ...extra,
});

const submit = (operationId = '<operation>'): [string, unknown] => [
  'inna_submit_absence',
  { operationId, confirm: true },
];

/** Inna's absence history, empty, and its answer to a write. */
const clear = (
  write: Planted = { status: 200, body: '{"id":123,"extra":"x"}' },
): Partial<State> => ({
  planted: {
    '/api/RegisterAbsence/GetStudentRegisteredAbsences': { status: 200, body: '[]' },
    '/api/RegisterAbsence/GetLeaves': { status: 200, body: '[]' },
    '/api/RegisterAbsence/AddNewLeave': write,
  },
});

const ABSENCE_INVALID: [string, unknown][] = [
  ['inna_prepare_absence', {}],
  ['inna_prepare_absence', sick('2040-01-02', { dateTo: '2040-01-03' })],
  ['inna_prepare_absence', leave('2040-01-03', '2040-01-02', { reason: '  ', q: 1 })],
  ['inna_prepare_absence', sick('2040-02-30', { kind: 'x', studentKey: 'x' })],
  ['inna_prepare_absence', sick('2040-01-02', { reason: 'x'.repeat(2001) })],
  ['inna_submit_absence', {}],
  ['inna_submit_absence', { operationId: 'x', confirm: false }],
  [
    'inna_submit_absence',
    { operationId: '123e4567-e89b-12d3-a456-426614174000', confirm: true, x: 1 },
  ],
];

const scenarios: Scenario[] = [
  { name: 'surface', steps: [{ serve: [], surface: true }] },
  {
    name: 'surface-writes',
    steps: [{ serve: [], args: ['--allow-absence-writes'], surface: true }],
  },
  {
    name: 'surface-no-keep-alive',
    steps: [{ serve: [], args: ['--no-keep-alive'], surface: true }],
  },
  {
    name: 'write-tools-hidden',
    steps: [
      {
        serve: [
          ['inna_prepare_absence', {}],
          ['inna_submit_absence', {}],
          ['nope', {}],
        ],
      },
    ],
  },
  {
    name: 'cli',
    steps: [
      ['--help'],
      ['-h'],
      ['--version'],
      ['-v'],
      ['-hv'],
      ['--help', 'x', '--google'],
      ['--nope'],
      ['-x'],
      ['--help=1'],
      ['--google=1'],
      ['--timeout'],
      ['--timeout', '-5'],
      ['--keep-alive'],
      ['auth'],
      ['x'],
      [''],
      ['serve', 'x'],
      ['serve', '--allow-account-change'],
      ['serve', '--google'],
      ['--timeout', '5'],
      ['auth', 'login', '--timeout', '5'],
      ['auth', 'login', '--browser', 'b'],
      ['auth', 'login', 'x', '--google'],
      ['auth', 'status', '--google'],
      ['auth', 'login', '--allow-absence-writes'],
      ['auth', 'logout', '--no-keep-alive'],
      ['auth', 'import'],
      ['auth', 'import', ''],
      ['auth', 'import', 'a', 'b'],
      ['auth', 'status', 'x'],
      ['auth', 'status', '--allow-account-change'],
      // No `--` case: `bun cli.ts -- ...` drops the first `--` before cli.ts sees it, while the
      // released Bun binary passes it on, as the Rust binary reads it (main.rs tests it).
      ['auth', 'bogus'],
      ['auth', '', 'x'],
    ].map((args) => ({ cli: args })),
  },
  { name: 'reads', steps: [{ seed: true }, { serve: READS }, { serve: READS }] },
  { name: 'reads-odd', steps: [{ seed: true }, { upstream: { odd: true } }, { serve: READS }] },
  { name: 'reads-signed-out', steps: [{ serve: READS }] },
  { name: 'reads-invalid', steps: [{ seed: true }, { serve: INVALID }] },
  { name: 'siblings', steps: [{ seed: true }, { serve: SIBLING_READS }, { serve: SIBLING_READS }] },
  {
    name: 'siblings-refused',
    steps: [
      { seed: true },
      { upstream: { ignoreSwitch: true } },
      { serve: [['inna_get_overview', { studentKey: '5' }]] },
      {
        upstream: {
          ignoreSwitch: false,
          switchLocation: 'https://example.invalid/Components/Students/Students.html',
        },
      },
      { serve: [['inna_get_overview', { studentKey: '5' }]] },
      { upstream: { switchLocation: 'http://nam.inna.is/other' } },
      { serve: [['inna_get_overview', { studentKey: '5' }]] },
      {
        upstream: {
          switchLocation: 'http://nam.inna.is/Components/Students/Students.html',
          planted: { '/auth/system': { status: 429, headers: { 'retry-after': '120' } } },
        },
      },
      {
        serve: [
          ['inna_get_overview', { studentKey: '5' }],
          ['inna_get_overview', {}],
        ],
      },
    ],
  },
  { name: 'failures', steps: [{ seed: true }, ...FAILURES] },
  {
    name: 'session-commands',
    env: { INNA_SESSION_FILE: '<home>/legacy/session.json' },
    steps: [
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'logout'] },
      { legacy: 'legacy/session.json' },
      { cli: ['auth', 'status'] },
      { serve: [['inna_session_status', {}]] },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'status'] },
      { file: 'legacy/session.json', text: 'not a session' },
      { cli: ['auth', 'migrate'] },
      { legacy: 'legacy/session.json' },
      { cli: ['auth', 'logout'] },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
      { legacy: 'legacy/session.json' },
      { cli: ['auth', 'status'] },
      { seed: true },
      { cli: ['auth', 'status'] },
      { upstream: { planted: { '/api/UserData/GetLoggedInUser': { status: 401 } } } },
      { cli: ['auth', 'status'] },
    ],
  },
  {
    name: 'session-legacy-unreadable',
    env: { INNA_SESSION_FILE: '<home>/legacy/session.json' },
    steps: [
      { file: 'legacy/session.json', text: '{"version":3}' },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
      { file: 'legacy/session.json', text: LEGACY, permissions: 0o644 },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'migrate'] },
      { cli: ['auth', 'logout'] },
    ],
  },
  {
    name: 'session-relative-path',
    env: { INNA_SESSION_FILE: 'legacy/session.json' },
    steps: [
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'import', '<home>/cookies.json'] },
      { cli: ['auth', 'logout'] },
    ],
  },
  {
    name: 'import-refusals',
    steps: [
      { file: 'cookies.json', text: COOKIES },
      { cli: ['auth', 'import', 'cookies.json'] },
      { cli: ['auth', 'import', '<home>/missing.json'] },
      { cli: ['auth', 'import', '<home>'] },
      ...[
        ['broken', '{'],
        ['empty', '[]'],
        ['shape', '[{"name":"SESSION"}]'],
        ['object', '{"cookies":[]}'],
        ['domain', cookieFile([{ name: 'SESSION', value: 'v', domain: 'inna.is' }])],
        [
          'path',
          cookieFile([{ name: 'XSRF-TOKEN', value: 'v', domain: 'nam.inna.is', path: '/api' }]),
        ],
        [
          'others',
          cookieFile([{ name: 'other', value: 'v', domain: 'example.invalid', path: '/x' }]),
        ],
        ['bom', `\ufeff${COOKIES}`],
        // lint: defaults, not a non-null assertion; every pair has both.
      ].flatMap(([name = '', text = '']) => [
        { file: `${name}.json`, text },
        { cli: ['auth', 'import', `<home>/${name}.json`] },
      ]),
      { file: 'open.json', text: COOKIES, permissions: 0o644 },
      { cli: ['auth', 'import', '<home>/open.json'] },
      { cli: ['auth', 'status'] },
    ],
  },
  {
    name: 'import-accounts',
    steps: [
      { seed: true },
      { serve: [['inna_get_overview', { studentKey: '5' }]] },
      { upstream: { selected: '5' } },
      { seed: true },
      { upstream: { selected: '9' } },
      { seed: true },
      { upstream: { selected: '5' } },
      { seed: true, args: ['--allow-account-change'] },
      { cli: ['auth', 'status'] },
      { upstream: { selected: '1' } },
      { seed: true },
      {
        upstream: {
          planted: {
            '/api/UserData/GetLoggedInUser': { status: 429, headers: { 'retry-after': '120' } },
          },
        },
      },
      { seed: true, args: ['--allow-account-change'] },
      { upstream: { planted: {} } },
      { seed: true, args: ['--allow-account-change'] },
      { clock: NOW + 3_600_000 },
      { seed: true, args: ['--allow-account-change'] },
      { serve: [['inna_list_students', {}]] },
    ],
  },
  {
    // The phone prompt read from piped input, up to the first request: the fake Inna answers the
    // sign-in's first host with 404, which both sides report the same way.
    name: 'login-input',
    steps: [
      ...[
        '',
        '\n',
        ' 5550000 ',
        '123\r5550000\n',
        '555 0000\n',
        '5550000\u0000\n',
        '\ufeff5550000\u00a0\n',
        '５５５００００\n',
        '5550000\n',
      ].map((stdin) => ({ cli: ['auth', 'login'], stdin })),
      { cli: ['auth', 'login'] },
      { cli: ['auth', 'login', '--allow-account-change'], stdin: '5550000\r\n' },
      { seed: true },
      { cli: ['auth', 'login'], stdin: '5550000' },
      { cli: ['auth', 'status'] },
    ],
  },
  {
    // Google sign-in up to the browser: every case names a missing browser, so neither side can
    // open a real one.
    name: 'google-refusals',
    env: { INNA_BROWSER: '<home>/missing-from-environment' },
    steps: [
      ...[
        ['--timeout', '0'],
        ['--timeout=1.5'],
        ['--timeout=', '--browser', '<home>/missing'],
        ['--timeout', '0x10'],
        ['--timeout', ' 7 '],
        ['--browser', '<home>/missing'],
        ['--browser', '<home>'],
        [],
        ['--allow-account-change'],
      ].map((args) => ({ cli: ['auth', 'login', '--google', ...args] })),
      { file: 'not-executable', text: '#!/bin/sh\n', permissions: 0o600 },
      { cli: ['auth', 'login', '--google', '--browser', '<home>/not-executable'] },
    ],
  },
  {
    name: 'absence-writes',
    steps: [
      { seed: true },
      { upstream: clear() },
      {
        serve: [
          ...ABSENCE_INVALID,
          ['inna_prepare_absence', sick('2040-01-01')],
          ['inna_prepare_absence', sick('2040-01-03')],
          submit(),
          ['inna_prepare_absence', sick('2040-01-02')],
          ['inna_absence_status', {}],
          submit(),
          submit(),
          submit('123e4567-e89b-12d3-a456-426614174000'),
          ['inna_absence_status', {}],
          // A sibling's leave: prepared for that student, then submitted to it after a switch away.
          ['inna_prepare_absence', leave('2040-02-01', '2040-02-03', { studentKey: '5' })],
          ['inna_get_overview', {}],
          submit(),
          ['inna_absence_status', {}],
        ],
        args: WRITES,
      },
      // A preview past its ten minutes.
      { serve: [['inna_prepare_absence', leave('2040-03-01', '2040-03-01')]], args: WRITES },
      { clock: NOW + 600_000 },
      { serve: [submit(), ['inna_absence_status', {}]], args: WRITES },
      // Tomorrow's sick day, where Inna allows it.
      { upstream: { odd: true } },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', sick('2040-01-03')]], args: WRITES },
    ],
  },
  {
    // Registered absences and leave applications that overlap, an unrecognized date after a
    // match and before one, and failed reads.
    name: 'absence-history',
    steps: [
      { seed: true },
      {
        serve: [
          ['inna_prepare_absence', leave('2040-01-02', '2040-01-05')],
          ['inna_prepare_absence', sick('2040-01-02')],
        ],
        args: WRITES,
      },
      {
        upstream: {
          planted: {
            '/api/RegisterAbsence/GetStudentRegisteredAbsences': { status: 200, body: '[]' },
          },
        },
      },
      {
        serve: [
          ['inna_prepare_absence', leave('2040-01-02', '2040-01-05')],
          ['inna_prepare_absence', leave('2040-01-03', '2040-01-05')],
        ],
        args: WRITES,
      },
      {
        upstream: {
          planted: {
            '/api/RegisterAbsence/GetStudentRegisteredAbsences': {
              status: 200,
              body: JSON.stringify([
                { id: 1, date: '01.03.2040', statusCode: 0, allDay: '1', classes: [] },
                { id: 2, date: '31.02.2040', statusCode: 0, allDay: '1', classes: [] },
              ]),
            },
          },
        },
      },
      {
        serve: [
          ['inna_prepare_absence', leave('2040-01-03', '2040-01-05')],
          ['inna_prepare_absence', leave('2040-03-01', '2040-03-02')],
        ],
        args: WRITES,
      },
      { upstream: { planted: { '/api/RegisterAbsence/GetRegisterAbsences': { status: 500 } } } },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      {
        upstream: {
          planted: { '/api/UserData/GetLoggedInUser': { status: 200, body: '{"x":1}' } },
        },
      },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
    ],
  },
  {
    // A write whose outcome is unknown blocks every later preview and is never sent again, also
    // by the other side and after a logout.
    name: 'absence-uncertain',
    steps: [
      { seed: true },
      { upstream: clear({ status: 500 }) },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { serve: [submit(), ['inna_absence_status', {}]], args: WRITES, swap: true },
      {
        serve: [
          submit(),
          ['inna_prepare_absence', leave('2040-02-01', '2040-02-01', { studentKey: '5' })],
        ],
        args: WRITES,
      },
      { cli: ['auth', 'logout'] },
      { seed: true },
      {
        serve: [
          ['inna_absence_status', {}],
          ['inna_prepare_absence', sick('2040-01-02')],
        ],
        args: WRITES,
        swap: true,
      },
    ],
  },
  {
    // Each side submits the preview the other prepared, and each returns the other's result.
    name: 'absence-interop',
    steps: [
      { seed: true },
      { upstream: clear() },
      {
        serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02', { studentKey: '5' })]],
        args: WRITES,
        swap: true,
      },
      { serve: [['inna_absence_status', {}], submit(), ['inna_absence_status', {}]], args: WRITES },
      {
        serve: [
          submit(),
          ['inna_absence_status', {}],
          ['inna_prepare_absence', leave('2040-02-01', '2040-02-02')],
        ],
        args: WRITES,
        swap: true,
      },
    ],
  },
  {
    // An answer without a positive ID leaves the outcome unknown on either side.
    name: 'absence-interop-unknown',
    steps: [
      { seed: true },
      { upstream: clear({ status: 200, body: '{"id":0}' }) },
      {
        serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02', { studentKey: '5' })]],
        args: WRITES,
        swap: true,
      },
      { serve: [submit(), ['inna_absence_status', {}]], args: WRITES },
      { serve: [submit()], args: WRITES, swap: true },
    ],
  },
  {
    // Both refinements failing, alone and with field, key and length issues; the reason limit
    // counts code points.
    name: 'absence-refinements',
    steps: [
      {
        serve: [
          ['inna_prepare_absence', sick('2040-01-03', { dateTo: '2040-01-02' })],
          ['inna_prepare_absence', sick('2040-01-03', { dateTo: '2040-01-02', reason: ' ' })],
          ['inna_prepare_absence', sick('2040-01-03', { dateTo: '2040-01-02', q: 1 })],
          ['inna_prepare_absence', sick('2040-01-03', { dateTo: '2040-01-02', studentKey: '5x' })],
          ['inna_prepare_absence', leave('2040-01-03', '2040-01-02', { reason: 'x'.repeat(2001) })],
          [
            'inna_prepare_absence',
            sick('2040-01-03', {
              dateTo: '2040-01-02',
              reason: String.fromCodePoint(0x1f600).repeat(2000),
            }),
          ],
          [
            'inna_prepare_absence',
            sick('2040-01-03', {
              dateTo: '2040-01-02',
              reason: String.fromCodePoint(0x1f600).repeat(2001),
            }),
          ],
        ],
        args: WRITES,
      },
    ],
  },
  {
    // A 429 on the write: the outcome is unknown, the pause is saved and honoured without a
    // request, and the write is never sent again.
    name: 'absence-429-post',
    steps: [
      { seed: true },
      { upstream: clear({ status: 429, headers: { 'retry-after': '120' }, body: '' }) },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      {
        serve: [
          submit(),
          ['inna_absence_status', {}],
          submit(),
          ['inna_prepare_absence', sick('2040-01-02')],
        ],
        args: WRITES,
      },
      { clock: NOW + 120_001 },
      { upstream: clear() },
      {
        serve: [
          ['inna_absence_status', {}],
          submit(),
          ['inna_prepare_absence', sick('2040-01-02')],
        ],
        args: WRITES,
      },
    ],
  },
  {
    // A 429 on prepare's history read writes no preview, and the pause holds until it ends.
    name: 'absence-429-prepare',
    steps: [
      { seed: true },
      {
        upstream: {
          planted: {
            ...clear().planted,
            '/api/RegisterAbsence/GetLeaves': {
              status: 429,
              headers: { 'retry-after': '120' },
              body: '',
            },
          },
        },
      },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02')]], args: WRITES },
      { upstream: clear() },
      {
        serve: [
          ['inna_prepare_absence', leave('2040-02-01', '2040-02-02')],
          ['inna_absence_status', {}],
        ],
        args: WRITES,
      },
      { clock: NOW + 120_001 },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02')]], args: WRITES },
    ],
  },
  {
    // A 429 on submit's re-check sends no write and keeps the preview, which is submitted once the
    // pause ends.
    name: 'absence-429-submit-checks',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02')]], args: WRITES },
      {
        upstream: {
          planted: {
            ...clear().planted,
            '/api/RegisterAbsence/GetLeaves': {
              status: 429,
              headers: { 'retry-after': '60' },
              body: '',
            },
          },
        },
      },
      { serve: [submit()], args: WRITES },
      { upstream: clear() },
      { serve: [submit()], args: WRITES },
      { clock: NOW + 60_001 },
      { serve: [submit(), ['inna_absence_status', {}]], args: WRITES },
    ],
  },
  {
    // The host cancels a submit while its overlap check waits on Inna: nothing is sent, and the
    // preview stays prepared.
    name: 'absence-cancel-submit',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { delays: { '/api/RegisterAbsence/GetLeaves': 1500 } } },
      {
        cancel: submit(),
        by: 'host',
        when: '/api/RegisterAbsence/GetLeaves',
        writes: 0,
        args: WRITES,
      },
      { upstream: { delays: {} } },
      { serve: [['inna_absence_status', {}]], args: WRITES },
    ],
  },
  {
    // The host cancels a prepare while its history read waits on Inna: no preview is written.
    name: 'absence-cancel-prepare',
    steps: [
      { seed: true },
      { upstream: { ...clear(), delays: { '/api/RegisterAbsence/GetLeaves': 1500 } } },
      {
        cancel: ['inna_prepare_absence', sick('2040-01-02')],
        by: 'host',
        when: '/api/RegisterAbsence/GetLeaves',
        writes: 0,
        args: WRITES,
      },
      { upstream: { delays: {} } },
      { serve: [['inna_absence_status', {}]], args: WRITES },
    ],
  },
  {
    // The host cancels a submit while Inna holds its write: the outcome is unknown.
    name: 'absence-cancel-post',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { delays: { '/api/RegisterAbsence/AddNewLeave': 1500 } } },
      {
        cancel: submit(),
        by: 'host',
        when: '/api/RegisterAbsence/AddNewLeave',
        writes: 1,
        args: WRITES,
      },
      { upstream: { delays: {} } },
      { serve: [['inna_absence_status', {}], submit()], args: WRITES },
    ],
  },
  {
    // The server's stdin ends while a submit's overlap check waits on Inna: the call is aborted at
    // once, so nothing is sent.
    name: 'absence-close-submit',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { delays: { '/api/RegisterAbsence/GetLeaves': 1500 } } },
      {
        cancel: submit(),
        by: 'stdin',
        when: '/api/RegisterAbsence/GetLeaves',
        writes: 0,
        args: WRITES,
      },
      { upstream: { delays: {} } },
      { serve: [['inna_absence_status', {}]], args: WRITES },
    ],
  },
  {
    // SIGINT while a submit's overlap check waits on Inna: nothing is sent.
    name: 'absence-sigint-submit',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { delays: { '/api/RegisterAbsence/GetLeaves': 1500 } } },
      {
        cancel: submit(),
        by: 'SIGINT',
        when: '/api/RegisterAbsence/GetLeaves',
        writes: 0,
        args: WRITES,
      },
      { upstream: { delays: {} } },
      { serve: [['inna_absence_status', {}]], args: WRITES },
    ],
  },
  {
    // SIGTERM while a submit's overlap check waits on Inna: nothing is sent.
    name: 'absence-sigterm-submit',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { delays: { '/api/RegisterAbsence/GetLeaves': 1500 } } },
      {
        cancel: submit(),
        by: 'SIGTERM',
        when: '/api/RegisterAbsence/GetLeaves',
        writes: 0,
        args: WRITES,
      },
      { upstream: { delays: {} } },
      { serve: [['inna_absence_status', {}]], args: WRITES },
    ],
  },
  {
    // A store that passes the startup check but holds a damaged record or marker: `auth login`
    // refuses it before it asks for the phone number.
    name: 'login-store-unusable',
    steps: [
      { seed: true },
      { file: storeFile, text: 'x' },
      { cli: ['auth', 'login'], stdin: '5550000\n', absent: 'phone number' },
    ],
  },
  {
    name: 'login-marker-unusable',
    steps: [
      { seed: true },
      { file: `${storeFile}.marker`, text: 'x' },
      { cli: ['auth', 'login'], stdin: '5550000\n', absent: 'phone number' },
    ],
  },
  {
    name: 'store-file-open',
    steps: [
      { file: storeFile, text: 'x', permissions: 0o644 },
      { cli: ['auth', 'status'] },
      { cli: ['auth', 'bogus'] },
    ],
  },
  {
    name: 'store-folder-open',
    steps: [
      { file: storeFile, text: 'x' },
      { directory: '.config/inna-mcp', permissions: 0o755 },
      { cli: ['serve'] },
      { cli: ['auth', 'login'] },
    ],
  },
];
// ---- end of parity.ts ----

setSystemTime();

/** The environment of a run in `home`: parity.ts's, with the proxy as the test origin. */
function environment(home: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    INNA_TEST_ORIGIN: origin,
    INNA_TEST_NOW: clock,
    ...extra,
  };
}

/** Values no output may hold: what fake-inna.ts marks as never returned, and every cookie value. */
const LEAKS = [
  'DO-NOT-RETURN',
  '9999999999',
  'synthetic-session',
  'synthetic-xsrf',
  'synthetic-rotated',
  'synthetic-switched',
];

function leaks(at: string, text: string): void {
  for (const leak of LEAKS)
    if (text.includes(leak)) throw new RangeError(`${at}: an output holds ${leak}.`);
}

/** A prepare's answer: its operation ID. */
const preparedAnswer = z.object({
  result: z.object({ structuredContent: z.object({ operationId: z.string() }) }),
});

/**
 * Per home: `<home>` for the scratch home, `<operation-N>` for the Nth operation ID a prepare
 * returned, an ISO time from 2020 up to 2039 as `<wall-clock>` (a cookie jar's creation and last
 * access times are the wall clock's, not the scenario clock's, which reads 2040; no scenario value
 * falls in that span, the fake's epoch values being 1970 or 2040 and later), and, in a scenario
 * that plants a 401, `synthetic-rotated-<rotation>` for each rotated cookie value (the renewal the
 * binary adds after a 401 shifts the count; parity.ts normalized it the same way).
 */
class Names {
  readonly operations: string[] = [];

  constructor(
    private readonly home: string,
    private readonly rotation: boolean,
  ) {}

  /** Learns the operation ID of a prepare's answer. */
  learn(answer: string): void {
    const prepared = preparedAnswer.safeParse(JSON.parse(answer));

    if (prepared.success) {
      const id = prepared.data.result.structuredContent.operationId;

      if (!this.operations.includes(id)) this.operations.push(id);
    }
  }

  fresh(text: string): string {
    let named = text.replaceAll(realpathSync(this.home), '<home>').replaceAll(this.home, '<home>');

    for (const [index, id] of this.operations.entries())
      named = named.replaceAll(id, `<operation-${index + 1}>`);

    named = named.replaceAll(/\b20[23]\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (iso) =>
      iso < '2039' ? '<wall-clock>' : iso,
    );

    return this.rotation
      ? named.replaceAll(/synthetic-rotated-\d+/g, 'synthetic-rotated-<rotation>')
      : named;
  }
}

const toolArguments = z.record(z.string(), z.unknown());

type Arguments = z.infer<typeof toolArguments>;

/**
 * A call's arguments (as JSON text) with `<operation>` naming the last prepared operation, as in
 * parity.ts.
 */
function placed(text: string, names: Names): Arguments {
  return toolArguments.parse(
    JSON.parse(text.replaceAll('<operation>', names.operations.at(-1) ?? '<operation>')),
  );
}

/** The exchanges since `start`, their requests named like outputs; responses are served raw. */
function since(start: number, names: Names): Exchange[] {
  const named: Exchange[] = [];

  for (const exchange of exchanges.slice(start)) {
    assert.ok(exchange.response, `${exchange.request.url} was never answered`);

    const { method, url, headers, body } = exchange.request;

    const request = {
      method,
      url: names.fresh(url),
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          value === null ? null : names.fresh(value),
        ]),
      ),
      body: names.fresh(body),
    };

    const kept: Exchange = { request, response: exchange.response };

    if (exchange.recovery) kept.recovery = exchange.recovery;

    named.push(kept);
  }

  return named;
}

function command(args: string[]): string[] {
  return [process.execPath, '--preload', rewrite, cli, ...args];
}

async function runCli(
  home: string,
  names: Names,
  env: Record<string, string>,
  step: { cli: string[]; stdin?: string; absent?: string },
) {
  const start = exchanges.length;
  const place = (text: string) => text.replaceAll('<home>', home);

  const child = Bun.spawn(command(step.cli.map(place)), {
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

  if (step.absent !== undefined && (stdout + stderr).includes(step.absent))
    throw new RangeError(`${home}: printed ${JSON.stringify(step.absent)}`);

  return {
    ...step,
    code,
    stdout: names.fresh(stdout),
    stderr: names.fresh(stderr),
    exchanges: since(start, names),
  };
}

/** The protocol version and client the replay sends too. */
const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'inna-parity', version: '1.0.0' },
};

type Params =
  | typeof INITIALIZE
  | { name: string; arguments: Arguments }
  | { requestId: number; reason: string }
  | Record<string, never>;

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

/** `inna-mcp serve` over raw JSON-RPC, as one MCP client for the server's life. */
class Server {
  private readonly child;

  private readonly incoming;

  private id = 0;

  constructor(home: string, env: Record<string, string>, args: string[]) {
    this.child = Bun.spawn(command(['serve', ...args]), {
      cwd: home,
      env: environment(home, env),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.incoming = lines(this.child.stdout);
  }

  async send(message: Outgoing): Promise<void> {
    await this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    await this.child.stdin.flush();
  }

  /** Sends a request and returns its id. */
  async begin(method: string, params: Params): Promise<number> {
    const sent = this.id++;
    await this.send({ id: sent, method, params });

    return sent;
  }

  /** The answer to `id`, with the notifications before it. */
  async answer(id: number): Promise<{ notifications: string[]; answer: string }> {
    const notifications: string[] = [];

    for (;;) {
      const next = await this.incoming.next();

      if (next.done === true) throw new RangeError(`The server closed before answering ${id}.`);

      const message = incomingMessage.parse(JSON.parse(next.value));

      if (message.id === undefined) {
        notifications.push(next.value);
        continue;
      }

      if (message.id !== id)
        throw new RangeError(`An answer to ${JSON.stringify(message.id)}, not ${id}.`);

      return { notifications, answer: next.value };
    }
  }

  async request(method: string, params: Params) {
    return this.answer(await this.begin(method, params));
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

  kill(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
    this.child.kill(signal);
  }

  async exited(patience: number): Promise<number | 'running'> {
    return Promise.race([this.child.exited, Bun.sleep(patience).then(() => 'running' as const)]);
  }

  get signal(): string | null {
    return this.child.signalCode;
  }
}

type Result = {
  call: [string, unknown];
  notifications?: unknown[];
  answer: string;
  exchanges: Exchange[];
};

type FrozenServe = {
  serve: true;
  args?: string[];
  swap?: true;
  initialize?: string;
  list?: string;
  results?: Result[];
  code?: number | null;
  stderr?: string;
};

async function runServe(
  home: string,
  names: Names,
  env: Record<string, string>,
  step: { serve: [string, unknown][]; args?: string[]; surface?: boolean; swap?: boolean },
): Promise<FrozenServe> {
  const server = new Server(home, env, step.args ?? []);
  const initialize = await server.initialize();
  const list = step.surface === true ? (await server.request('tools/list', {})).answer : undefined;
  const results: Result[] = [];

  for (const [name, args] of step.serve) {
    const start = exchanges.length;

    const { notifications, answer } = await server.request('tools/call', {
      name,
      arguments: placed(JSON.stringify(args), names),
    });

    leaks(home, answer + notifications.join(''));
    names.learn(answer);
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
        { answer: names.fresh(answer), exchanges: since(start, names) },
      ),
    );
  }

  const { code, stderr } = await server.close();
  leaks(home, stderr);

  // Built in this order, the fixture's key order.
  const frozen: FrozenServe = { serve: true };

  if (step.args) frozen.args = step.args;

  if (step.swap === true) frozen.swap = true;

  if (list !== undefined) {
    frozen.initialize = initialize;
    frozen.list = list;
  }

  frozen.results = results;
  frozen.code = code;
  frozen.stderr = names.fresh(stderr);

  return frozen;
}

/** Resolves once the proxy has seen a request to `path` after the first `from` exchanges. */
async function seenPath(path: string, from: number): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (
    !exchanges.slice(from).some((exchange) => new URL(exchange.request.url).pathname === path)
  ) {
    if (Date.now() > deadline) throw new Error(`Inna never saw ${path}`);

    await Bun.sleep(10);
  }
}

type Cancel = {
  cancel: [string, unknown];
  by: 'host' | 'stdin' | 'SIGINT' | 'SIGTERM';
  when: string;
  writes: number;
  args?: string[];
};

type Outcome =
  | { call: string; code: number | null; stderr: string }
  | { exited: number | 'running'; signal: string | null };

/**
 * parity.ts's cancelled call: by the host (`notifications/cancelled`, as the SDK client's abort
 * sends it), by the end of the server's standard input, or by a signal, once the request to
 * `when` has reached Inna, which holds it; then long enough for that request to be answered and
 * anything sent after it to arrive. The host's cancel keeps whether the server still answered the
 * call; the others how the server exited (parity.ts compared no output of them).
 */
async function runCancel(home: string, names: Names, env: Record<string, string>, step: Cancel) {
  const settle = (current.state.delays[step.when] ?? 0) + 1000;
  const start = exchanges.length;
  const [name, input] = step.cancel;
  const server = new Server(home, env, step.args ?? []);
  await server.initialize();

  const id = await server.begin('tools/call', {
    name,
    arguments: placed(JSON.stringify(input), names),
  });

  await seenPath(step.when, start);
  let outcome: Outcome;

  if (step.by === 'host') {
    await server.send({
      method: 'notifications/cancelled',
      params: { requestId: id, reason: 'AbortError' },
    });

    await Bun.sleep(settle);
    // A ping answered before any answer to the call shows the call was dropped.
    const ping = await server.begin('ping', {});
    let call = 'no answer';

    try {
      await server.answer(ping);
    } catch (error) {
      call = error instanceof Error ? error.message : String(error);
    }

    const closed = await server.close();
    leaks(home, closed.stderr);
    outcome = { call, code: closed.code, stderr: names.fresh(closed.stderr) };
  } else {
    if (step.by === 'stdin') await server.close();
    else server.kill(step.by);

    const exited = await server.exited(settle + 5000);

    if (exited === 'running') server.kill('SIGKILL');
    else await Bun.sleep(settle);

    outcome = { exited, signal: server.signal };

    if (step.by !== 'stdin') await server.close();
  }

  const sent = since(start, names);

  const writes = sent.filter((exchange) =>
    exchange.request.url.endsWith('/api/RegisterAbsence/AddNewLeave'),
  ).length;

  assert.equal(writes, step.writes, `${home}: ${writes} absence writes, not ${step.writes}`);

  return { ...step, delays: current.state.delays, outcome, exchanges: sent };
}

/** Every path under `home` (a directory ends in `/`) with its permission bits, sorted. */
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

/** The text of each absence record (`<legacy>.absence.json`) under `home`, by path. */
function journals(home: string, names: Names) {
  return Object.fromEntries(
    readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.absence.json'))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);

        return [names.fresh(relative(home, path)), names.fresh(readFileSync(path, 'utf8'))];
      }),
  );
}

type PlantEntry = { path: string; mode: number; hex?: string };

/** Every file and folder under `home` with its mode, and each file's bytes in hex, for a `swap` plant. */
function snapshot(home: string): PlantEntry[] {
  return readdirSync(home, { recursive: true, withFileTypes: true })
    .map((entry): PlantEntry => {
      const path = relative(home, join(entry.parentPath, entry.name));
      const full = join(home, path);
      const mode = statSync(full).mode & 0o777;

      if (entry.isDirectory()) return { path, mode };

      const bytes = readFileSync(full);
      assert.ok(!bytes.includes(home), `${path} names the home`);

      return { path, mode, hex: bytes.toString('hex') };
    })
    .toSorted((first, second) =>
      first.path < second.path ? -1 : first.path > second.path ? 1 : 0,
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

type Stored = { store: 'none' } | { record: string | null } | { error: string };

/** What the store holds: no store, the decrypted record text, or the error code. */
async function stored(home: string, names: Names): Promise<Stored> {
  return inHome(home, async () => {
    const options = {
      path: defaultSecretRecordPath('inna-mcp'),
      server: 'inna-mcp',
      profile: 'default',
      purpose: 'session',
      schema: 1,
      maxBytes: RECORD_MAX_BYTES,
      keys: defaultKeyProvider({ server: 'inna-mcp', profile: 'default' }),
    };

    if (!existsSync(options.path) && !existsSync(`${options.path}.marker`))
      return { store: 'none' };

    try {
      const text = await withSecretStore(options, (opened) => opened.read());

      return { record: text === null ? null : names.fresh(text) };
    } catch (error) {
      return { error: error instanceof SessionStoreError ? error.code : 'unknown' };
    }
  });
}

function writeStep(home: string, step: { file: string; text: string; permissions?: number }): void {
  const path = join(home, step.file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, step.text, { mode: step.permissions ?? 0o600 });
  chmodSync(path, step.permissions ?? 0o600);
}

/** Whether a scenario plants a 401, where parity.ts named rotated cookies `<rotation>`. */
const plants401 = (scenario: Scenario) =>
  scenario.steps.some(
    (step) =>
      'upstream' in step &&
      Object.values(step.upstream.planted ?? {}).some((reply) => reply.status === 401),
  );

type Frozen = {
  id: string;
  env?: Record<string, string>;
  rotation?: true;
  steps: object[];
  requests: number;
  files: string[];
};

async function run(scenario: Scenario) {
  const home = join(scratch, scenario.name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const rotation = plants401(scenario);
  const names = new Names(home, rotation);
  current = { state: fresh(), seen: [] };
  const start = exchanges.length;
  writeFileSync(clock, String(NOW));
  const place = (text: string) => text.replaceAll('<home>', home);

  const env = Object.fromEntries(
    Object.entries(scenario.env ?? {}).map(([name, value]) => [name, place(value)]),
  );

  const steps: object[] = [];
  const journal = () => ({ journal: journals(home, names) });

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push({ ...(await runCli(home, names, env, step)), ...journal() });
    else if ('seed' in step) {
      writeStep(home, { file: 'cookies.json', text: COOKIES });
      steps.push({ file: 'cookies.json', text: COOKIES });
      const args = ['auth', 'import', '<home>/cookies.json', ...(step.args ?? [])];
      steps.push({ ...(await runCli(home, names, env, { cli: args })), ...journal() });
    } else if ('legacy' in step) {
      writeStep(home, { file: step.legacy, text: LEGACY });
      steps.push({ file: step.legacy, text: LEGACY });
    } else if ('upstream' in step) {
      Object.assign(current.state, step.upstream);
      steps.push(step);
    } else if ('clock' in step) {
      writeFileSync(clock, String(step.clock));
      steps.push(step);
    } else if ('serve' in step) {
      // A `swap` step's home as the TypeScript side had written it, planted by the replay.
      const plant = step.swap === true ? snapshot(home) : undefined;
      const operations = [...names.operations];
      const frozen = await runServe(home, names, env, step);

      steps.push(
        plant === undefined
          ? { ...frozen, ...journal() }
          : { plant, operations, ...frozen, ...journal() },
      );
    } else if ('cancel' in step)
      steps.push({ ...(await runCancel(home, names, env, step)), ...journal() });
    else if ('directory' in step) {
      chmodSync(join(home, step.directory), step.permissions);
      steps.push(step);
    } else {
      writeStep(home, step);
      steps.push(step);
    }
  }

  const frozen: Frozen = Object.assign(
    { steps, id: `inna/${set}/${scenario.name}` },
    scenario.env ? { env: scenario.env } : undefined,
    rotation ? { rotation: true as const } : undefined,
    { requests: exchanges.length - start, files: files(home, names) },
  );

  return { ...frozen, ...(await stored(home, names)) };
}

/**
 * Long runs of one character inside JSON strings become `\u0001<character>*<count>\u0001`; the
 * replay expands them. No frozen value holds a U+0001 (login-input's standard input holds a NUL,
 * so the sentinel is not Domino's NUL).
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
    writeFileSync(join(output, `${scenario.name}.json`), pack(layout(frozen)));
    process.stdout.write(`${scenario.name}: ${frozen.requests} requests\n`);
  }
} finally {
  await fake.close();
  proxyServer.close();
  rmSync(scratch, { recursive: true, force: true });
}
