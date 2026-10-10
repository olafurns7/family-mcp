// TypeScript-versus-Rust parity for inna-mcp, driven by tests/parity.rs. Each scenario runs once
// against the TypeScript CLI (with rewrite.ts preloaded) and once against the Rust binary (built
// with `test-origin`), each in its own scratch home, against the same fake Inna (fake-inna.ts) and
// clock, and compares outputs, exit codes, the requests Inna saw and the files left behind, with
// the home path written as <home> and each prepared absence's random operation ID as <operation>.
// A `swap` step runs the other side's implementation in this side's home, so each reads what the
// other wrote. Prints mismatches and exits 1 on any.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cookieExportSchema, sessionJar } from '../../../../packages/inna-mcp/src/client.js';
import { COOKIES, fresh, startFake, type Planted, type Seen, type State } from './fake-inna.ts';

const [rust, only] = process.argv.slice(2);

if (!rust) throw new RangeError('Usage: parity.ts RUST_BINARY [SCENARIO]');

// Both sides keep their store in each scenario's scratch home through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');
const repo = resolve(import.meta.dir, '../../../..');
const cli = join(repo, 'packages/inna-mcp/src/cli.ts');
const rewrite = join(import.meta.dir, 'rewrite.ts');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'inna-parity-'));
const clock = join(scratch, 'now');
const NOW = Date.parse('2040-01-02T12:00:00Z');
let current = { state: fresh(), seen: [] as Seen[] };
const fake = await startFake(() => current);

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
  | { cancel: [string, unknown]; by: 'host' | 'stdin' | 'SIGINT' | 'SIGTERM'; when: string; writes: number; args?: string[] }
  | { file: string; text: string; permissions?: number }
  | { directory: string; permissions: number };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

const storeFile = '.config/inna-mcp/session.enc';

/** A saved session as an older version left it in plaintext, with the synthetic cookies. */
const LEGACY = JSON.stringify({
  version: 2,
  jar: JSON.stringify(await (await sessionJar(cookieExportSchema.parse(JSON.parse(COOKIES)))).serialize()),
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
    { serve: [['inna_get_assignment', { assignmentId: '5' }]] as [string, unknown][] },
  ]),
  { upstream: { planted: { '/api/UserData/GetLoggedInUser': { status: 401 } } } },
  { serve: [['inna_session_status', {}], ['inna_get_overview', {}], ['inna_list_students', {}]] },
  // Rate limits last: each pause is saved, and the clock moves past it.
  ...['60', 'Fri, 03 Jan 2040 12:10:00 GMT', '', 'soon', '99999999'].flatMap((after, index) => [
    { clock: NOW + index * 86_400_000 },
    {
      upstream: {
        planted: { '/api/GetAssignments/GetAssignmentInfo': { status: 429, headers: after ? { 'retry-after': after } : {} } },
      },
    },
    { serve: [['inna_get_assignment', { assignmentId: '5' }], ['inna_get_overview', {}]] as [string, unknown][] },
  ]),
  { upstream: { planted: {} } },
  { serve: [['inna_get_overview', {}]] },
  // Past the longest pause, about three years.
  { clock: NOW + 4 * 365 * 86_400_000 },
  { serve: [['inna_get_overview', {}]] },
];

const WRITES = ['--allow-absence-writes'];

const sick = (day: string, extra: object = {}) => ({ kind: 'sick', dateFrom: day, dateTo: day, reason: ' Synthetic reason ', ...extra });

const leave = (dateFrom: string, dateTo: string, extra: object = {}) => ({ kind: 'leave', dateFrom, dateTo, reason: 'Synthetic leave', ...extra });

const submit = (operationId = '<operation>'): [string, unknown] => ['inna_submit_absence', { operationId, confirm: true }];

/** Inna's absence history, empty, and its answer to a write. */
const clear = (write: Planted = { status: 200, body: '{"id":123,"extra":"x"}' }): Partial<State> => ({
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
  ['inna_submit_absence', { operationId: '123e4567-e89b-12d3-a456-426614174000', confirm: true, x: 1 }],
];

const scenarios: Scenario[] = [
  { name: 'surface', steps: [{ serve: [], surface: true }] },
  { name: 'surface-writes', steps: [{ serve: [], args: ['--allow-absence-writes'], surface: true }] },
  { name: 'surface-no-keep-alive', steps: [{ serve: [], args: ['--no-keep-alive'], surface: true }] },
  {
    name: 'write-tools-hidden',
    steps: [{ serve: [['inna_prepare_absence', {}], ['inna_submit_absence', {}], ['nope', {}]] }],
  },
  {
    name: 'cli',
    steps: [
      ['--help'], ['-h'], ['--version'], ['-v'], ['-hv'], ['--help', 'x', '--google'], ['--nope'], ['-x'],
      ['--help=1'], ['--google=1'], ['--timeout'], ['--timeout', '-5'], ['--keep-alive'], ['auth'], ['x'],
      [''], ['serve', 'x'], ['serve', '--allow-account-change'], ['serve', '--google'], ['--timeout', '5'],
      ['auth', 'login', '--timeout', '5'], ['auth', 'login', '--browser', 'b'], ['auth', 'login', 'x', '--google'],
      ['auth', 'status', '--google'], ['auth', 'login', '--allow-absence-writes'],
      ['auth', 'logout', '--no-keep-alive'], ['auth', 'import'], ['auth', 'import', ''],
      ['auth', 'import', 'a', 'b'], ['auth', 'status', 'x'], ['auth', 'status', '--allow-account-change'],
      // No `--` case: `bun cli.ts -- ...` drops the first `--` before cli.ts sees it, while the
      // released Bun binary passes it on, as the Rust binary reads it (main.rs tests it).
      ['auth', 'bogus'], ['auth', '', 'x'],
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
      { upstream: { ignoreSwitch: false, switchLocation: 'https://example.invalid/Components/Students/Students.html' } },
      { serve: [['inna_get_overview', { studentKey: '5' }]] },
      { upstream: { switchLocation: 'http://nam.inna.is/other' } },
      { serve: [['inna_get_overview', { studentKey: '5' }]] },
      { upstream: { switchLocation: 'http://nam.inna.is/Components/Students/Students.html', planted: { '/auth/system': { status: 429, headers: { 'retry-after': '120' } } } } },
      { serve: [['inna_get_overview', { studentKey: '5' }], ['inna_get_overview', {}]] },
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
    steps: [{ cli: ['auth', 'status'] }, { cli: ['auth', 'import', '<home>/cookies.json'] }, { cli: ['auth', 'logout'] }],
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
        ['path', cookieFile([{ name: 'XSRF-TOKEN', value: 'v', domain: 'nam.inna.is', path: '/api' }])],
        ['others', cookieFile([{ name: 'other', value: 'v', domain: 'example.invalid', path: '/x' }])],
        ['bom', `\ufeff${COOKIES}`],
      ].flatMap(([name, text]) => [
        { file: `${name}.json`, text: text! },
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
      { upstream: { planted: { '/api/UserData/GetLoggedInUser': { status: 429, headers: { 'retry-after': '120' } } } } },
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
      ...['', '\n', ' 5550000 ', '123\r5550000\n', '555 0000\n', '5550000\u0000\n', '\ufeff5550000\u00a0\n', '５５５００００\n', '5550000\n'].map(
        (stdin) => ({ cli: ['auth', 'login'], stdin }),
      ),
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
      { serve: [['inna_prepare_absence', leave('2040-01-02', '2040-01-05')], ['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { planted: { '/api/RegisterAbsence/GetStudentRegisteredAbsences': { status: 200, body: '[]' } } } },
      { serve: [['inna_prepare_absence', leave('2040-01-02', '2040-01-05')], ['inna_prepare_absence', leave('2040-01-03', '2040-01-05')]], args: WRITES },
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
      { serve: [['inna_prepare_absence', leave('2040-01-03', '2040-01-05')], ['inna_prepare_absence', leave('2040-03-01', '2040-03-02')]], args: WRITES },
      { upstream: { planted: { '/api/RegisterAbsence/GetRegisterAbsences': { status: 500 } } } },
      { serve: [['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { upstream: { planted: { '/api/UserData/GetLoggedInUser': { status: 200, body: '{"x":1}' } } } },
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
      { serve: [submit(), ['inna_prepare_absence', leave('2040-02-01', '2040-02-01', { studentKey: '5' })]], args: WRITES },
      { cli: ['auth', 'logout'] },
      { seed: true },
      { serve: [['inna_absence_status', {}], ['inna_prepare_absence', sick('2040-01-02')]], args: WRITES, swap: true },
    ],
  },
  {
    // Each side submits the preview the other prepared, and each returns the other's result.
    name: 'absence-interop',
    steps: [
      { seed: true },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02', { studentKey: '5' })]], args: WRITES, swap: true },
      { serve: [['inna_absence_status', {}], submit(), ['inna_absence_status', {}]], args: WRITES },
      { serve: [submit(), ['inna_absence_status', {}], ['inna_prepare_absence', leave('2040-02-01', '2040-02-02')]], args: WRITES, swap: true },
    ],
  },
  {
    // An answer without a positive ID leaves the outcome unknown on either side.
    name: 'absence-interop-unknown',
    steps: [
      { seed: true },
      { upstream: clear({ status: 200, body: '{"id":0}' }) },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02', { studentKey: '5' })]], args: WRITES, swap: true },
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
          ['inna_prepare_absence', sick('2040-01-03', { dateTo: '2040-01-02', reason: String.fromCodePoint(0x1f600).repeat(2000) })],
          ['inna_prepare_absence', sick('2040-01-03', { dateTo: '2040-01-02', reason: String.fromCodePoint(0x1f600).repeat(2001) })],
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
      { serve: [submit(), ['inna_absence_status', {}], submit(), ['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
      { clock: NOW + 120_001 },
      { upstream: clear() },
      { serve: [['inna_absence_status', {}], submit(), ['inna_prepare_absence', sick('2040-01-02')]], args: WRITES },
    ],
  },
  {
    // A 429 on prepare's history read writes no preview, and the pause holds until it ends.
    name: 'absence-429-prepare',
    steps: [
      { seed: true },
      { upstream: { planted: { ...clear().planted, '/api/RegisterAbsence/GetLeaves': { status: 429, headers: { 'retry-after': '120' }, body: '' } } } },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02')]], args: WRITES },
      { upstream: clear() },
      { serve: [['inna_prepare_absence', leave('2040-02-01', '2040-02-02')], ['inna_absence_status', {}]], args: WRITES },
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
      { upstream: { planted: { ...clear().planted, '/api/RegisterAbsence/GetLeaves': { status: 429, headers: { 'retry-after': '60' }, body: '' } } } },
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
      { cancel: submit(), by: 'host', when: '/api/RegisterAbsence/GetLeaves', writes: 0, args: WRITES },
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
      { cancel: ['inna_prepare_absence', sick('2040-01-02')], by: 'host', when: '/api/RegisterAbsence/GetLeaves', writes: 0, args: WRITES },
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
      { cancel: submit(), by: 'host', when: '/api/RegisterAbsence/AddNewLeave', writes: 1, args: WRITES },
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
      { cancel: submit(), by: 'stdin', when: '/api/RegisterAbsence/GetLeaves', writes: 0, args: WRITES },
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
      { cancel: submit(), by: 'SIGINT', when: '/api/RegisterAbsence/GetLeaves', writes: 0, args: WRITES },
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
      { cancel: submit(), by: 'SIGTERM', when: '/api/RegisterAbsence/GetLeaves', writes: 0, args: WRITES },
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
    steps: [{ file: storeFile, text: 'x', permissions: 0o644 }, { cli: ['auth', 'status'] }, { cli: ['auth', 'bogus'] }],
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

function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
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
    INNA_TEST_ORIGIN: fake.origin,
    INNA_TEST_NOW: clock,
    ...extra,
  };
}

const other = (side: 'ts' | 'rust') => (side === 'ts' ? 'rust' : 'ts');

/** The operation ID a side's run last prepared, which `<operation>` stands for in its steps. */
let operation: string | undefined;

/** `<operation>` in a call's arguments names the last prepared operation. */
const placed = (args: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(args).replaceAll('<operation>', operation ?? '<operation>'));

/** A result with the prepared operation ID written as `<operation>`. */
function hiddenOperation(result: unknown): unknown {
  const prepared = (result as { structuredContent?: { operationId?: unknown } }).structuredContent?.operationId;

  if (typeof prepared === 'string') operation = prepared;

  return operation ? JSON.parse(JSON.stringify(result).replaceAll(operation, '<operation>')) : result;
}

function command(side: 'ts' | 'rust', args: string[]): string[] {
  return side === 'ts' ? [process.execPath, '--preload', rewrite, cli, ...args] : [rust!, ...args];
}

async function runCli(side: 'ts' | 'rust', home: string, env: Record<string, string>, args: string[], stdin?: string) {
  const child = Bun.spawn(command(side, args), {
    cwd: home,
    env: environment(home, env),
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const hidden = (text: string) => text.replaceAll(home, '<home>');

  return { args: args.map(hidden), code, stdout: hidden(stdout), stderr: hidden(stderr) };
}

async function runServe(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  step: { serve: [string, unknown][]; args?: string[]; surface?: boolean; swap?: boolean },
) {
  const [executable, ...args] = command(step.swap ? other(side) : side, ['serve', ...(step.args ?? [])]);
  const transport = new StdioClientTransport({ command: executable!, args, cwd: home, env: environment(home, env), stderr: 'pipe' });
  const client = new Client({ name: 'inna-parity', version: '1.0.0' });
  const results: unknown[] = [];
  await client.connect(transport);

  if (step.surface) {
    results.push({
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    });
  }

  for (const [name, args] of step.serve) {
    try {
      results.push(hiddenOperation(await client.callTool({ name, arguments: placed(args) })));
    } catch (error) {
      results.push({ protocolError: error instanceof Error ? error.message : String(error) });
    }
  }
  await client.close();

  return results;
}

/** Resolves once the fake has seen a request to `path` after the first `from` requests. */
async function seenPath(path: string, from: number): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (!current.seen.slice(from).some((request) => new URL(request.url).pathname === path)) {
    if (Date.now() > deadline) throw new Error(`Inna never saw ${path}`);

    await Bun.sleep(10);
  }
}

/** A call cancelled while Inna holds the request to `when`; then long enough for that request to
 * answer and anything sent after it to arrive. The host's cancel gives the client's error; the
 * others how the server exited (stdout is not compared: whether a cancelled call still answers
 * is the protocol's business). */
async function runCancel(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  step: { cancel: [string, unknown]; by: 'host' | 'stdin' | 'SIGINT' | 'SIGTERM'; when: string; writes: number; args?: string[] },
) {
  const [executable, ...args] = command(side, ['serve', ...(step.args ?? [])]);
  const settle = (current.state.delays[step.when] ?? 0) + 1000;
  const from = current.seen.length;
  const [name, input] = step.cancel;

  if (step.by === 'host') {
    const transport = new StdioClientTransport({ command: executable!, args, cwd: home, env: environment(home, env), stderr: 'pipe' });
    const client = new Client({ name: 'inna-parity', version: '1.0.0' });
    await client.connect(transport);
    const controller = new AbortController();
    const call = client.callTool({ name, arguments: placed(input) }, { signal: controller.signal });
    await seenPath(step.when, from);
    controller.abort();
    const outcome = await call.then(
      (result) => ({ result: hiddenOperation(result) }),
      (error: unknown) => ({ rejected: error instanceof Error ? error.name : String(error) }),
    );
    await Bun.sleep(settle);
    await client.close();

    return outcome;
  }

  const child = Bun.spawn([executable!, ...args], { cwd: home, env: environment(home, env), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'inna-parity', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: placed(input) } },
  ];
  child.stdin.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''));
  child.stdin.flush();
  await seenPath(step.when, from);

  if (step.by === 'stdin') child.stdin.end();
  else child.kill(step.by);

  const exited = await Promise.race([child.exited, Bun.sleep(settle + 5000).then(() => 'running' as const)]);

  if (exited === 'running') child.kill('SIGKILL');
  else await Bun.sleep(settle);

  if (step.by !== 'stdin') child.stdin.end();
  await output;

  return { exited, signal: child.signalCode };
}

/** Every file and folder under the home with its permissions; contents stay unread. */
function files(home: string, directory = home): unknown[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      const entry = `${path.slice(home.length + 1)} ${(stat.mode & 0o777).toString(8)}`;

      return stat.isDirectory() ? [entry, ...files(home, path)] : [entry];
    });
}

function write(home: string, step: { file: string; text: string; permissions?: number }): void {
  const path = join(home, step.file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, step.text, { mode: step.permissions ?? 0o600 });
  chmodSync(path, step.permissions ?? 0o600);
}

async function run(side: 'ts' | 'rust', scenario: Scenario) {
  const home = join(scratch, scenario.name, side);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const steps: unknown[] = [];
  current = { state: fresh(), seen: [] };
  operation = undefined;
  writeFileSync(clock, String(NOW));
  // `<home>` in arguments and the environment names this side's home.
  const place = (text: string) => text.replaceAll('<home>', home);
  const env = Object.fromEntries(Object.entries(scenario.env ?? {}).map(([name, value]) => [name, place(value)]));

  for (const step of scenario.steps) {
    if ('cli' in step) {
      const result = await runCli(side, home, env, step.cli.map(place), step.stdin);

      if (step.absent && (result.stdout + result.stderr).includes(step.absent))
        failures.push(`${scenario.name} (${side}): printed ${JSON.stringify(step.absent)}: ${JSON.stringify(result)}`);
      steps.push(result);
    }
    else if ('seed' in step) {
      write(home, { file: 'cookies.json', text: COOKIES });
      steps.push(await runCli(side, home, env, ['auth', 'import', join(home, 'cookies.json'), ...(step.args ?? [])]));
    } else if ('legacy' in step) write(home, { file: step.legacy, text: LEGACY });
    else if ('upstream' in step) Object.assign(current.state, step.upstream);
    else if ('clock' in step) writeFileSync(clock, String(step.clock));
    else if ('serve' in step) steps.push(await runServe(side, home, env, step));
    else if ('cancel' in step) {
      steps.push(await runCancel(side, home, env, step));
      const writes = current.seen.filter((request) => request.url.endsWith('/api/RegisterAbsence/AddNewLeave')).length;

      if (writes !== step.writes) failures.push(`${scenario.name} (${side}): ${writes} absence writes, not ${step.writes}`);
    }
    else if ('directory' in step) chmodSync(join(home, step.directory), step.permissions);
    else write(home, step);
  }

  const seen = operation ? JSON.parse(JSON.stringify(current.seen).replaceAll(operation, '<operation>')) : current.seen;

  return { steps, seen, files: existsSync(home) ? files(home) : [] };
}

const failures: string[] = [];

/** CLI runs and tool lists on the TypeScript side, so parity is not vacuous. */
const coverage = { cli: 0, tools: 0, results: 0, requests: 0 };

function compare(name: string, ts: unknown, rs: unknown, path = ''): void {
  if (JSON.stringify(ts) === JSON.stringify(rs)) return;

  if (ts && rs && typeof ts === 'object' && typeof rs === 'object' && Array.isArray(ts) === Array.isArray(rs)) {
    const keys = [...new Set([...Object.keys(ts), ...Object.keys(rs)])];

    if (JSON.stringify(Object.keys(ts)) !== JSON.stringify(Object.keys(rs)))
      failures.push(`${name}${path}: keys ${JSON.stringify(Object.keys(ts))} != ${JSON.stringify(Object.keys(rs))}`);

    for (const key of keys)
      compare(name, (ts as Record<string, unknown>)[key], (rs as Record<string, unknown>)[key], `${path}.${key}`);

    return;
  }
  // Long texts are shown from just before where they first differ.
  let from = 0;

  if (typeof ts === 'string' && typeof rs === 'string')
    while (from < ts.length && ts[from] === rs[from]) from += 1;
  const clip = (value: unknown) => String(JSON.stringify(value)).slice(Math.max(0, from - 200), from + 400);
  failures.push(`${name}${path}:\n  ts:   ${clip(ts)}\n  rust: ${clip(rs)}`);
}

try {
  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const ts = await run('ts', scenario);
    const text = JSON.stringify(ts.steps);
    coverage.cli += text.split('"code":').length - 1;
    coverage.tools += text.split('"inputSchema"').length - 1;
    coverage.results += text.split('"structuredContent"').length - 1;
    coverage.requests += ts.seen.length;
    compare(scenario.name, ts, await run('rust', scenario));
  }
} finally {
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (!only && (coverage.cli < 150 || coverage.tools < 44 || coverage.results < 119 || coverage.requests < 558))
  failures.push(`coverage too low: ${JSON.stringify(coverage)}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify(coverage)}`);
