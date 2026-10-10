// TypeScript-versus-Rust parity for infomentor-mcp, driven by tests/parity.rs. Each scenario runs
// once against the TypeScript CLI (with rewrite.ts preloaded) and once against the Rust binary
// (built with `test-origin`), each in its own scratch home and against the same local fake
// upstream, and compares outputs and exit codes. Prints mismatches and exits 1 on any.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CookieJar } from 'tough-cookie';

import { captureSession } from '../../../../packages/infomentor-mcp/src/session.js';

const [rust, only] = process.argv.slice(2);

if (!rust) throw new RangeError('Usage: parity.ts RUST_BINARY [SCENARIO]');

// Both sides keep their store in each scenario's scratch home through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError(
    'Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.',
  );
const repo = resolve(import.meta.dir, '../../../..');
const cli = join(repo, 'packages/infomentor-mcp/src/cli.ts');
const rewrite = join(import.meta.dir, 'rewrite.ts');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'infomentor-parity-'));

const PARENT = 'https://minn.infomentor.is/';

/** What the fake records of each request: the headers both sides must agree on, and the body. */
type Seen = { method: string; url: string; headers: Record<string, string | null>; body: string };

const COMPARED_HEADERS = ['accept', 'content-type', 'cookie', 'origin', 'referer', 'user-agent'];

/** The fake InfoMentor's state for one side's run of a scenario. */
type State = {
  selected: string;
  ignoreSwitch: boolean;
  overrideUrl: string;
  failTimetable: boolean;
  oddItems: boolean;
  body: string;
  /** How the parent page answers instead of the school data. */
  parent:
    | 'ok'
    | 'rotate'
    | 'challenge'
    | 'large'
    | 'cross-origin'
    | 'loop'
    | 'no-location'
    | '401'
    | '403'
    | '429'
    | '429-date'
    | '429-bare';
  rotated: boolean;
};

const initial = (): State => ({
  selected: 'child-1',
  ignoreSwitch: false,
  overrideUrl: '',
  failTimetable: false,
  oddItems: false,
  body: 'Bring lunch',
  parent: 'ok',
  rotated: false,
});

const fake = { seen: [] as Seen[], state: initial() };

function reset(state: Partial<State> = {}): void {
  fake.seen = [];
  fake.state = { ...initial(), ...state };
}

const pupils = [
  { id: 'child-1', name: 'Synthetic child' },
  { id: 'child-2 & sibling', name: 'Synthetic sibling' },
];

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

const summary = {
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

const redirect = (location: string, cookie?: string, status = 302): Response =>
  new Response(null, {
    status,
    headers: cookie ? { Location: location, 'Set-Cookie': cookie } : { Location: location },
  });

function parentPage(state: State): Response {
  const model = {
    account: {
      currentUser: { id: 'parent-1' },
      pupils: pupils.map((pupil, index) => ({
        ...pupil,
        selected: pupil.id === state.selected,
        switchPupilUrl: state.overrideUrl || `/Account/PupilSwitcher/SwitchPupil/${101 + index}`,
        extra: index,
      })),
    },
    apps: [{ codeName: 'timetable' }, { codeName: 'messages' }],
  };

  return new Response(
    `<html><head><title>InfoMentor</title></head><body><script>var x = "</div>";</script><script>IMHome.home.homeData = ${JSON.stringify(model)}; IMHome.home.init(IMHome.home.homeData);</script></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** The fake upstream: `<origin>/<host><path>` stands for `https://<host><path>`. */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const [, host = ''] = url.pathname.split('/');

  // Other processes probe loopback ports; only InfoMentor's hosts are recorded.
  if (!host.endsWith('infomentor.is')) return new Response(null, { status: 404 });
  const path = url.pathname.slice(host.length + 1);
  const body = await request.text();
  const headers = Object.fromEntries(
    COMPARED_HEADERS.map((name) => [name, request.headers.get(name)]),
  );
  fake.seen.push({
    method: request.method,
    url: `https://${host}${path}${url.search}`,
    headers,
    body,
  });
  const state = fake.state;
  const cookies = request.headers.get('cookie') ?? '';
  const fields = new URLSearchParams(body);

  if (host !== 'minn.infomentor.is') return new Response('Not found', { status: 404 });

  if (/^\/authentication\/authentication\/login$/i.test(path))
    return new Response('<form method="post"><input type="hidden" name="a" value="b"></form>');

  if (!/(?:^|; )IMHome=(?:synthetic|rotated)(?:;|$)/.test(cookies))
    return redirect(`${PARENT}authentication/authentication/login`);

  if (path === '/' && request.method === 'GET') {
    switch (state.parent) {
      case 'rotate':
        if (state.rotated) break;
        state.rotated = true;

        return new Response(parentPage(state).body, {
          headers: {
            'Set-Cookie':
              'IMHome=rotated; Secure; HttpOnly; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
          },
        });
      case 'challenge':
        return new Response('<html><head><title> Just a moment...</title></head></html>', {
          status: 403,
        });
      case 'large':
        return new Response('a'.repeat(8 * 1024 * 1024 + 1));
      case 'cross-origin':
        return redirect('https://example.com/');
      case 'loop':
        return redirect(PARENT);
      case 'no-location':
        return new Response(null, { status: 302 });
      case '401':
        return new Response('denied', { status: 401 });
      case '403':
        return new Response('denied', { status: 403 });
      case '429':
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '7200' } });
      case '429-date':
        return new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': new Date(Date.now() + 20 * 60_000).toUTCString() },
        });
      case '429-bare':
        return new Response('slow down', { status: 429 });
      case 'ok':
        break;
    }

    return parentPage(state);
  }

  const switched = /^\/Account\/PupilSwitcher\/SwitchPupil\/(101|102)$/.exec(path);

  if (switched) {
    const pupil = pupils[Number(switched[1]) - 101]!;

    if (!state.ignoreSwitch) state.selected = pupil.id;

    return redirect(
      PARENT,
      `selectedChild=${encodeURIComponent(state.selected)}; Secure; HttpOnly; Path=/`,
    );
  }

  if (path === '/timetable/timetable/appData') {
    if (state.failTimetable) return new Response('private-upstream-value', { status: 500 });
    const timetable = state.selected === 'child-1' ? entry : { ...entry, title: 'Sund' };

    return Response.json({
      items: state.oddItems
        ? [{ ...timetable, establishmentName: null }, { ...timetable, title: null }, timetable]
        : [timetable, { ...timetable, start: '2026-09-11T08:00:00', title: 'Ábyrgð' }],
    });
  }

  if (path === '/Message/message/GetMessages') {
    if (fields.get('messageText') === 'malformed')
      return new Response('{"items":"private-upstream-value"}');
    const item = state.oddItems
      ? { ...summary, sentUser: { ...summary.sentUser, displayName: null } }
      : summary;
    const inbox = fields.get('inbox') === 'true';
    const page = Number(fields.get('page'));
    const items: unknown[] = inbox ? [{ ...item, id: 40 + page }] : [{ ...item, id: 90 }];

    if (state.oddItems) items.push({ ...item, id: 'invalid' });

    return Response.json({ items, page: 0, more: inbox && page === 1, extra: true });
  }

  if (path === '/Message/message/GetMessage') {
    const id = Number(fields.get('id'));

    return Response.json({
      ...summary,
      id,
      sentUser: state.oddItems ? { ...summary.sentUser, displayName: null } : summary.sentUser,
      messageBody: '<p>Bring lunch</p>',
      messageBodyPlainText: id === 41 ? state.body : `Body ${id}`,
      toUsers: [{ id: 13, displayName: state.oddItems ? null : 'Synthetic parent' }],
      messageFolder: id === 90 ? 'Sent' : 'Inbox',
    });
  }

  if (path === '/NotificationApp/NotificationApp/appData') {
    const feed: unknown[] = notifications.map((item) => ({
      ...item,
      currentlySelectedPupil:
        state.selected === 'child-1' ? item.currentlySelectedPupil : !item.currentlySelectedPupil,
    }));

    if (state.oddItems) {
      feed.push({ ...notifications[0], id: 5, state: 'FutureState' });
      feed.push({ ...notifications[0], id: 'invalid' });
    }

    return Response.json({ notifications: feed });
  }

  return new Response('Not found', { status: 404 });
}

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
const origin = `http://127.0.0.1:${server.port}`;

/** A tool call, with arguments built from earlier results when needed, or a change upstream. */
type Call = [string, unknown] | ((state: State) => void);

type Step = { cli: string[] } | { serve: Call[]; args?: string[]; surface?: boolean };

type Scenario = {
  name: string;
  env?: Record<string, string>;
  state?: Partial<State>;
  /** The legacy session file both sides start from, in each home as session.json. */
  seed?: string;
  steps: Step[];
};

/** A legacy plaintext session for `IMHome=<value>`, as an older version saved it. */
async function seed(value: string): Promise<string> {
  const jar = new CookieJar();
  await jar.setCookie(`IMHome=${value}; Secure; HttpOnly; Path=/`, PARENT);
  await jar.setCookie('lang=is; Path=/; Domain=infomentor.is', PARENT);

  return JSON.stringify(captureSession(jar));
}

const SYNTHETIC = await seed('synthetic');

const EXPIRED = await seed('expired');

const SESSION = ['serve', '--session', 'session.json'];

/** The cursor an earlier collection returned, `back` results ago. */
const cursor =
  (back = 1) =>
  (results: unknown[]): unknown =>
    (results.at(-back) as { structuredContent?: { cursor?: string } }).structuredContent?.cursor;

// No `--` cases: `bun cli.ts -- x` drops the `--` before the CLI sees it, while the released
// executable (and the Rust binary) passes it to parseArgs; main.rs's unit tests cover it.
const cliCases = [
  ['--help'],
  ['-h'],
  ['--version'],
  ['-v'],
  ['-hv'],
  ['--nope'],
  ['--help=1'],
  ['--allow-setup-tools=yes'],
  ['--local-form'],
  ['--local-form=1'],
  ['--session'],
  ['--session', '-x'],
  ['--timeout', '-1'],
  ['-x'],
  ['auth'],
  ['auth', 'login', 'x'],
  ['a', 'b'],
  ['nope'],
  ['auth', 'nope'],
  ['auth', 'serve', 'x'],
  ['status', '--timeout', '5'],
  ['migrate', '--import', 'x'],
  ['logout', '--allow-account-change'],
  ['nope', '--timeout', '5'],
  ['login', '--allow-setup-tools'],
  ['status', '--allow-setup-tools', '--timeout', '5'],
  ['login', '--import', 'a', '--credentials', 'b'],
  ['auth', 'login', '--import=a', '--credentials=b', '--timeout=1'],
  ['login', '--timeout', '0'],
  ['login', '--timeout=1.5'],
  ['login', '--timeout='],
  ['login', '--timeout', '3601'],
  ['login', '--timeout', 'abc'],
  ['login', '--timeout', 'Infinity'],
  ['auth', 'login', '--timeout', '0x0'],
  ['status'],
  ['auth', 'status', '--session', 'missing.json'],
];

const scenarios: Scenario[] = [
  {
    name: 'surface',
    steps: [
      { serve: [], surface: true },
      { serve: [], args: ['--allow-setup-tools'], surface: true },
      { serve: [], args: ['auth', 'serve'], surface: true },
    ],
  },
  { name: 'cli', steps: cliCases.map((args) => ({ cli: args })) },
  {
    name: 'no-session',
    steps: [
      {
        serve: [
          ['infomentor_session_status', {}],
          ['infomentor_get_overview', {}],
          ['infomentor_collect_updates', {}],
        ],
        args: SESSION,
      },
      { cli: ['status', '--session', 'session.json'] },
    ],
  },
  {
    name: 'reads',
    seed: SYNTHETIC,
    steps: [
      { cli: ['status', '--session', 'session.json'] },
      {
        serve: [
          ['infomentor_session_status', {}],
          ['infomentor_get_overview', {}],
          ['infomentor_get_messages', {}],
          [
            'infomentor_get_messages',
            { folder: 'sent', search: 'Skólaferð & nesti', page: 2, pageSize: 1 },
          ],
          ['infomentor_get_messages', { search: 'malformed' }],
          ['infomentor_get_message', { id: 41 }],
          ['infomentor_get_notifications', {}],
          ['infomentor_get_notifications', { selectedChildOnly: true, includeCleared: true }],
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          ['infomentor_get_overview', {}],
          ['infomentor_get_notifications', { selectedChildOnly: true }],
          ['infomentor_select_child', { childId: 'missing' }],
          ['infomentor_select_child', { childId: 'child-1' }],
        ],
        args: SESSION,
      },
      { cli: ['status', '--session', 'session.json'] },
    ],
  },
  {
    name: 'invalid-input',
    seed: SYNTHETIC,
    steps: [
      {
        serve: [
          ['infomentor_get_message', { id: 0 }],
          ['infomentor_get_message', { id: 1.5 }],
          ['infomentor_get_message', { id: '41' }],
          [
            'infomentor_get_messages',
            { folder: 'x', search: 'a'.repeat(501), page: 0, pageSize: 101, z: 1 },
          ],
          ['infomentor_get_messages', { page: 100_001, pageSize: 0.5 }],
          ['infomentor_select_child', {}],
          ['infomentor_select_child', { childId: 'x'.repeat(1025) }],
          ['infomentor_collect_updates', { cursor: 'x', maxMessagePages: 0 }],
          ['infomentor_collect_updates', { cursor: 5, includeExisting: 'yes' }],
          ['infomentor_get_overview', { x: 1 }],
          ['infomentor_get_notifications', { includeCleared: 'yes', selectedChildOnly: null }],
          ['infomentor_session_status', { b: 1, a: 2 }],
        ],
        args: SESSION,
      },
    ],
  },
  {
    name: 'malformed-items',
    seed: SYNTHETIC,
    state: { oddItems: true },
    steps: [
      {
        serve: [
          ['infomentor_get_overview', {}],
          ['infomentor_get_messages', {}],
          ['infomentor_get_message', { id: 41 }],
          ['infomentor_get_notifications', { includeCleared: true }],
          ['infomentor_collect_updates', { includeExisting: true }],
        ],
        args: SESSION,
      },
    ],
  },
  {
    name: 'collect',
    seed: SYNTHETIC,
    steps: [
      {
        serve: [
          ['infomentor_collect_updates', {}],
          ['infomentor_collect_updates', cursor()],
          ['infomentor_collect_updates', { includeExisting: true, maxMessagePages: 2 }],
          (state) => {
            state.body = 'Changed body';
          },
          ['infomentor_collect_updates', cursor(3)],
          ['infomentor_collect_updates', cursor(4)],
          ['infomentor_collect_updates', cursor()],
          ['infomentor_collect_updates', { maxMessagePages: 1 }],
          ['infomentor_collect_updates', { cursor: '00000000-0000-0000-0000-000000000000' }],
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          ['infomentor_collect_updates', {}],
          ['infomentor_get_overview', {}],
        ],
        args: SESSION,
      },
    ],
  },
  {
    name: 'cookie-rotation',
    seed: SYNTHETIC,
    state: { parent: 'rotate' },
    steps: [
      {
        serve: [
          ['infomentor_get_overview', {}],
          ['infomentor_get_overview', {}],
        ],
        args: SESSION,
      },
      { cli: ['status', '--session', 'session.json'] },
    ],
  },
  {
    name: 'expired',
    seed: EXPIRED,
    steps: [
      {
        serve: [
          ['infomentor_session_status', {}],
          ['infomentor_get_overview', {}],
        ],
        args: SESSION,
      },
      { cli: ['status', '--session', 'session.json'] },
    ],
  },
  {
    name: 'rate-limited',
    seed: SYNTHETIC,
    state: { parent: '429' },
    steps: [
      {
        serve: [
          ['infomentor_get_overview', {}],
          ['infomentor_get_overview', {}],
          ['infomentor_session_status', {}],
        ],
        args: SESSION,
      },
      { cli: ['status', '--session', 'session.json'] },
    ],
  },
  ...(
    [
      'challenge',
      'large',
      'cross-origin',
      'loop',
      'no-location',
      '401',
      '403',
      '429-date',
      '429-bare',
    ] as const
  ).map((parent): Scenario => ({
    name: `parent-${parent}`,
    seed: SYNTHETIC,
    state: { parent },
    steps: [
      {
        serve: [
          ['infomentor_get_overview', {}],
          ['infomentor_session_status', {}],
        ],
        args: SESSION,
      },
    ],
  })),
  {
    name: 'timetable-error',
    seed: SYNTHETIC,
    state: { failTimetable: true },
    steps: [
      {
        serve: [
          ['infomentor_get_overview', {}],
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          ['infomentor_collect_updates', {}],
        ],
        args: SESSION,
      },
    ],
  },
  {
    name: 'switch-refused',
    seed: SYNTHETIC,
    state: { overrideUrl: '/Account/PupilSwitcher/SwitchPupil/102?next=1' },
    steps: [
      {
        serve: [
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          (state) => {
            state.overrideUrl = 'https://im1.infomentor.is/Account/PupilSwitcher/SwitchPupil/102';
          },
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          (state) => {
            state.overrideUrl = '';
            state.ignoreSwitch = true;
          },
          ['infomentor_select_child', { childId: 'child-2 & sibling' }],
          ['infomentor_collect_updates', {}],
        ],
        args: SESSION,
      },
    ],
  },
];

function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    INFOMENTOR_TEST_ORIGIN: origin,
    ...extra,
  };
}

function command(side: 'ts' | 'rust', args: string[]): string[] {
  return side === 'ts' ? [process.execPath, '--preload', rewrite, cli, ...args] : [rust!, ...args];
}

async function runCli(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  args: string[],
) {
  const child = Bun.spawn(command(side, args), {
    cwd: home,
    env: environment(home, env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { args, code, stdout, stderr };
}

async function runServe(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  step: { serve: Call[]; args?: string[]; surface?: boolean },
) {
  const [executable, ...args] = command(side, step.args ?? ['serve']);
  const transport = new StdioClientTransport({
    command: executable!,
    args,
    cwd: home,
    env: environment(home, env),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'infomentor-parity', version: '1.0.0' });
  const results: unknown[] = [];
  await client.connect(transport);

  if (step.surface) {
    const { tools } = await client.listTools();
    surfaces.push(tools.length);
    results.push({
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools,
    });
  }

  for (const call of step.serve) {
    if (typeof call === 'function') {
      call(fake.state);
      continue;
    }
    const [name, input] = call;
    const parameters = (typeof input === 'function' ? { cursor: input(results) } : input) as Record<
      string,
      unknown
    >;

    try {
      const result = await client.callTool({ name, arguments: parameters });
      results.push(result);

      if (side === 'ts' && !result.isError) served++;
    } catch (error) {
      results.push({ protocolError: error instanceof Error ? error.message : String(error) });
    }
  }
  await client.close();

  return results;
}

/** The session file a scenario left, or null. */
function session(home: string): unknown {
  const path = join(home, 'session.json');

  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Times and random cursors differ between runs: times are masked, and each cursor becomes its
 * order of first appearance, so equal cursors stay equal and new ones stay new. */
function masker(): (value: unknown) => unknown {
  const cursors = new Map<string, string>();
  const TIMES = new Set(['retrievedAt', 'savedAt', 'creation', 'lastAccessed']);

  const mask = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (TIMES.has(key)) return '<time>';

      // The pause InfoMentor asked for, capped at an hour: compared to the nearest ten minutes.
      if (key === 'rateLimitedUntil')
        return `<now + ${Math.round((Date.parse(value) - Date.now()) / 600_000) * 10} min>`;

      if (key === 'cursor') {
        if (!cursors.has(value)) cursors.set(value, `<cursor ${cursors.size + 1}>`);

        return cursors.get(value);
      }

      if (key === 'text' && /^[[{]/.test(value)) {
        try {
          return JSON.stringify(mask(JSON.parse(value)));
        } catch {
          return value;
        }
      }

      return value;
    }

    if (Array.isArray(value)) return value.map((item) => mask(item));

    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, mask(item, name)]),
      );

    return value;
  };

  return (value) => mask(value);
}

async function run(side: 'ts' | 'rust', scenario: Scenario) {
  const home = join(scratch, scenario.name, side);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  reset(scenario.state);

  if (scenario.seed) writeFileSync(join(home, 'session.json'), scenario.seed, { mode: 0o600 });
  const steps: unknown[] = [];

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(side, home, scenario.env ?? {}, step.cli));
    else steps.push(await runServe(side, home, scenario.env ?? {}, step));
  }

  if (side === 'ts') requests += fake.seen.length;

  return masker()({ steps, requests: fake.seen, session: session(home) });
}

const failures: string[] = [];

/** Tool counts the servers listed, so the surface comparison is not vacuous. */
const surfaces: number[] = [];

/** CLI runs on the TypeScript side. */
let commands = 0;

/** Successful tool calls and upstream requests on the TypeScript side. */
let served = 0;

let requests = 0;

function compare(name: string, ts: unknown, rs: unknown, path = ''): void {
  if (JSON.stringify(ts) === JSON.stringify(rs)) return;

  if (
    ts &&
    rs &&
    typeof ts === 'object' &&
    typeof rs === 'object' &&
    Array.isArray(ts) === Array.isArray(rs)
  ) {
    const keys = [...new Set([...Object.keys(ts), ...Object.keys(rs)])];

    if (JSON.stringify(Object.keys(ts)) !== JSON.stringify(Object.keys(rs)))
      failures.push(
        `${name}${path}: keys ${JSON.stringify(Object.keys(ts))} != ${JSON.stringify(Object.keys(rs))}`,
      );

    for (const key of keys)
      compare(
        name,
        (ts as Record<string, unknown>)[key],
        (rs as Record<string, unknown>)[key],
        `${path}.${key}`,
      );

    return;
  }
  const clip = (value: unknown) => String(JSON.stringify(value)).slice(0, 600);
  failures.push(`${name}${path}:\n  ts:   ${clip(ts)}\n  rust: ${clip(rs)}`);
}

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean };

/** The TypeScript server and the Rust binary in turn on one home, session file and cursor
 * directory: each continues from what the other saved. */
async function interop(): Promise<void> {
  const home = join(scratch, 'interop');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  reset({ parent: 'rotate' });
  writeFileSync(join(home, 'session.json'), SYNTHETIC, { mode: 0o600 });
  const call = async (side: 'ts' | 'rust', name: string, input: unknown) =>
    ((await runServe(side, home, {}, { serve: [[name, input]], args: SESSION })) as Result[])[0]!;
  const check = (what: string, ok: boolean, value: unknown) => {
    if (!ok) failures.push(`interop: ${what}: ${JSON.stringify(value).slice(0, 600)}`);
  };

  // Rust rotates the cookie and saves it; TypeScript reads with the rotated session.
  const overview = await call('rust', 'infomentor_get_overview', {});
  check('rust overview', !overview.isError, overview);
  const seen = fake.seen.length;
  const status = await call('ts', 'infomentor_session_status', {});
  check('ts status after rust rotation', status.structuredContent?.authenticated === true, status);
  check(
    'ts sends the cookie rust saved',
    fake.seen.slice(seen).every((request) => request.headers.cookie?.includes('IMHome=rotated')),
    fake.seen.slice(seen),
  );

  const baseline = await call('ts', 'infomentor_collect_updates', {});
  const first = baseline.structuredContent?.cursor;
  const same = await call('rust', 'infomentor_collect_updates', { cursor: first });
  check(
    'rust replays a typescript cursor unchanged',
    same.structuredContent?.baseline === false &&
      same.structuredContent?.cursor === first &&
      JSON.stringify(same.structuredContent?.updates) === '[]' &&
      JSON.stringify(same.structuredContent?.missing) === '[]',
    same,
  );
  fake.state.body = 'Changed body';
  const delta = await call('rust', 'infomentor_collect_updates', { cursor: first });
  const updates = delta.structuredContent?.updates as { sourceId: string }[] | undefined;
  check(
    'rust reports the changed message',
    delta.structuredContent?.cursor !== first &&
      updates?.length === 1 &&
      updates[0]?.sourceId === '41',
    delta,
  );
  const accepted = await call('ts', 'infomentor_collect_updates', {
    cursor: delta.structuredContent?.cursor,
  });
  check(
    'typescript accepts a rust cursor unchanged',
    accepted.structuredContent?.cursor === delta.structuredContent?.cursor &&
      JSON.stringify(accepted.structuredContent?.updates) === '[]',
    accepted,
  );
}

try {
  if (!only) await interop();

  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const ts = await run('ts', scenario);
    commands += scenario.steps.filter((step) => 'cli' in step).length;
    compare(scenario.name, ts, await run('rust', scenario));
  }
} finally {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

const counts = { surfaces, commands, served, requests };

// Each side listed the 7 default tools, and all 11 with --allow-setup-tools; the reads succeeded
// and reached the fake upstream.
if (
  !only &&
  (JSON.stringify(surfaces) !== '[7,11,7,7,11,7]' ||
    commands < cliCases.length ||
    served < 30 ||
    requests < 100)
)
  failures.push(`coverage too low: ${JSON.stringify(counts)}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify(counts)}`);
