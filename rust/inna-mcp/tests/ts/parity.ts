// TypeScript-versus-Rust parity for inna-mcp, driven by tests/parity.rs. Each scenario runs once
// against the TypeScript CLI (with rewrite.ts preloaded) and once against the Rust binary (built
// with `test-origin`), each in its own scratch home, against the same fake Inna (fake-inna.ts) and
// clock, and compares outputs, exit codes, the requests Inna saw and the files left behind, with
// the home path written as <home>. Prints mismatches and exits 1 on any.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { cookieExportSchema, sessionJar } from '../../../../packages/inna-mcp/src/client.js';
import { COOKIES, fresh, startFake, type Seen, type State } from './fake-inna.ts';

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
  | { cli: string[]; stdin?: string }
  // Each side's `auth import` of the synthetic cookie export.
  | { seed: true; args?: string[] }
  // An older version's plaintext session file at this path under the home.
  | { legacy: string }
  | { upstream: Partial<State> }
  | { clock: number }
  | { serve: [string, unknown][]; args?: string[]; surface?: boolean }
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
  step: { serve: [string, unknown][]; args?: string[]; surface?: boolean },
) {
  const [executable, ...args] = command(side, ['serve', ...(step.args ?? [])]);
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
      results.push(await client.callTool({ name, arguments: args as Record<string, unknown> }));
    } catch (error) {
      results.push({ protocolError: error instanceof Error ? error.message : String(error) });
    }
  }
  await client.close();

  return results;
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
  writeFileSync(clock, String(NOW));
  // `<home>` in arguments and the environment names this side's home.
  const place = (text: string) => text.replaceAll('<home>', home);
  const env = Object.fromEntries(Object.entries(scenario.env ?? {}).map(([name, value]) => [name, place(value)]));

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(side, home, env, step.cli.map(place), step.stdin));
    else if ('seed' in step) {
      write(home, { file: 'cookies.json', text: COOKIES });
      steps.push(await runCli(side, home, env, ['auth', 'import', join(home, 'cookies.json'), ...(step.args ?? [])]));
    } else if ('legacy' in step) write(home, { file: step.legacy, text: LEGACY });
    else if ('upstream' in step) Object.assign(current.state, step.upstream);
    else if ('clock' in step) writeFileSync(clock, String(step.clock));
    else if ('serve' in step) steps.push(await runServe(side, home, env, step));
    else if ('directory' in step) chmodSync(join(home, step.directory), step.permissions);
    else write(home, step);
  }

  return { steps, seen: current.seen, files: existsSync(home) ? files(home) : [] };
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

if (!only && (coverage.cli < 106 || coverage.tools < 44 || coverage.results < 78 || coverage.requests < 328))
  failures.push(`coverage too low: ${JSON.stringify(coverage)}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify(coverage)}`);
