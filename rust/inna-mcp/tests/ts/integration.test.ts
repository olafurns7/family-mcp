// packages/inna-mcp/test/integration.test.ts against the Rust binary, run by tests/typescript.rs
// from packages/inna-mcp. Changed only where a case injects into the TypeScript process: the
// drop-ins of ./rust-inna.ts run the binary instead, and each other change is marked `Rust:`.
// The store helpers, an import, and the session changes stay TypeScript: they set up and inspect
// the files the two languages share.
//
// Rust: not here: these drive the TypeScript scheduler or SDK runtime directly, which the binary
// does not share; src/keep_alive.rs and the stdio runtime's own tests cover the binary's, and
// src/input.rs and src/html.rs test the pure functions:
//   'keep-alive ticks never overlap, and stop cancels the timer and aborts the request in flight'
//   'the default keep-alive timer waits one interval and stops firing after stop'
//   'an output stream error or close stops the timer, aborts the tick in flight, and leaves no listener'
//   'discovery followed by a legacy initialize keeps the keep-alive running on the live connection'
//   'a broken output pipe under the real stdio runtime cancels the timer and aborts the tick in flight'
//   'input the SDK rejects closes the wire, cancels the timer, and aborts the tick in flight'
//   'keep-alive suspends with its last server, resumes with the next, and never after stop'
//   'dates and plain text fail safely on malformed inputs'
import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import {
  mkdtemp,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { SafeError } from '@family-mcp/mcp-runtime';
import { LocalKeyFileProvider } from '@family-mcp/session-store';
import {
  MAX_SESSION_BYTES,
  RECORD_MAX_BYTES,
  savedSchema,
  type KeepAlive,
} from '../../../../packages/inna-mcp/src/client.js';
import { startKeepAlive } from '../../../../packages/inna-mcp/src/keep-alive.js';
import { InnaClient, serveStdio } from './rust-inna.js';
// Rust: the harness copy, whose `spawnLogin` starts the binary.
import {
  browserEnvironment,
  collectProcess,
  makeFakeBrowser,
  makePreload,
  makeTestDirectory,
  spawnLogin,
  START_MESSAGE,
  stopChild,
  storeHome,
} from './browser-harness.js';
import {
  filesContaining,
  readStored,
  resetStored,
  storeAt,
  storeEnvironment,
  updateStored,
  type Store,
} from '../../../../packages/inna-mcp/test/scratch.js';
import {
  absencePreviewSchema,
  absenceRecordSchema,
  type User,
} from '../../../../packages/inna-mcp/src/schemas.js';

const NOW = Date.parse('2040-01-02T12:00:00Z');

const directories: string[] = [];

const request = {
  kind: 'sick',
  dateFrom: '2040-01-02',
  dateTo: '2040-01-02',
  reason: 'Synthetic reason',
} satisfies Parameters<InnaClient['prepareAbsence']>[0];

const student: User = {
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

const sibling: User = {
  ...student,
  userId: 5,
  studentId: '6',
  schoolId: '8',
  studentName: 'Synthetic sibling',
  schoolLong: 'Synthetic second school',
};

const SIBLING = '5';

const range = { dateFrom: '2040-01-02', dateTo: '2040-01-03' };

// Decoys for the access fields that must never reach a tool result or the session file.
const hidden = {
  kennitala: '9999999999',
  notandi_id: '8888888',
  url_login: 'https://nam.inna.is/auth/token?token=DO-NOT-RETURN',
};

function expectClean(text: string): void {
  for (const decoy of ['9999999999', '8888888', 'DO-NOT-RETURN', 'auth/token'])
    expect(text).not.toContain(decoy);
}

type AccessEntry = { system: string; status: string; skoli_id?: string; skoli_heiti: string };

class Provider {
  readonly calls: { url: URL; method: string; body: string | undefined }[] = [];
  posts = 0;
  failPost = false;
  redirect = false;
  rateLimit = false;
  ignoreSwitch = false;
  switchRateLimit = false;
  unauthorized = false;
  switchUnauthorized = false;
  rotation = 'synthetic-rotated';
  numeric = false;
  switchLocation = 'http://nam.inna.is/Components/Students/Students.html';
  switches = 0;
  user = student;
  selected = '1';
  order = ['1', SIBLING, '9'];
  contexts = new Map([
    ['1', student],
    [SIBLING, sibling],
  ]);

  // Live shape: digit strings, no id key. The last entry is another Inna application.
  entries = new Map<string, AccessEntry>([
    ['1', { system: '1', status: '1', skoli_id: '3', skoli_heiti: 'Synthetic school' }],
    [SIBLING, { system: '1', status: '2', skoli_id: '8', skoli_heiti: 'Synthetic second school' }],
    ['9', { system: '2', status: '1', skoli_id: '3', skoli_heiti: 'Synthetic school' }],
  ]);

  access() {
    return this.order.map((key) => {
      const entry = this.entries.get(key);
      const on = key === this.selected;

      return {
        ...hidden,
        ...entry,
        userId: this.numeric ? Number(key) : key,
        system: this.numeric ? Number(entry?.system) : entry?.system,
        loggedIn: this.numeric ? on : on ? '1' : '0',
        isStudent: '1',
        virkur: '1',
        adgangur: '1',
        nafn: this.contexts.get(key)?.studentName ?? 'Synthetic staff',
        title: 'Synthetic role',
        tegund: 'Synthetic kind',
        skoli_audk: 'SYN',
        showPersonalInfoConfirmationModal: false,
      };
    });
  }

  paths(from = 0): string[] {
    return this.calls.slice(from).map((call) => call.url.pathname);
  }

  private switchStudent(url: URL, headers: Headers, options: RequestInit): Response {
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
    expect(headers.get('X-Requested-By')).toBeNull();
    expect(headers.get('X-XSRF-TOKEN')).toBeNull();
    expect(headers.get('Authorization')).toBeNull();
    this.switches += 1;

    if (this.switchRateLimit)
      return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });

    if (this.switchUnauthorized) return new Response(null, { status: 401 });
    const key = this.order[Number(url.searchParams.get('i'))];
    const entry = key === undefined ? undefined : this.entries.get(key);

    expect([...url.searchParams.keys()]).toEqual(['i', 'system', 'status', 'user_id']);
    expect(url.searchParams.get('system')).toBe('1');
    expect(url.searchParams.get('system')).toBe(String(entry?.system));
    expect(url.searchParams.get('status')).toBe(String(entry?.status));
    expect(url.searchParams.get('user_id')).toBe(key ?? '');

    if (key !== undefined && !this.ignoreSwitch) {
      this.selected = key;
      this.user = this.contexts.get(key) ?? this.user;
    }

    return new Response('<html>Synthetic redirect</html>', {
      status: 303,
      headers: {
        Location: this.switchLocation,
        'Set-Cookie': `SESSION=synthetic-switched-${this.switches}; Path=/; Secure; HttpOnly`,
      },
    });
  }

  fetch = async (value: string, options: RequestInit): Promise<Response> => {
    const url = new URL(value);
    expect(url.origin).toBe('https://nam.inna.is');
    expect(options.redirect).toBe('manual');
    const headers = new Headers(options.headers);
    expect(headers.get('Cookie')).toContain('SESSION=synthetic-');
    this.calls.push({
      url,
      method: options.method ?? 'GET',
      body: z.string().optional().parse(options.body),
    });

    if (url.pathname === '/auth/system') return this.switchStudent(url, headers, options);

    if (url.pathname === '/Components/Students/Students.html')
      return new Response('<html>Synthetic application</html>', {
        headers: { 'Content-Type': 'text/html' },
      });
    expect(url.pathname.startsWith('/api/')).toBe(true);
    expect(headers.get('X-Requested-By')).toBe('XMLHttpRequest');
    expect(headers.get('X-XSRF-TOKEN')).toBe('synthetic-xsrf');

    if (this.redirect)
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://example.invalid/credential-trap' },
      });

    if (this.rateLimit)
      return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });

    if (this.unauthorized) return new Response(null, { status: 401 });

    if (url.pathname === '/api/UserData/GetLoggedInUser')
      return Response.json(
        {
          ...this.user,
          access: this.access(),
          studentIdNumber: 'DO-NOT-RETURN',
          privateToken: 'DO-NOT-RETURN',
        },
        { headers: { 'Set-Cookie': `SESSION=${this.rotation}; Path=/; Secure; HttpOnly` } },
      );

    if (url.pathname === '/api/RegisterAbsence/AddNewLeave') {
      this.posts += 1;
      expect(options.method).toBe('POST');

      if (this.failPost) throw new Error('Synthetic lost response');

      return Response.json({ id: 123 });
    }

    switch (url.pathname) {
      case '/api/StudentTerms/GetStudentTerms':
        return Response.json([{ termId: '4', termCode: 'Synthetic term' }]);
      case '/api/ModulesAndBooklist/GetModulesAndBooklist':
      case '/api/Homework/GetStudentHomework':
      case '/api/StudentGrades/GetStudentGrades':
      case '/api/RegisterAbsence/GetLeaves':
      case '/api/RegisterAbsence/GetStudentRegisteredAbsences':
        return Response.json([]);
      case '/api/Announcements/GetStudentAnnouncements':
        return Response.json([
          {
            announcementId: '12',
            date: '02.01.2040',
            title: 'Synthetic school-wide announcement',
            sender: 'Synthetic school',
            contentHtml: '<p>Synthetic notice</p>',
            hasOpened: false,
          },
        ]);
      case '/api/Timetable/GetTimetable':
        return Response.json([
          {
            start: '2040-01-02T10:00:00',
            end: '2040-01-02T11:00:00',
            titleShort: 'Synthetic lesson',
            allDay: false,
          },
          { start: '2040-01-02', end: '2040-01-03', titleShort: 'Synthetic event', allDay: true },
        ]);
      case '/api/GetAssignments/GetStudentAssignments':
        return Response.json([
          {
            assignmentId: '5',
            name: 'Synthetic assignment',
            module: 'Synthetic course',
            type: '0',
            assignedFullDate: '01.01.2040',
            handInFullDate: '03.01.2040',
            handedIn: 0,
            isOpen: 1,
            projectId: '6',
          },
        ]);
      case '/api/GetAssignments/GetAssignmentInfo':
        return Response.json({
          assignmentId: '5',
          name: 'Synthetic assignment',
          description: '<p>Instructions</p><script>discard()</script>',
          moduleName: 'Synthetic course',
          groupId: '7',
          groupName: '1',
          moduleTermId: '8',
          returnDate: '03.01.2040',
          type: 0,
          exam: 0,
          weight: '20',
          projectId: '6',
          groupReturnSize: 0,
        });
      case '/api/GetAssignments/Groups/7/StudentProjects':
        return Response.json({
          assignments: [
            {
              id: 5,
              name: 'Synthetic assessment',
              type: 0,
              weight: 20,
              grade: '8',
              returnDate: 1,
              assignDate: 1,
              handedIn: true,
            },
          ],
          categories: [],
        });
      case '/api/Attendance/GetAttendance':
        return Response.json({
          absencesTotal: [],
          leaveOfAbsencesTotal: [],
          attendanceTerm: { realAttendance: '90', attendance: '95' },
          dateFrom: '01.01.2040',
          dateTo: '01.05.2040',
          termName: 'Synthetic term',
          nrClassesTotal: 10,
          absencePointsTotal: '1',
          modules: [],
        });
      case '/api/Attachment/GetModuleFiles':
        return Response.json([
          {
            fileGroupId: '9',
            groupId: '7',
            fileGroup: 'Synthetic group',
            files: [
              {
                name: 'Synthetic file',
                fileId: '10',
                closed: false,
                link: 'https://example.invalid/do-not-fetch',
              },
            ],
          },
        ]);
      case '/api/Messages/GetReceivedMessages':
        return Response.json({
          count: 1,
          messages: [
            {
              messagesId: '11',
              table: 'A',
              title: 'Synthetic message',
              sender: 'Synthetic sender',
              date: '02.01.2040',
              status: 'S',
            },
          ],
        });
      case '/api/Messages/GetMessageDetails':
        return Response.json({
          title: 'Synthetic message',
          message: '<p>Hello &amp; welcome</p>',
          dateCreated: '02.01.2040',
          dateSent: '02.01.2040',
          sentTo: 'Synthetic recipient',
          type: 'A',
          attachmentList: [],
        });
      case '/api/RegisterAbsence/GetRegisterAbsences':
        return Response.json({
          todayAllowed: true,
          tomorrowAllowed: true,
          today: false,
          tomorrow: false,
          doctorsNote: '',
          comment: '',
        });
      default:
        throw new Error('Unimplemented synthetic endpoint');
    }
  };
}

async function fixture(allowAbsenceWrites = false) {
  const directory = await mkdtemp(join(tmpdir(), 'inna-offline-'));
  directories.push(directory);
  const source = join(directory, 'cookies.json');
  const path = join(directory, 'session.json');
  await writeFile(
    source,
    JSON.stringify(
      ['SESSION', 'XSRF-TOKEN'].map((name) => ({
        name,
        value: name === 'SESSION' ? 'synthetic-session' : 'synthetic-xsrf',
        domain: 'nam.inna.is',
        path: '/',
        secure: true,
      })),
    ),
    { mode: 0o600 },
  );
  const provider = new Provider();
  const store = storeAt(join(directory, 'store'));

  const options = {
    sessionFile: path,
    store,
    fetch: provider.fetch,
    now: () => NOW,
    allowAbsenceWrites,
  };

  const client = new InnaClient(options);
  await client.importSession(source);

  return { client, provider, options, path, source, store, directory };
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test('every read tool round-trips through MCP without marking read or fetching external links', async () => {
  const f = await fixture();
  // Rust: `serve` over stdio in place of createServer over an in-process transport.
  const server = await serveStdio(f.options);
  const client = new Client({ name: 'inna-offline', version: '1' });
  await client.connect(server.transport);

  try {
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'inna_submit_absence')).toBe(false);

    const calls = [
      ['inna_session_status', {}],
      ['inna_list_students', {}],
      ['inna_get_overview', {}],
      ['inna_get_timetable', { dateFrom: '2040-01-02', dateTo: '2040-01-03' }],
      ['inna_get_assignments', {}],
      ['inna_get_assignment', { assignmentId: '5' }],
      ['inna_get_grades', {}],
      ['inna_get_course_grades', { groupId: '7' }],
      ['inna_get_attendance', {}],
      ['inna_get_materials', { groupId: '7' }],
      ['inna_get_messages', {}],
      ['inna_get_message', { messageId: '11', type: 'A' }],
      ['inna_get_absences', { dateFrom: '2040-01-02', dateTo: '2040-01-03' }],
      ['inna_absence_status', {}],
    ] satisfies [string, object][];

    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual(
      calls.map(([name]) => name).toSorted(),
    );

    // Only the two tools that never select a student may claim to be read-only.
    expect(
      tools.tools
        .filter((tool) => tool.annotations?.readOnlyHint)
        .map((tool) => tool.name)
        .toSorted(),
    ).toEqual(['inna_absence_status', 'inna_list_students']);

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
      expect(result.structuredContent, name).toBeDefined();

      const metadata = z
        .object({ retrievedAt: z.string(), timeZone: z.string() })
        .parse(result.structuredContent);

      expect(metadata.retrievedAt, name).toBe(new Date(NOW).toISOString());
      expect(metadata.timeZone, name).toBe('UTC');
      expectClean(JSON.stringify(result));
      expect(JSON.stringify(result)).not.toContain('synthetic-session');
    }

    expect(f.provider.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(
      f.provider.calls.some((call) =>
        /Mark|SetUserOptions|Download|SubmitAssignment/.test(call.url.pathname),
      ),
    ).toBe(false);

    const timetable = f.provider.calls.find(
      (call) => call.url.pathname === '/api/Timetable/GetTimetable',
    );

    expect(timetable?.url.searchParams.get('date_from')).toBe('02.01.2040');
    expect(timetable?.url.searchParams.get('student_id')).toBe('2');
  } finally {
    await client.close();
    await server.close();
  }
});

test('both opt-in absence tools round-trip through MCP, including confirmed inclusive leave dates', async () => {
  const f = await fixture(true);
  // Rust: `serve` over stdio in place of createServer over an in-process transport.
  const server = await serveStdio(f.options);
  const client = new Client({ name: 'inna-write-offline', version: '1' });
  await client.connect(server.transport);

  try {
    expect((await client.listTools()).tools).toHaveLength(16);

    const prepared = await client.callTool({
      name: 'inna_prepare_absence',
      arguments: { ...request, kind: 'leave', dateFrom: '2040-02-01', dateTo: '2040-02-03' },
    });

    expect(prepared.isError).not.toBe(true);
    const preview = absencePreviewSchema.parse(prepared.structuredContent);
    expect(f.provider.posts).toBe(0);

    const unconfirmed = await client.callTool({
      name: 'inna_submit_absence',
      arguments: { operationId: preview.operationId, confirm: false },
    });

    expect(unconfirmed.isError).toBe(true);
    expect(f.provider.posts).toBe(0);

    const result = await client.callTool({
      name: 'inna_submit_absence',
      arguments: { operationId: preview.operationId, confirm: true },
    });

    expect(result.isError).not.toBe(true);
    expect(absenceRecordSchema.parse(result.structuredContent).state).toBe('submitted');
    expect(z.object({ timeZone: z.string() }).parse(result.structuredContent).timeZone).toBe('UTC');
    await client.callTool({
      name: 'inna_submit_absence',
      arguments: { operationId: preview.operationId, confirm: true },
    });
    expect(f.provider.posts).toBe(1);
    expect(
      JSON.parse(f.provider.calls.find((call) => call.method === 'POST')?.body ?? '{}'),
    ).toEqual({
      firstDay: '01.02.2040',
      lastDay: '03.02.2040',
      leaveStatus: 0,
      leaveType: 3,
      allDay: 1,
      comment: request.reason,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test('message continuation follows delivered rows and rejects incomplete or inconsistent pages', async () => {
  const f = await fixture();

  const messages = Array.from({ length: 41 }, (_, i) => ({
    messagesId: String(i + 1),
    table: 'A',
    sender: 'Synthetic sender',
    date: '02.01.2040 9:05',
    status: 'S',
  }));

  let broken: 'empty' | 'duplicate' | 'count' | undefined;

  const client = new InnaClient({
    ...f.options,
    fetch: async (url, options) => {
      const response = await f.provider.fetch(url, options);
      const endpoint = new URL(url);

      if (endpoint.pathname !== '/api/Messages/GetReceivedMessages') return response;
      const start = Number(endpoint.searchParams.get('rowFrom'));
      const end = Number(endpoint.searchParams.get('rowTo'));

      const rows =
        broken === 'empty'
          ? []
          : broken === 'duplicate'
            ? [messages[0], messages[0]]
            : messages.slice(start - 1, end - 1);

      return Response.json({ count: broken === 'count' ? 0 : messages.length, messages: rows });
    },
  });

  const first = await client.messages();
  expect(first.messages).toHaveLength(20);
  expect(first.nextRowFrom).toBe(21);
  expect(first.messages[0]?.dates?.date?.iso).toBe('2040-01-02T09:05:00.000Z');
  const second = await client.messages(21, 41);
  expect(second.messages).toHaveLength(20);
  expect(second.nextRowFrom).toBe(41);
  const last = await client.messages(41, 61);
  expect(last.messages).toHaveLength(1);
  expect(last.nextRowFrom).toBeNull();
  expect(
    new Set([...first.messages, ...second.messages, ...last.messages].map((m) => m.messagesId))
      .size,
  ).toBe(41);

  for (const failure of ['empty', 'duplicate', 'count'] as const) {
    broken = failure;
    await assert.rejects(client.messages(), /incomplete|inconsistent/);
  }

  expect(f.provider.posts).toBe(0);
});

test('repeated and concurrent reads stay serialized, fresh, UTC, and free of writes', async () => {
  const f = await fixture();
  let active = 0;
  let maximum = 0;
  let reads = 0;

  const client = new InnaClient({
    ...f.options,
    fetch: async (url, options) => {
      active += 1;
      maximum = Math.max(maximum, active);

      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const response = await f.provider.fetch(url, options);

        if (new URL(url).pathname !== '/api/Timetable/GetTimetable') return response;
        reads += 1;

        return Response.json([
          {
            start: '2040-01-02T10:00:00',
            end: '2040-01-02T11:00:00',
            titleShort: `Synthetic lesson ${reads}`,
            allDay: false,
          },
        ]);
      } finally {
        active -= 1;
      }
    },
  });

  const results = await Promise.all(Array.from({ length: 8 }, () => client.timetable(range)));
  expect(maximum).toBe(1);
  expect(new Set(results.map((result) => result.entries[0]?.titleShort)).size).toBe(8);

  for (const result of results) {
    expect(result.entries[0]?.dates?.start?.iso).toBe('2040-01-02T10:00:00.000Z');
    expect(result.timeZone).toBe('UTC');
  }

  expect(f.provider.posts).toBe(0);
  expect(f.provider.calls.every((call) => call.method === 'GET')).toBe(true);
  expect((await stat(f.store.path)).mode & 0o777).toBe(0o600);
});

test('a student switch during a read discards the fetched records', async () => {
  const f = await fixture();

  const client = new InnaClient({
    ...f.options,
    fetch: async (url, options) => {
      const response = await f.provider.fetch(url, options);

      if (new URL(url).pathname === '/api/Timetable/GetTimetable')
        f.provider.user = { ...f.provider.user, studentId: '99' };

      return response;
    },
  });

  await assert.rejects(
    client.timetable({ dateFrom: '2040-01-02', dateTo: '2040-01-03' }),
    /during the read.*discarded/,
  );
  expect(f.provider.posts).toBe(0);
});

test('numeric and HTTP-date rate-limit pauses survive restart and expire at the saved UTC deadline', async () => {
  const cases: [string, number][] = [
    ['1', 60_000],
    ['120', 120_000],
    [new Date(NOW + 120_000).toUTCString(), 120_000],
    ['7200', 7_200_000],
    ['bad', 60_000],
    ['-1', 60_000],
  ];

  for (const [retry, wait] of cases) {
    const f = await fixture();
    let now = NOW;

    const limited = new InnaClient({
      ...f.options,
      now: () => now,
      fetch: async (url, options) => {
        await f.provider.fetch(url, options);

        return new Response(null, { status: 429, headers: { 'Retry-After': retry } });
      },
    });

    await assert.rejects(limited.messages(), /rate limited/);

    const saved = z.object({ pauseUntil: z.number() }).parse(JSON.parse(await readStored(f.store)));

    expect(saved.pauseUntil).toBe(NOW + wait);
    const restarted = new InnaClient({ ...f.options, now: () => now });
    const calls = f.provider.calls.length;
    await assert.rejects(restarted.messages(), /requested a pause/);
    expect(f.provider.calls).toHaveLength(calls);
    now += wait;
    expect((await restarted.messages()).count).toBe(1);
  }
});

test('UTC midnight or preview expiry during submission checks prevents a POST', async () => {
  for (const delay of [10 * 60_000, 12 * 60 * 60_000]) {
    const f = await fixture(true);
    const preview = await f.client.prepareAbsence(request);
    let now = NOW;

    const client = new InnaClient({
      ...f.options,
      now: () => now,
      fetch: async (url, options) => {
        const response = await f.provider.fetch(url, options);

        if (new URL(url).pathname === '/api/RegisterAbsence/GetLeaves') now += delay;

        return response;
      },
    });

    await assert.rejects(
      client.submitAbsence(preview.operationId, true),
      /UTC day changed|preview expired/,
    );
    expect(f.provider.posts).toBe(0);
    expect((await f.client.absenceStatus()).operation?.state).toBe('prepared');
  }
});

test('malformed or overlapping illness history blocks both sick and leave requests', async () => {
  for (const date of ['02.01.2040 malformed time', '02.01.2040']) {
    const f = await fixture(true);

    const client = new InnaClient({
      ...f.options,
      fetch: async (url, options) => {
        const response = await f.provider.fetch(url, options);

        return new URL(url).pathname === '/api/RegisterAbsence/GetStudentRegisteredAbsences'
          ? Response.json([{ id: 1, date, statusCode: 0, allDay: '1', classes: [] }])
          : response;
      },
    });

    for (const kind of ['sick', 'leave'] as const)
      await assert.rejects(
        client.prepareAbsence({ ...request, kind }),
        /unrecognized absence date|already registered/,
      );

    expect(f.provider.posts).toBe(0);
  }
});

test('every dated feed preserves its source and distinguishes parsed, missing, and invalid dates', async () => {
  const f = await fixture();

  const responses = new Map([
    [
      '/api/ModulesAndBooklist/GetModulesAndBooklist',
      JSON.stringify([
        {
          moduleId: '1',
          moduleTermId: '2',
          moduleName: 'Synthetic',
          moduleName2: 'Synthetic',
          subjectName: 'Synthetic',
          groupId: '7',
          groupName: '1',
          termId: '4',
          dateFrom: '02.01.2040',
          dateTo: 'bad',
        },
      ]),
    ],
    [
      '/api/Homework/GetStudentHomework',
      JSON.stringify([
        { id: 1, date: '02.01.2040 9:05', moduleName: 'Synthetic', text: '<p>Synthetic</p>' },
      ]),
    ],
    [
      '/api/StudentGrades/GetStudentGrades',
      JSON.stringify([
        {
          moduleTermId: '2',
          termId: '4',
          moduleName: 'Synthetic',
          subjectName: 'Synthetic',
          units: '5',
          status: '1',
          show: true,
          termCode: 'Synthetic',
          dateFinished: '',
        },
      ]),
    ],
    [
      '/api/RegisterAbsence/GetStudentRegisteredAbsences',
      JSON.stringify([
        {
          id: 1,
          date: '02.01.2040',
          statusCode: 0,
          allDay: '1',
          classes: [
            {
              id: 1,
              date: '02.01.2040',
              timeFrom: '9:05',
              timeTo: '10:00',
              class: 'Synthetic',
            },
          ],
        },
      ]),
    ],
    [
      '/api/RegisterAbsence/GetLeaves',
      JSON.stringify([
        {
          id: 2,
          dateFrom: '02.01.2040',
          dateTo: '03.01.2040',
          created: '01.01.2040 23:59:59',
          leaveType: '3',
          status: '0',
          statusCode: 0,
          reasonForLeave: 'Synthetic',
          createdBy: 'Synthetic',
          classes: [],
        },
      ]),
    ],
  ]);

  const client = new InnaClient({
    ...f.options,
    fetch: async (url, options) => {
      const response = await f.provider.fetch(url, options);
      const body = responses.get(new URL(url).pathname);

      return body === undefined
        ? response
        : new Response(body, { headers: { 'Content-Type': 'application/json' } });
    },
  });

  const overview = await client.overview();
  expect(overview.courses[0]?.dateTo).toBe('bad');
  expect(overview.courses[0]?.dates).toEqual({
    dateFrom: { iso: '2040-01-02', status: 'parsed' },
    dateTo: { iso: null, status: 'unrecognized' },
  });
  expect(overview.announcements[0]?.dates?.date?.iso).toBe('2040-01-02');
  const timetable = await client.timetable({ dateFrom: '2040-01-02', dateTo: '2040-01-03' });
  expect(timetable.entries[1]?.dates?.start?.iso).toBe('2040-01-02');
  expect(timetable.entries[1]?.dates?.end?.iso).toBe('2040-01-03');
  const assignments = await client.assignments('assignments');
  expect(assignments.entries[0]?.dates?.handInFullDate?.iso).toBe('2040-01-03');
  expect(assignments.homework[0]?.dates?.date?.iso).toBe('2040-01-02T09:05:00.000Z');
  expect((await client.assignment('5')).assignment.dates?.returnDate?.iso).toBe('2040-01-03');
  expect((await client.grades()).entries[0]?.dates?.dateFinished).toEqual({
    iso: null,
    status: 'missing',
  });
  expect((await client.courseGrades('7')).assignments[0]?.dates?.assignDate?.iso).toBe(
    '1970-01-01T00:00:00.001Z',
  );
  expect((await client.attendance()).attendance.dates?.dateTo?.iso).toBe('2040-05-01');
  expect((await client.materials('7')).groups[0]?.files[0]?.dates?.dateOpened).toEqual({
    iso: null,
    status: 'missing',
  });
  expect((await client.message('11', 'A')).message.dates?.dateSent?.iso).toBe('2040-01-02');
  const absences = await client.absences({ dateFrom: '2040-01-02', dateTo: '2040-01-03' });
  expect(absences.sick[0]?.dates?.date?.iso).toBe('2040-01-02');
  expect(absences.sick[0]?.classes[0]?.dates?.date?.iso).toBe('2040-01-02');
  expect(absences.leave[0]?.dates?.created?.iso).toBe('2040-01-01T23:59:59.000Z');
  expect(f.provider.posts).toBe(0);
});

test('failed and stalled response bodies are cancelled without returning a false empty feed', async () => {
  const f = await fixture();
  let now = NOW;

  for (const status of [302, 401, 403, 429, 500, 200]) {
    let cancelled = false;

    const client = new InnaClient({
      ...f.options,
      now: () => now,
      fetch: async (url, options) => {
        const response = await f.provider.fetch(url, options);

        if (new URL(url).pathname !== '/api/Messages/GetReceivedMessages') return response;

        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers: { 'Content-Type': 'text/html' } },
        );
      },
    });

    await assert.rejects(client.messages(), /sign-in|denied|rate limited|unexpected response/);
    expect(cancelled).toBe(true);

    if (status === 429) {
      // Use the same private session after its verified pause, without rewriting its stored state.
      now += 60_000;
      await new InnaClient({ ...f.options, now: () => now }).messages();
    }
  }

  // The 30 ms deadline starts with the stalled response, inside the session lock, so a slow lock
  // wait can never use it up first.
  const deadline = new AbortController();

  const stalled = new InnaClient({
    ...f.options,
    now: () => now,
    fetch: async (url, options) => {
      const response = await f.provider.fetch(url, options);

      if (new URL(url).pathname !== '/api/Messages/GetReceivedMessages') return response;

      const timeout = AbortSignal.timeout(30);
      timeout.addEventListener('abort', () => deadline.abort(timeout.reason), { once: true });

      return new Response(new ReadableStream(), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await assert.rejects(stalled.messages(1, 21, deadline.signal), /timed out/i);
  expect(f.provider.posts).toBe(0);
});

test('private import, principal binding, redirect refusal, and shared rate-limit pause', async () => {
  const f = await fixture();
  expect((await stat(f.store.path)).mode & 0o777).toBe(0o600);
  await chmod(f.source, 0o644);
  await assert.rejects(f.client.importSession(f.source));
  await chmod(f.source, 0o600);
  const before = await readStored(f.store);
  f.provider.user = { ...f.provider.user, studentId: '99' };
  await assert.rejects(f.client.importSession(f.source), /changes the account/);
  expect(await readStored(f.store)).toBe(before);
  await assert.rejects(f.client.overview(), /changed account/);
  f.provider.user = { ...f.provider.user, studentId: '2' };
  f.provider.redirect = true;
  await assert.rejects(f.client.overview(), /sign-in is required/);
  f.provider.redirect = false;
  f.provider.rateLimit = true;
  await assert.rejects(f.client.overview(), /rate limited/);
  f.provider.rateLimit = false;
  const count = f.provider.calls.length;
  await assert.rejects(new InnaClient(f.options).overview(), /requested a pause/);
  expect(f.provider.calls).toHaveLength(count);
});

test('whole-day writes require preview, confirmation, permissions, and the same student', async () => {
  const f = await fixture(true);
  await assert.rejects(
    new InnaClient({ ...f.options, allowAbsenceWrites: false }).prepareAbsence(request),
    /allow-absence-writes/,
  );
  const preview = await f.client.prepareAbsence(request);
  expect(f.provider.posts).toBe(0);
  expect(preview.studentName).toBe('Synthetic student');
  const submitted = await f.client.submitAbsence(preview.operationId, true);
  expect(submitted.state).toBe('submitted');
  expect(submitted.upstreamId).toBe(123);
  await f.client.submitAbsence(preview.operationId, true);
  expect(f.provider.posts).toBe(1);

  const payload = z
    .object({
      firstDay: z.string(),
      lastDay: z.string(),
      leaveType: z.number(),
      allDay: z.number(),
      comment: z.string(),
    })
    .parse(JSON.parse(f.provider.calls.find((call) => call.method === 'POST')?.body ?? '{}'));

  expect(payload).toEqual({
    firstDay: '02.01.2040',
    lastDay: '02.01.2040',
    leaveType: 1,
    allDay: 1,
    comment: 'Synthetic reason',
  });

  const leave = await f.client.prepareAbsence({
    ...request,
    kind: 'leave',
    dateFrom: '2040-02-01',
    dateTo: '2040-02-03',
  });

  f.provider.user = { ...f.provider.user, studentId: '99' };
  await assert.rejects(f.client.submitAbsence(leave.operationId, true), /changed account/);
  expect(f.provider.posts).toBe(1);
});

test('lost write response survives restart and logout without allowing another POST', async () => {
  const f = await fixture(true);
  const preview = await f.client.prepareAbsence(request);
  f.provider.failPost = true;
  await assert.rejects(f.client.submitAbsence(preview.operationId, true), /uncertain/);
  const restarted = new InnaClient(f.options);
  expect((await restarted.absenceStatus()).operation?.state).toBe('unknown');
  await assert.rejects(restarted.submitAbsence(preview.operationId, true), /will not be replayed/);
  await assert.rejects(restarted.prepareAbsence(request), /earlier absence/);
  expect(f.provider.posts).toBe(1);
  await restarted.logout();
  expect(await readFile(`${f.path}.absence.json`, 'utf8')).toContain('unknown');
});

test('a student switch during absence preflight prevents the POST', async () => {
  const f = await fixture(true);
  const preview = await f.client.prepareAbsence(request);

  const concurrent = new InnaClient({
    ...f.options,
    fetch: async (url, options) => {
      const response = await f.provider.fetch(url, options);

      if (new URL(url).pathname === '/api/RegisterAbsence/GetLeaves')
        f.provider.user = { ...f.provider.user, studentId: '99' };

      return response;
    },
  });

  await assert.rejects(
    concurrent.submitAbsence(preview.operationId, true),
    /changed during absence checks/,
  );
  expect(f.provider.posts).toBe(0);
});

test('expired previews and revoked absence permissions never reach the write endpoint', async () => {
  const f = await fixture(true);
  const preview = await f.client.prepareAbsence(request);
  const expired = new InnaClient({ ...f.options, now: () => NOW + 10 * 60_000 });
  await assert.rejects(expired.submitAbsence(preview.operationId, true), /preview expired/);
  f.provider.user = { ...f.provider.user, registerAbsenceGuardian: '0' };
  await assert.rejects(f.client.submitAbsence(preview.operationId, true), /does not permit/);
  expect(f.provider.posts).toBe(0);
});

test('rate limiting during a replacement import preserves the saved session pause', async () => {
  const f = await fixture();
  f.provider.rateLimit = true;
  await assert.rejects(f.client.importSession(f.source), /rate limited/);
  f.provider.rateLimit = false;
  const count = f.provider.calls.length;
  await assert.rejects(new InnaClient(f.options).overview(), /requested a pause/);
  expect(f.provider.calls).toHaveLength(count);
});

function parseSaved(text: string) {
  return z
    .object({
      version: z.number(),
      jar: z.string(),
      account: z.object({ userId: z.number(), studentId: z.string(), schoolId: z.string() }),
      students: z.record(z.string(), z.object({ studentId: z.string(), studentName: z.string() })),
      pauseUntil: z.number(),
    })
    .parse(JSON.parse(text));
}

async function savedFile(store: Store) {
  return parseSaved(await readStored(store));
}

// Runs the real CLI with the fake browser; its nam.inna.is requests reach the synthetic Provider.
async function googleLogin(provider: Provider, extra: string[] = []) {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-offline-google-');
  directories.push(directory);
  const path = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const preload = await makePreload(directory);

  const bridge = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (incoming) => {
      const url = new URL(incoming.url);
      // Rust: the binary asks for `https://nam.inna.is<path>` at `<origin>/nam.inna.is<path>`.
      const path = url.pathname.replace(/^\/nam\.inna\.is(?=\/)/, '');

      return provider.fetch(`https://nam.inna.is${path}${url.search}`, {
        method: incoming.method,
        headers: incoming.headers,
        redirect: 'manual',
      });
    },
  });

  const env = browserEnvironment(directory, temporaryDirectory, path, {
    INNA_TEST_ORIGIN: `http://127.0.0.1:${bridge.port}`,
  });

  async function run(args: string[] = extra) {
    const child = spawnLogin(browser, env, 20, preload, args);

    try {
      return await collectProcess(child);
    } finally {
      await stopChild(child);
    }
  }

  return { path, store: storeAt(storeHome(directory)), run, stop: () => bridge.stop(true) };
}

test('the saved default user id is read locally and is absent without a session', async () => {
  const f = await fixture();
  const count = f.provider.calls.length;
  expect(await f.client.defaultUserId()).toBe(1);
  await f.client.overview(undefined, SIBLING);
  expect(await f.client.defaultUserId()).toBe(1);
  const calls = f.provider.calls.length;
  expect(calls).toBeGreaterThan(count);
  await f.client.logout();
  expect(await f.client.defaultUserId()).toBeUndefined();
  expect(f.provider.calls).toHaveLength(calls);
});

test('Google browser sign-in saves a version 2 session and refuses a changed binding', async () => {
  const provider = new Provider();
  const login = await googleLogin(provider);

  try {
    const first = await login.run();
    expect(first).toEqual({
      exit: 0,
      stdout: 'Signed in. Saved in an encrypted file.\n',
      stderr: START_MESSAGE,
    });
    expect(provider.paths()).toEqual([USER_PATH]);
    const saved = await savedFile(login.store);
    expect(saved.version).toBe(2);
    expect(saved.account).toEqual({ userId: 1, studentId: '2', schoolId: '3' });
    expect(Object.keys(saved.students)).toEqual(['1']);
    expect(saved.jar).toContain('synthetic-rotated');
    expect(saved.jar).toContain('synthetic-xsrf');
    expect(saved.jar).not.toContain('decoy');
    expect((await stat(login.store.path)).mode & 0o777).toBe(0o600);

    const client = new InnaClient({
      sessionFile: login.path,
      store: login.store,
      fetch: provider.fetch,
    });

    expect(await client.status()).toMatchObject({
      authenticated: true,
      context: { studentId: '2' },
    });

    const before = await readStored(login.store);
    provider.user = { ...provider.user, studentId: '99' };
    const refused = await login.run();
    expect(refused.exit).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toBe(
      `${START_MESSAGE}This export changes the account, student, or school. Use --allow-account-change deliberately.\n`,
    );
    expect(await readStored(login.store)).toBe(before);

    const allowed = await login.run(['--allow-account-change']);
    expect(allowed.exit).toBe(0);
    expect(allowed.stdout).toBe('Signed in. Saved in an encrypted file.\n');
    expect((await savedFile(login.store)).account.studentId).toBe('99');
    expectClean(await readStored(login.store));
  } finally {
    await login.stop();
  }
});

test('students are listed without switching or exposing identity fields', async () => {
  const f = await fixture();
  const listed = await f.client.listStudents();

  expect(listed.students).toEqual([
    {
      studentKey: '1',
      title: 'Synthetic role',
      schoolName: 'Synthetic school',
      schoolId: '3',
      selected: true,
      isDefault: true,
      studentId: '2',
      studentName: 'Synthetic student',
    },
    {
      studentKey: SIBLING,
      title: 'Synthetic role',
      schoolName: 'Synthetic second school',
      schoolId: '8',
      selected: false,
      isDefault: false,
      studentId: undefined,
      studentName: 'Synthetic sibling',
    },
  ]);
  expect(listed.context.studentId).toBe('2');
  expect(listed.retrievedAt).toBe(new Date(NOW).toISOString());
  expectClean(JSON.stringify(listed));
  expectClean(await readStored(f.store));
  expect(f.provider.paths()).toEqual([
    '/api/UserData/GetLoggedInUser',
    '/api/UserData/GetLoggedInUser',
  ]);

  await f.client.timetable({ ...range, studentKey: SIBLING });
  const after = await f.client.listStudents();
  expect(after.students.map((entry) => [entry.selected, entry.isDefault, entry.studentId])).toEqual(
    [
      [false, true, '2'],
      [true, false, '6'],
    ],
  );
  expect(after.context.studentId).toBe('6');
  expect(f.provider.switches).toBe(1);
});

test('a session without student access entries lists its context as the single default', async () => {
  const f = await fixture();
  f.provider.order = ['9'];
  const listed = await f.client.listStudents();

  expect(listed.students).toEqual([
    {
      schoolName: 'Synthetic school',
      schoolId: '3',
      selected: true,
      isDefault: true,
      studentId: '2',
      studentName: 'Synthetic student',
    },
  ]);
  expect((await f.client.overview()).context.studentId).toBe('2');
  await assert.rejects(f.client.overview(undefined, SIBLING), /not in this Inna session/);
  f.provider.order = ['1', '1'];
  await assert.rejects(f.client.listStudents(), /no usable student list/);
  await assert.rejects(f.client.overview(undefined, '1'), /not in this Inna session/);
  expect((await f.client.overview()).context.studentId).toBe('2');
  expect(f.provider.switches).toBe(0);
});

test('reading the sibling and then the default switches there and back with verification', async () => {
  const f = await fixture();
  let from = f.provider.calls.length;
  const timetable = await f.client.timetable({ ...range, studentKey: SIBLING });

  expect(timetable.context.studentId).toBe('6');
  expect(timetable.context.studentName).toBe('Synthetic sibling');
  expect(f.provider.paths(from)).toEqual([
    '/api/UserData/GetLoggedInUser',
    '/auth/system',
    '/Components/Students/Students.html',
    '/api/UserData/GetLoggedInUser',
    '/api/Timetable/GetTimetable',
    '/api/UserData/GetLoggedInUser',
  ]);
  expect(f.provider.calls[from + 1]?.url.search).toBe('?i=1&system=1&status=2&user_id=5');
  expect(f.provider.calls[from + 2]?.url.protocol).toBe('https:');
  expect(f.provider.calls[from + 4]?.url.searchParams.get('student_id')).toBe('6');

  from = f.provider.calls.length;
  expect((await f.client.messages(1, 21, undefined, SIBLING)).context.studentId).toBe('6');
  expect(f.provider.paths(from)).toEqual([
    '/api/UserData/GetLoggedInUser',
    '/api/Messages/GetReceivedMessages',
    '/api/UserData/GetLoggedInUser',
  ]);

  from = f.provider.calls.length;
  const overview = await f.client.overview();
  expect(overview.context.studentId).toBe('2');
  expect(f.provider.paths(from).slice(0, 4)).toEqual([
    '/api/UserData/GetLoggedInUser',
    '/auth/system',
    '/Components/Students/Students.html',
    '/api/UserData/GetLoggedInUser',
  ]);
  expect(f.provider.calls[from + 1]?.url.search).toBe('?i=0&system=1&status=1&user_id=1');
  expect(f.provider.switches).toBe(2);
  expect(f.provider.calls.every((call) => call.method === 'GET')).toBe(true);

  const saved = await savedFile(f.store);
  expect(saved.version).toBe(2);
  expect(saved.account.studentId).toBe('2');
  expect(Object.keys(saved.students).toSorted()).toEqual(['1', SIBLING]);
  expect(saved.students[SIBLING]?.studentName).toBe('Synthetic sibling');
  expect(saved.jar).toContain('synthetic-rotated');
});

test('a changed access order still switches by the current index', async () => {
  const f = await fixture();
  await f.client.timetable({ ...range, studentKey: SIBLING });
  f.provider.order = ['9', SIBLING, '1'];
  const from = f.provider.calls.length;

  expect((await f.client.overview()).context.studentId).toBe('2');
  expect(f.provider.calls[from + 1]?.url.search).toBe('?i=2&system=1&status=1&user_id=1');
  f.provider.order = [SIBLING, '9', '1'];
  expect((await f.client.grades(undefined, undefined, SIBLING)).context.studentId).toBe('6');
  expect(
    f.provider.calls.findLast((call) => call.url.pathname === '/auth/system')?.url.search,
  ).toBe('?i=0&system=1&status=2&user_id=5');
});

test('an ignored, misdirected, or rate-limited switch returns no data', async () => {
  const ignored = await fixture();
  ignored.provider.ignoreSwitch = true;
  await assert.rejects(
    ignored.client.timetable({ ...range, studentKey: SIBLING }),
    /did not select the requested student/,
  );
  expect(ignored.provider.paths()).not.toContain('/api/Timetable/GetTimetable');
  expect((await savedFile(ignored.store)).students[SIBLING]).toBeUndefined();

  for (const location of [
    'https://r.inna.is/login',
    'http://example.invalid/Components/Students/Students.html',
    'https://nam.inna.is/Components/Other/Other.html',
    'https://nam.inna.is:8443/Components/Students/Students.html',
  ]) {
    const f = await fixture();
    f.provider.switchLocation = location;
    await assert.rejects(f.client.overview(undefined, SIBLING), /refused the student switch/);
    expect(f.provider.paths().slice(-1)).toEqual(['/auth/system']);
  }

  const refused = await fixture();
  refused.provider.switchUnauthorized = true;
  await assert.rejects(
    refused.client.overview(undefined, SIBLING),
    /^SafeError: Inna refused the student switch and asked for sign-in\. The session may have ended; sign in again and report this\.$/,
  );
  expect(refused.provider.paths().slice(-1)).toEqual(['/auth/system']);
  refused.provider.unauthorized = true;
  await assert.rejects(refused.client.overview(), /^SafeError: Inna sign-in is required\./);

  const limited = await fixture();
  limited.provider.switchRateLimit = true;
  await assert.rejects(limited.client.overview(undefined, SIBLING), /rate limited/);
  expect((await savedFile(limited.store)).pauseUntil).toBe(NOW + 120_000);
  const count = limited.provider.calls.length;
  await assert.rejects(new InnaClient(limited.options).overview(), /requested a pause/);
  expect(limited.provider.calls).toHaveLength(count);
});

test('unknown and non-student keys are refused without a switch request', async () => {
  const f = await fixture();

  for (const key of ['999', '9'])
    await assert.rejects(f.client.overview(undefined, key), /not in this Inna session/);
  await assert.rejects(f.client.overview(undefined, 'abc'));
  expect(f.provider.switches).toBe(0);
  expect(f.provider.paths()).not.toContain('/api/StudentTerms/GetStudentTerms');
});

test('a version 1 session file migrates and learns students on use', async () => {
  const f = await fixture();
  const { jar, account, pauseUntil } = await savedFile(f.store);
  const version1 = JSON.stringify({ version: 1, jar, account, pauseUntil });
  // Before any store exists the plaintext file is authoritative and is written back in place.
  const store = storeAt(join(f.directory, 'unmigrated'));
  const client = new InnaClient({ ...f.options, store });
  await writeFile(f.path, version1, { mode: 0o600 });
  expect((await client.overview()).context.studentId).toBe('2');
  const migrated = parseSaved(await readFile(f.path, 'utf8'));
  expect(migrated.version).toBe(2);
  expect(Object.keys(migrated.students)).toEqual(['1']);
  expect((await client.overview(undefined, SIBLING)).context.studentId).toBe('6');
  expect((await client.overview()).context.studentId).toBe('2');
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect(await client.status()).toMatchObject({
    authenticated: true,
    storage: 'Saved in a plaintext file. Run inna-mcp auth migrate.',
  });
  await assert.rejects(stat(store.path), /ENOENT/);
  await assert.rejects(stat(`${store.path}.marker`), /ENOENT/);

  // A version 1 file whose browser session moved to the sibling switches back to its default.
  f.provider.selected = SIBLING;
  f.provider.user = sibling;
  await writeFile(f.path, version1, { mode: 0o600 });
  const switches = f.provider.switches;
  expect((await client.overview()).context.studentId).toBe('2');
  expect(f.provider.switches).toBe(switches + 1);

  // The same version 1 value in the store record is read as version 2 too.
  f.provider.selected = '1';
  f.provider.user = student;
  await updateStored(f.store, () => version1);
  expect((await f.client.overview()).context.studentId).toBe('2');
  expect((await savedFile(f.store)).version).toBe(2);
});

test('a learned student binding that later differs is refused', async () => {
  const f = await fixture();
  await f.client.overview(undefined, SIBLING);
  await f.client.overview();
  f.provider.contexts.set(SIBLING, { ...sibling, studentId: '77' });
  const from = f.provider.calls.length;
  await assert.rejects(f.client.overview(undefined, SIBLING), /changed account/);
  expect(f.provider.paths(from)).not.toContain('/api/StudentTerms/GetStudentTerms');
  expect((await savedFile(f.store)).students[SIBLING]?.studentId).toBe('6');

  expectClean(await readStored(f.store));

  // The selected entry must agree with the returned context on user and school.
  for (const wrong of [
    { ...sibling, userId: 7 },
    { ...sibling, schoolId: '3' },
  ]) {
    const strict = await fixture();
    strict.provider.contexts.set(SIBLING, wrong);
    await assert.rejects(
      strict.client.overview(undefined, SIBLING),
      /did not select the requested student/,
    );
    expect(strict.provider.paths()).not.toContain('/api/StudentTerms/GetStudentTerms');
    expect((await savedFile(strict.store)).students[SIBLING]).toBeUndefined();
    strict.provider.user = { ...student, schoolId: '8' };
    strict.provider.selected = '1';
    await assert.rejects(strict.client.overview(), /changed account/);
    await assert.rejects(strict.client.importSession(strict.source, true), /one selected student/);
  }

  const numeric = await fixture();
  numeric.provider.numeric = true;
  expect((await numeric.client.overview(undefined, SIBLING)).context.studentId).toBe('6');
  expect((await numeric.client.listStudents()).students.map((entry) => entry.selected)).toEqual([
    false,
    true,
  ]);

  const duplicate = await fixture();
  duplicate.provider.contexts.set(SIBLING, { ...sibling, studentId: '2' });
  await assert.rejects(
    duplicate.client.overview(undefined, SIBLING),
    /already saved under another studentKey/,
  );
  expect((await savedFile(duplicate.store)).students[SIBLING]).toBeUndefined();
});

test('import onto a learned sibling is refused unless the account change is deliberate', async () => {
  const f = await fixture(true);
  await f.client.prepareAbsence(request);
  await f.client.overview(undefined, SIBLING);
  const before = await readStored(f.store);
  await assert.rejects(f.client.importSession(f.source), /Select the default student/);
  expect(await readStored(f.store)).toBe(before);
  expect((await f.client.absenceStatus()).operation?.account.studentId).toBe('2');

  await f.client.importSession(f.source, true);
  const replaced = await savedFile(f.store);
  expect(replaced.account.studentId).toBe('6');
  expect(Object.keys(replaced.students)).toEqual([SIBLING]);
  await assert.rejects(f.client.absenceStatus(), /belongs to another account/);
});

test('a sibling preview is submitted to that student once, after switching back to it', async () => {
  const f = await fixture(true);
  const preview = await f.client.prepareAbsence({ ...request, studentKey: SIBLING });
  expect(preview.studentName).toBe('Synthetic sibling');
  expect(preview.schoolName).toBe('Synthetic second school');
  expect(preview.studentKey).toBe(SIBLING);
  expect(preview.account.studentId).toBe('6');
  expect(preview.request).toEqual(request);

  expect((await f.client.overview()).context.studentId).toBe('2');
  const status = await f.client.absenceStatus();
  expect(status.context.studentId).toBe('2');
  expect(status.operation?.account.studentId).toBe('6');
  expect(f.provider.selected).toBe('1');

  const from = f.provider.calls.length;
  const submitted = await f.client.submitAbsence(preview.operationId, true);
  expect(submitted.state).toBe('submitted');
  expect(submitted.studentKey).toBe(SIBLING);
  expect(f.provider.paths(from).slice(0, 4)).toEqual([
    '/api/UserData/GetLoggedInUser',
    '/auth/system',
    '/Components/Students/Students.html',
    '/api/UserData/GetLoggedInUser',
  ]);
  expect(f.provider.paths(from).at(-1)).toBe('/api/RegisterAbsence/AddNewLeave');
  expect(f.provider.selected).toBe(SIBLING);
  await f.client.overview();
  await f.client.submitAbsence(preview.operationId, true);
  expect(f.provider.posts).toBe(1);
});

test('a switch away from the sibling during absence preflight prevents the POST', async () => {
  for (const moveContext of [true, false]) {
    const f = await fixture(true);
    const preview = await f.client.prepareAbsence({ ...request, studentKey: SIBLING });

    const concurrent = new InnaClient({
      ...f.options,
      fetch: async (url, options) => {
        const response = await f.provider.fetch(url, options);

        if (new URL(url).pathname === '/api/RegisterAbsence/GetLeaves') {
          f.provider.selected = '1';

          if (moveContext) f.provider.user = student;
        }

        return response;
      },
    });

    await assert.rejects(
      concurrent.submitAbsence(preview.operationId, true),
      /changed during absence checks/,
    );
    expect(f.provider.posts).toBe(0);
    expect((await f.client.absenceStatus()).operation?.state).toBe('prepared');
  }
});

test('a changed or missing school on the selected entry discards reads and prevents the POST', async () => {
  const changed = { system: '1', status: '2', skoli_id: '99', skoli_heiti: 'Synthetic other' };
  const missing = { system: '1', status: '2', skoli_heiti: 'Synthetic second school' };

  for (const entry of [changed, missing]) {
    for (const endpoint of ['/api/Timetable/GetTimetable', '/api/RegisterAbsence/GetLeaves']) {
      const f = await fixture(true);
      const preview = await f.client.prepareAbsence({ ...request, studentKey: SIBLING });

      // The context binding stays the sibling's; only its access entry stops agreeing on the school.
      const client = new InnaClient({
        ...f.options,
        fetch: async (url, options) => {
          const response = await f.provider.fetch(url, options);

          if (new URL(url).pathname === endpoint) f.provider.entries.set(SIBLING, entry);

          return response;
        },
      });

      if (endpoint === '/api/Timetable/GetTimetable')
        await assert.rejects(
          client.timetable({ ...range, studentKey: SIBLING }),
          /during the read.*discarded/,
        );
      else
        await assert.rejects(
          client.submitAbsence(preview.operationId, true),
          /changed during absence checks/,
        );
      expect(f.provider.user.studentId).toBe('6');
      expect(f.provider.selected).toBe(SIBLING);
      expect(f.provider.posts).toBe(0);
      expect((await f.client.absenceStatus()).operation?.state).toBe('prepared');
    }
  }
});

test('one uncertain operation blocks new previews for every student', async () => {
  const f = await fixture(true);
  const preview = await f.client.prepareAbsence({ ...request, studentKey: SIBLING });
  f.provider.failPost = true;
  await assert.rejects(f.client.submitAbsence(preview.operationId, true), /uncertain/);
  await assert.rejects(f.client.prepareAbsence(request), /earlier absence/);
  await assert.rejects(
    f.client.prepareAbsence({ ...request, studentKey: SIBLING }),
    /earlier absence/,
  );
  expect(f.provider.posts).toBe(1);
});

test('all 16 tools round-trip through MCP for the sibling studentKey', async () => {
  const f = await fixture(true);
  // Rust: `serve` over stdio in place of createServer over an in-process transport.
  const server = await serveStdio(f.options);
  const client = new Client({ name: 'inna-students-offline', version: '1' });
  await client.connect(server.transport);

  try {
    const tools = await client.listTools();
    const keyed = { studentKey: SIBLING };

    const calls = [
      ['inna_list_students', {}],
      ['inna_session_status', keyed],
      ['inna_get_overview', keyed],
      ['inna_get_timetable', { ...range, ...keyed }],
      ['inna_get_assignments', keyed],
      ['inna_get_assignment', { assignmentId: '5', ...keyed }],
      ['inna_get_grades', keyed],
      ['inna_get_course_grades', { groupId: '7', ...keyed }],
      ['inna_get_attendance', keyed],
      ['inna_get_materials', { groupId: '7', ...keyed }],
      ['inna_get_messages', keyed],
      ['inna_get_message', { messageId: '11', type: 'A', ...keyed }],
      ['inna_get_absences', { ...range, ...keyed }],
      ['inna_prepare_absence', { ...request, ...keyed }],
      ['inna_absence_status', {}],
    ] satisfies [string, object][];

    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual(
      [...calls.map(([name]) => name), 'inna_submit_absence'].toSorted(),
    );

    for (const tool of tools.tools) {
      const accepts = JSON.stringify(tool.inputSchema).includes('studentKey');

      expect(accepts, tool.name).toBe(
        !['inna_list_students', 'inna_absence_status', 'inna_submit_absence'].includes(tool.name),
      );
    }

    let operationId = '';

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
      expectClean(JSON.stringify(result));
      expect(JSON.stringify(result)).not.toContain('synthetic-s');

      const output = z
        .object({
          retrievedAt: z.string(),
          timeZone: z.literal('UTC'),
          context: z.object({ studentId: z.string() }).optional(),
          account: z.object({ studentId: z.string() }).optional(),
          operationId: z.string().optional(),
        })
        .parse(result.structuredContent);

      if (name !== 'inna_list_students')
        expect((output.context ?? output.account)?.studentId, name).toBe('6');
      operationId = output.operationId ?? operationId;
    }

    expect(f.provider.switches).toBe(1);

    const refused = await client.callTool({
      name: 'inna_submit_absence',
      arguments: { operationId, confirm: true, ...keyed },
    });

    expect(refused.isError).toBe(true);
    await client.callTool({ name: 'inna_get_overview', arguments: {} });

    const submitted = await client.callTool({
      name: 'inna_submit_absence',
      arguments: { operationId, confirm: true },
    });

    expect(submitted.isError).not.toBe(true);
    expect(absenceRecordSchema.parse(submitted.structuredContent).account.studentId).toBe('6');
    expect(f.provider.posts).toBe(1);
    expect(f.provider.switches).toBe(3);
  } finally {
    await client.close();
    await server.close();
  }
});

const USER_PATH = '/api/UserData/GetLoggedInUser';

// Drives the scheduler by hand: the injected timer never fires on its own.
function scheduled(client: InnaClient) {
  const runs: Promise<KeepAlive>[] = [];
  const ticks: (() => void)[] = [];
  const intervals: number[] = [];
  let cancelled = 0;

  const scheduler = startKeepAlive(
    {
      keepAlive: (signal) => {
        const run = client.keepAlive(signal);
        runs.push(run);

        return run;
      },
    },
    {
      repeat: (tick, milliseconds) => {
        ticks.push(tick);
        intervals.push(milliseconds);

        return () => {
          cancelled += 1;
        };
      },
    },
  );

  return {
    runs,
    intervals,
    scheduler,
    cancelled: () => cancelled,
    fire: () => ticks[0]?.(),
    // Waits for the latest tick and for the scheduler to release its overlap guard.
    tick: async () => {
      ticks[0]?.();
      const result = await runs.at(-1);
      await new Promise((resolve) => setImmediate(resolve));

      return result;
    },
  };
}

test('keep-alive makes one user request, persists the rotated cookie, and returns only a status', async () => {
  const f = await fixture();
  const before = await savedFile(f.store);
  const count = f.provider.calls.length;
  f.provider.rotation = 'synthetic-kept';
  const result = await f.client.keepAlive();
  expect(result).toEqual({ status: 'kept' });
  expectClean(JSON.stringify(result));
  expect(f.provider.paths(count)).toEqual([USER_PATH]);
  const after = await savedFile(f.store);
  expect(after.jar).toContain('synthetic-kept');
  expect(before.jar).not.toContain('synthetic-kept');
  expect({ ...after, jar: '' }).toEqual({ ...before, jar: '' });
  expectClean(await readStored(f.store));
  expect((await stat(f.store.path)).mode & 0o777).toBe(0o600);
});

test('keep-alive makes no request without a session or during a pause', async () => {
  const f = await fixture();
  await f.client.logout();
  const count = f.provider.calls.length;
  expect(await f.client.keepAlive()).toEqual({ status: 'skipped' });
  expect(f.provider.calls).toHaveLength(count);
  await assert.rejects(stat(f.path), /ENOENT/);
  expect(await readStored(f.store)).toBe('null');

  const limited = await fixture();
  const s = scheduled(limited.client);
  limited.provider.rateLimit = true;
  expect(await s.tick()).toEqual({ status: 'failed' });
  expect((await savedFile(limited.store)).pauseUntil).toBe(NOW + 60_000);
  limited.provider.rateLimit = false;
  const paused = limited.provider.calls.length;
  const file = await readStored(limited.store);
  // Rust: an unknown renewal age is overdue; the pause still sends no request.
  expect(await s.tick()).toEqual({ status: 'failed' });
  expect(await new InnaClient(limited.options).keepAlive()).toEqual({ status: 'failed' });
  expect(limited.provider.calls).toHaveLength(paused);
  expect(await readStored(limited.store)).toBe(file);
  s.scheduler.stop();
});

test('an expired session stops the keep-alive until a new import replaces it', async () => {
  const f = await fixture();
  const s = scheduled(f.client);
  expect(s.intervals).toEqual([600_000]);
  const count = f.provider.calls.length;
  expect(s.runs).toHaveLength(0);
  f.provider.unauthorized = true;
  const expired = await s.tick();
  expect(expired).toEqual({ status: 'signInRequired' });
  expectClean(JSON.stringify(expired));
  expect(f.provider.paths(count)).toEqual([USER_PATH]);
  expect(await s.tick()).toEqual({ status: 'skipped' });
  expect(await s.tick()).toEqual({ status: 'skipped' });
  expect(f.provider.calls).toHaveLength(count + 1);
  // The same refusal reaches a tool call with the existing message.
  await assert.rejects(f.client.overview(), /^SafeError: Inna sign-in is required\./);

  f.provider.unauthorized = false;
  f.provider.rotation = 'synthetic-renewed';
  await f.client.importSession(f.source);
  const renewed = f.provider.calls.length;
  expect(await s.tick()).toEqual({ status: 'kept' });
  expect(f.provider.paths(renewed)).toEqual([USER_PATH]);
  s.scheduler.stop();
  expect(s.cancelled()).toBe(1);
});

test('keep-alive on a session the browser moved to the sibling neither switches nor relearns', async () => {
  const f = await fixture();
  const before = await savedFile(f.store);
  f.provider.selected = SIBLING;
  f.provider.user = sibling;
  const count = f.provider.calls.length;
  expect(await f.client.keepAlive()).toEqual({ status: 'kept' });
  expect(f.provider.paths(count)).toEqual([USER_PATH]);
  expect(f.provider.switches).toBe(0);
  const after = await savedFile(f.store);
  expect(after.account).toEqual(before.account);
  expect(after.students).toEqual(before.students);
  expect(Object.keys(after.students)).toEqual(['1']);
});

test('two servers sharing a refused session stop asking, and replaced credentials resume', async () => {
  const f = await fixture();
  const clients = [f.client, new InnaClient(f.options)];
  f.provider.unauthorized = true;
  const start = f.provider.calls.length;
  const statuses: string[] = [];

  for (let round = 0; round < 4; round += 1)
    for (const client of clients) {
      // Cookie access times have millisecond resolution; each round must land on a new one.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const before = await readStored(f.store);
      statuses.push((await client.keepAlive()).status);

      // A refused request rewrites cookie access times; that alone must not look like a new session.
      if (statuses.at(-1) === 'signInRequired') expect(await readStored(f.store)).not.toBe(before);
    }

  expect(statuses).toEqual([
    'signInRequired',
    'signInRequired',
    ...Array.from({ length: 6 }, () => 'skipped'),
  ]);
  expect(f.provider.calls).toHaveLength(start + 2);
  // A tool call on the dead session rewrites the jar without changing the credentials.
  await assert.rejects(f.client.overview(), /^SafeError: Inna sign-in is required\./);
  const afterTool = f.provider.calls.length;

  for (const client of clients) expect(await client.keepAlive()).toEqual({ status: 'skipped' });
  expect(f.provider.calls).toHaveLength(afterTool);
  expectClean(JSON.stringify(Object.entries(f.client)));

  f.provider.unauthorized = false;
  f.provider.rotation = 'synthetic-replaced';
  await f.client.importSession(f.source);
  const replaced = f.provider.calls.length;

  for (const client of clients) expect(await client.keepAlive()).toEqual({ status: 'kept' });
  expect(f.provider.paths(replaced)).toEqual([USER_PATH, USER_PATH]);
});

test('a cookie value rotated by Inna counts as new credentials for a refused session', async () => {
  const f = await fixture();
  f.provider.unauthorized = true;
  expect(await f.client.keepAlive()).toEqual({ status: 'signInRequired' });
  expect(await f.client.keepAlive()).toEqual({ status: 'skipped' });
  expect(await readStored(f.store)).toContain('synthetic-rotated');
  await updateStored(f.store, (saved) => saved.replace('synthetic-rotated', 'synthetic-other'));
  const count = f.provider.calls.length;
  expect(await f.client.keepAlive()).toEqual({ status: 'signInRequired' });
  expect(await f.client.keepAlive()).toEqual({ status: 'skipped' });
  expect(f.provider.calls).toHaveLength(count + 1);
});

test('the keep-alive opt-out is a serve flag only', async () => {
  for (const args of [
    ['auth', 'status', '--no-keep-alive'],
    ['auth', 'logout', '--no-keep-alive'],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'inna-offline-'));
    directories.push(directory);

    const child = Bun.spawn({
      // Rust: the binary in place of the TypeScript CLI.
      cmd: [process.env.INNA_RUST_BINARY!, ...args],
      env: {
        ...process.env,
        INNA_SESSION_FILE: join(directory, 'session.json'),
        ...storeEnvironment(join(directory, 'store')),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe('');
    expect(await new Response(child.stderr).text()).toBe('Invalid command. Run inna-mcp --help.\n');
  }
});

const COOKIE_VALUES = [
  'synthetic-session',
  'synthetic-xsrf',
  'synthetic-rotated',
  'synthetic-kept',
  'synthetic-planted',
];

// The owner's own cookie export is the only plaintext copy a test directory may hold.
async function plaintextCookies(f: { directory: string; source: string }) {
  return (await filesContaining(COOKIE_VALUES, f.directory)).filter((path) => path !== f.source);
}

const bytes = (path: string) => readFile(path).then(String, () => undefined);

// Everything a store operation could change, the absence record included.
const storeFiles = (f: { path: string; store: ReturnType<typeof storeAt> }) =>
  Promise.all(
    [f.store.path, `${f.store.path}.marker`, f.store.key, f.path, `${f.path}.absence.json`].map(
      bytes,
    ),
  );

async function generation(store: Store) {
  return Number(
    /"generation":(\d+)/.exec(await readFile(`${store.path}.marker`, 'utf8'))?.[1] ?? Number.NaN,
  );
}

test('the session is saved only encrypted after import, keep-alive, and reads', async () => {
  const f = await fixture(true);
  expect(await plaintextCookies(f)).toEqual([]);
  expect(await f.client.status()).toMatchObject({
    authenticated: true,
    storage: 'Saved in an encrypted file.',
  });
  await assert.rejects(stat(f.path), /ENOENT/);
  expect((await stat(f.store.path)).mode & 0o777).toBe(0o600);
  expect((await stat(f.store.key)).mode & 0o777).toBe(0o600);

  f.provider.rotation = 'synthetic-kept';
  expect(await f.client.keepAlive()).toEqual({ status: 'kept' });
  expect(await readStored(f.store)).toContain('synthetic-kept');
  await f.client.prepareAbsence(request);
  await f.client.overview(undefined, SIBLING);
  expect(await plaintextCookies(f)).toEqual([]);
  // The absence record stays a plaintext private file beside the legacy session path.
  expect(JSON.parse((await bytes(`${f.path}.absence.json`)) ?? '')).toMatchObject({
    state: 'prepared',
  });
});

test('auth migrate moves a plaintext session once; later plaintext files are never read', async () => {
  const f = await fixture(true);
  const preview = await f.client.prepareAbsence(request);
  const absence = await bytes(`${f.path}.absence.json`);
  const legacy = await readStored(f.store);
  const planted = legacy.replaceAll('synthetic-rotated', 'synthetic-planted');
  const store = storeAt(join(f.directory, 'unmigrated'));
  const cookies: string[] = [];

  const client = new InnaClient({
    ...f.options,
    store,
    fetch: (url, options) => {
      cookies.push(new Headers(options.headers).get('Cookie') ?? '');

      return f.provider.fetch(url, options);
    },
  });

  expect(await client.status()).toEqual({ authenticated: false });
  await assert.rejects(client.migrate(), /^SafeError: No Inna session\./);
  await assert.rejects(stat(`${store.path}.marker`), /ENOENT/);

  await writeFile(f.path, legacy, { mode: 0o600 });
  expect(await client.status()).toMatchObject({
    storage: 'Saved in a plaintext file. Run inna-mcp auth migrate.',
  });
  expect((await client.absenceStatus()).operation?.operationId).toBe(preview.operationId);
  expect(await client.migrate()).toBe('migrated');
  await assert.rejects(stat(f.path), /ENOENT/);
  expect(parseSaved(await readStored(store)).account).toEqual(parseSaved(legacy).account);
  expect(await client.status()).toMatchObject({ storage: 'Saved in an encrypted file.' });
  expect(await client.migrate()).toBe('already');
  expect(await plaintextCookies(f)).toEqual([]);

  // A plaintext file planted after the marker exists is removed unread.
  await writeFile(f.path, planted, { mode: 0o600 });
  expect(await client.keepAlive()).toEqual({ status: 'kept' });
  expect((await client.overview()).context.studentId).toBe('2');
  expect((await client.absenceStatus()).operation?.operationId).toBe(preview.operationId);
  expect(await bytes(f.path)).toBe(planted);
  expect(await client.migrate()).toBe('already-removed-legacy');
  await assert.rejects(stat(f.path), /ENOENT/);

  // Logout keeps the store deciding, so a planted file stays unread and login is still needed.
  await client.logout();
  await writeFile(f.path, planted, { mode: 0o600 });
  const calls = f.provider.calls.length;
  expect(await client.status()).toEqual({ authenticated: false });
  expect(await client.keepAlive()).toEqual({ status: 'skipped' });
  expect(await client.defaultUserId()).toBeUndefined();
  await assert.rejects(client.overview(), /^SafeError: No Inna session\./);
  expect(f.provider.calls).toHaveLength(calls);
  expect(await client.migrate()).toBe('already-removed-legacy');
  expect(await readStored(store)).toBe('null');
  expect(cookies.join('\n')).not.toContain('synthetic-planted');
  expect(cookies.length).toBeGreaterThan(0);
  expect(await bytes(`${f.path}.absence.json`)).toBe(absence);
});

test('the CLI migrates a plaintext session, reports where it is saved, and repeats safely', async () => {
  const f = await fixture();
  const directory = join(f.directory, 'cli');
  const path = join(directory, 'session.json');
  await mkdir(directory);
  await writeFile(path, await readStored(f.store), { mode: 0o600 });
  await writeFile(`${path}.absence.json`, 'synthetic absence record', { mode: 0o600 });

  async function run(...args: string[]) {
    const child = Bun.spawn({
      // Rust: the binary in place of the TypeScript CLI, with no upstream to reach.
      cmd: [process.env.INNA_RUST_BINARY!, 'auth', ...args],
      env: {
        ...process.env,
        INNA_TEST_ORIGIN: 'http://127.0.0.1:9',
        INNA_SESSION_FILE: path,
        ...storeEnvironment(join(directory, 'store')),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return {
      exit: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  }

  expect(await run('migrate')).toEqual({
    exit: 0,
    stdout: 'Inna session moved to the encrypted store; the plaintext file was removed.\n',
    stderr: '',
  });
  await assert.rejects(stat(path), /ENOENT/);
  expect(await filesContaining(COOKIE_VALUES, directory)).toEqual([]);
  expect(await readStored(storeAt(join(directory, 'store')))).toBe(await readStored(f.store));
  expect((await run('migrate')).stdout).toBe('Already migrated.\n');
  await writeFile(path, 'not a session', { mode: 0o600 });
  expect((await run('migrate')).stdout).toBe(
    'Already migrated. Removed the leftover plaintext session file.\n',
  );
  expect(await run('logout')).toMatchObject({ exit: 0, stderr: '' });
  expect(await run('status')).toEqual({ exit: 0, stdout: 'No saved Inna session.\n', stderr: '' });
  expect(await bytes(`${path}.absence.json`)).toBe('synthetic absence record');
});

test('a login or import before migration moves the plaintext session into the store', async () => {
  const f = await fixture(true);
  await f.client.prepareAbsence(request);
  await f.client.overview(undefined, SIBLING);
  await f.client.overview();
  const absence = await bytes(`${f.path}.absence.json`);
  const legacy = await readStored(f.store);
  const store = storeAt(join(f.directory, 'unmigrated'));
  const client = new InnaClient({ ...f.options, store });
  await writeFile(f.path, legacy, { mode: 0o600 });

  // The plaintext session still decides what an import may replace.
  f.provider.user = { ...f.provider.user, studentId: '99' };
  await assert.rejects(client.importSession(f.source), /changes the account/);
  expect(await bytes(f.path)).toBe(legacy);
  await assert.rejects(stat(`${store.path}.marker`), /ENOENT/);
  await assert.rejects(stat(store.key), /ENOENT/);

  f.provider.user = { ...f.provider.user, studentId: '2' };
  expect(await client.importSession(f.source)).toEqual({
    storage: 'Saved in an encrypted file.',
    replaced: false,
  });
  await assert.rejects(stat(f.path), /ENOENT/);
  // The students learned before the import are kept, as in a replacement import.
  expect(Object.keys((await savedFile(store)).students).toSorted()).toEqual(['1', SIBLING]);
  expect(await plaintextCookies(f)).toEqual([]);
  expect(await bytes(`${f.path}.absence.json`)).toBe(absence);
});

test('a jar that cannot be written back removes the record and is never offered again', async () => {
  const f = await fixture(true);
  await f.client.prepareAbsence(request);
  const absence = await bytes(`${f.path}.absence.json`);
  const uncertain = /^SafeError: The last write to the Inna session store did not complete/;
  f.provider.rotation = `synthetic-huge-${'x'.repeat(MAX_SESSION_BYTES)}`;
  await assert.rejects(f.client.overview(), uncertain);
  f.provider.rotation = 'synthetic-rotated';
  await assert.rejects(stat(f.store.path), /ENOENT/);
  await writeFile(f.path, 'planted plaintext session', { mode: 0o600 });
  const files = await storeFiles(f);
  const calls = f.provider.calls.length;

  for (const refused of [
    () => f.client.overview(),
    () => f.client.status(),
    () => f.client.absenceStatus(),
    () => f.client.defaultUserId(),
    () => f.client.checkStore(),
    () => f.client.migrate(),
    () => f.client.logout(),
    () => f.client.importSession(f.source),
  ])
    await assert.rejects(refused(), uncertain);
  expect(await f.client.keepAlive()).toEqual({ status: 'failed' });
  expect(f.provider.calls).toHaveLength(calls);
  expect(await storeFiles(f)).toEqual(files);
  expect(await bytes(`${f.path}.absence.json`)).toBe(absence);
});

test('a failed write-back with unchanged cookies keeps the record for the next read', async () => {
  const f = await fixture(true);
  await f.client.overview(); // Settles the cookie the fake rotates to on every user read.
  const record = await bytes(f.store.path);
  const marker = `${f.store.path}.marker`;
  const markerBytes = await readFile(marker);
  let blocked = false;

  // After the read, a directory in place of the marker makes the write-back fail before any
  // file changed; Inna returned the same cookie, so nothing was spent.
  const client = new InnaClient({
    ...f.options,
    fetch: async (input, init) => {
      if (blocked) {
        blocked = false;
        rmSync(marker);
        mkdirSync(marker);
      }

      return f.provider.fetch(input, init);
    },
  });

  blocked = true;
  await assert.rejects(client.overview(), /^SafeError: Cannot access the private Inna files\./);
  expect(await bytes(f.store.path)).toBe(record);

  await rm(marker, { recursive: true });
  await writeFile(marker, markerBytes, { mode: 0o600 });
  expect(await client.overview()).toBeDefined();
});

const storeOperations = (client: InnaClient) => [
  () => client.overview(),
  () => client.status(),
  () => client.absenceStatus(),
  () => client.migrate(),
  () => client.logout(),
];

test('store failures are fixed messages or a keep-alive status; only a login or import replaces a lost key', async () => {
  const f = await fixture(true);
  await f.client.prepareAbsence(request);
  await writeFile(f.path, 'planted plaintext session', { mode: 0o600 });
  const files = await storeFiles(f);
  const calls = f.provider.calls.length;

  // Rust: the binary reads only its key file, so no key provider can throw each store code;
  // session::tests::store_failures_get_fixed_messages checks this table's messages.

  // A lost key refuses everything except the explicit sign-in that replaces the store.
  await rm(f.store.key);

  for (const refused of storeOperations(f.client))
    await assert.rejects(
      refused(),
      /^SafeError: The Inna store key is missing\. Run inna-mcp auth/,
    );
  expect(await f.client.keepAlive()).toEqual({ status: 'failed' });
  expect(await f.client.defaultUserId()).toBeUndefined();
  await f.client.checkStore();
  expect(f.provider.calls).toHaveLength(calls);
  expect(await storeFiles(f)).toEqual([files[0], files[1], undefined, files[3], files[4]]);

  // A failed sign-in replaces nothing either.
  f.provider.unauthorized = true;
  await assert.rejects(f.client.importSession(f.source), /sign-in is required/);
  f.provider.unauthorized = false;
  expect(await storeFiles(f)).toEqual([files[0], files[1], undefined, files[3], files[4]]);

  expect(await f.client.importSession(f.source)).toEqual({
    storage: 'Saved in an encrypted file.',
    replaced: true,
  });
  expect((await f.client.status()).authenticated).toBe(true);
  // The sign-in that replaced the store also removes the leftover plaintext file.
  expect(await bytes(f.path)).toBeUndefined();
  expect(await bytes(`${f.path}.absence.json`)).toBe(files[4]);
  expect(await plaintextCookies(f)).toEqual([]);
});

test('a store with a marker but no record never reads the plaintext file, and migrate resumes', async () => {
  const f = await fixture();
  const legacy = await readStored(f.store);
  // A sign-in that replaced a lost key's store and died before writing the new record.
  await rm(f.store.key);
  await resetStored(f.store);
  await writeFile(f.path, legacy, { mode: 0o600 });
  const calls = f.provider.calls.length;
  expect(await f.client.status()).toEqual({ authenticated: false });
  expect(await f.client.keepAlive()).toEqual({ status: 'skipped' });
  await assert.rejects(f.client.overview(), /^SafeError: No Inna session\./);
  expect(f.provider.calls).toHaveLength(calls);
  expect(await bytes(f.path)).toBe(legacy);
  expect(await f.client.migrate()).toBe('migrated');
  await assert.rejects(stat(f.path), /ENOENT/);
  expect((await f.client.overview()).context.studentId).toBe('2');
});

test('any read sweeps a stale absence-record temporary and keeps a fresh one', async () => {
  const f = await fixture();
  const stale = `${f.path}.absence.json.${crypto.randomUUID()}.tmp`;
  const fresh = `${f.path}.absence.json.${crypto.randomUUID()}.tmp`;
  await writeFile(stale, 'synthetic', { mode: 0o600 });
  await writeFile(fresh, 'synthetic', { mode: 0o600 });
  await utimes(stale, 0, 0);
  await f.client.status();
  await assert.rejects(stat(stale), /ENOENT/);
  await stat(fresh);
});

test('a sign-in onto a store that already decides removes a leftover plaintext file', async () => {
  const f = await fixture();
  await writeFile(f.path, 'planted plaintext session', { mode: 0o600 });
  await f.client.importSession(f.source);
  await assert.rejects(stat(f.path), /ENOENT/);

  // Also on a marker without a record, as a reset that died before its write leaves it.
  await rm(f.store.key);
  await resetStored(f.store);
  await writeFile(f.path, 'planted plaintext session', { mode: 0o600 });
  await f.client.importSession(f.source);
  await assert.rejects(stat(f.path), /ENOENT/);
  expect((await f.client.overview()).context.studentId).toBe('2');
});

test('a record without its marker is uncertain, not a reason to read the plaintext file', async () => {
  const f = await fixture();
  const legacy = await readStored(f.store);
  await rm(`${f.store.path}.marker`);
  await writeFile(f.path, legacy, { mode: 0o600 });
  const files = await storeFiles(f);
  const calls = f.provider.calls.length;

  for (const refused of [...storeOperations(f.client), () => f.client.importSession(f.source)])
    await assert.rejects(refused(), /^SafeError: The last write to the Inna session store/);
  expect(await f.client.keepAlive()).toEqual({ status: 'failed' });
  expect(f.provider.calls).toHaveLength(calls);
  expect(await storeFiles(f)).toEqual(files);
});

test('a session path that overlaps the store, its key, or their namespaces is refused untouched', async () => {
  const f = await fixture(true);
  await f.client.prepareAbsence(request);
  const files = await storeFiles(f);
  const link = join(f.directory, 'link');
  await symlink(join(f.directory, 'store'), link);
  const elsewhere = new LocalKeyFileProvider({ path: join(f.directory, 'elsewhere', 'key') });

  const aliases: Pick<
    ConstructorParameters<typeof InnaClient>[0] & object,
    'sessionFile' | 'store'
  >[] = [
    { sessionFile: f.store.path },
    { sessionFile: `${f.store.path}.marker` },
    { sessionFile: `${f.store.path}.lock` },
    { sessionFile: f.store.key },
    { sessionFile: join(`${f.store.path}.lock`, 'session.json') },
    { sessionFile: join(link, 'config', 'inna-mcp', 'session.enc') },
    { sessionFile: f.store.path.replace(/\.enc$/, '') },
    { store: { path: `${f.path}.absence.json`, keys: elsewhere } },
    { store: { path: `${f.path}.lock`, keys: elsewhere } },
    { store: { path: join(`${f.path}.absence.json.lock`, 'session.enc'), keys: elsewhere } },
    { store: { path: f.store.path, keys: new LocalKeyFileProvider({ path: f.path }) } },
    {
      store: {
        path: f.store.path,
        keys: new LocalKeyFileProvider({ path: `${f.path}.absence.json` }),
      },
    },
  ];

  // Rust: the binary's store and key follow its own layout, so only the session path moves; a
  // store or key moved onto the session or absence path is the same overlap seen from the other
  // side, which session::tests::collisions_compare_namespaces_beside_and_above_each_other checks.
  for (const alias of aliases.filter((alias) => !alias.store)) {
    const client = new InnaClient({ ...f.options, ...alias });

    for (const refused of [
      () => client.overview(),
      () => client.status(),
      () => client.absenceStatus(),
      () => client.defaultUserId(),
      () => client.checkStore(),
      () => client.importSession(f.source),
      () => client.migrate(),
      () => client.logout(),
    ])
      await assert.rejects(
        refused(),
        /^SafeError: INNA_SESSION_FILE overlaps the encrypted Inna session store or its key\. Choose another path\.$/,
      );
    expect(await client.keepAlive()).toEqual({ status: 'failed' });
    expect(await storeFiles(f)).toEqual(files);
  }

  expect((await readdir(join(f.directory, 'store', 'config', 'inna-mcp'))).toSorted()).toEqual([
    'session.enc',
    'session.enc.marker',
  ]);
  await assert.rejects(stat(join(f.directory, 'elsewhere')), /ENOENT/);
  expect((await f.client.absenceStatus()).operation?.state).toBe('prepared');
});

const digits = (index: number) => String(index).padStart(32, '9');

test('the record limit is exactly the largest session the schema accepts', async () => {
  const f = await fixture();
  const control = '\u0001';

  const worst = savedSchema.parse({
    version: 2,
    jar: control.repeat(MAX_SESSION_BYTES),
    account: { userId: Number.MAX_SAFE_INTEGER, studentId: digits(0), schoolId: digits(0) },
    students: Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        digits(index),
        {
          userId: Number.MAX_SAFE_INTEGER,
          studentId: digits(index),
          schoolId: digits(index),
          studentName: control.repeat(1000),
        },
      ]),
    ),
    pauseUntil: -Number.MAX_VALUE,
  });

  const text = JSON.stringify(worst);
  expect(Buffer.byteLength(text)).toBe(RECORD_MAX_BYTES);
  await updateStored(f.store, () => text);
  expect(await readStored(f.store)).toBe(text);
  expect(savedSchema.safeParse({ ...worst, jar: `${worst.jar}x` }).success).toBe(false);
});

test('a session with more saved students than the bound is refused with one fixed message', async () => {
  const f = await fixture();

  const tooMany =
    /^SafeError: This Inna session holds more saved students than this version keeps\. Run inna-mcp auth logout, then sign in again\.$/;

  const saved = parseSaved(await readStored(f.store));

  const withStudents = (count: number) =>
    JSON.stringify({
      ...saved,
      students: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          digits(index),
          {
            userId: index + 100,
            studentId: digits(index),
            schoolId: '3',
            studentName: 'Synthetic',
          },
        ]),
      ),
    });

  // Learning a 65th student is refused; only the jar is written back.
  await updateStored(f.store, () => withStudents(64));
  const before = await generation(f.store);
  await assert.rejects(f.client.overview(undefined, SIBLING), tooMany);
  expect(await generation(f.store)).toBe(before + 1);
  const after = parseSaved(await readStored(f.store));
  expect(Object.keys(after.students).toSorted()).toEqual(
    Object.keys(parseSaved(withStudents(64)).students).toSorted(),
  );

  // A stored record or an unmigrated plaintext file holding 65 is refused before any request.
  await updateStored(f.store, () => withStudents(65));
  const record = await bytes(f.store.path);
  const calls = f.provider.calls.length;
  await assert.rejects(f.client.overview(), tooMany);
  expect(await bytes(f.store.path)).toBe(record);

  const client = new InnaClient({ ...f.options, store: storeAt(join(f.directory, 'unmigrated')) });
  await writeFile(f.path, withStudents(65), { mode: 0o600 });
  await assert.rejects(client.overview(), tooMany);
  await assert.rejects(client.migrate(), tooMany);
  expect(f.provider.calls).toHaveLength(calls);
});

test('clients sharing one store are serialized, and logout waits for a request in flight', async () => {
  const f = await fixture();
  let active = 0;
  let maximum = 0;
  const gate = Promise.withResolvers<void>();
  let hold = false;

  const options = {
    ...f.options,
    fetch: async (url: string, init: RequestInit) => {
      active += 1;
      maximum = Math.max(maximum, active);

      try {
        if (hold) await gate.promise;
        else await new Promise((resolve) => setTimeout(resolve, 2));

        return await f.provider.fetch(url, init);
      } finally {
        active -= 1;
      }
    },
  };

  const clients = [new InnaClient(options), new InnaClient(options), new InnaClient(options)];
  const before = await generation(f.store);

  await Promise.all(
    clients.flatMap((client) => [client.overview(), client.keepAlive(), client.listStudents()]),
  );
  expect(maximum).toBe(1);
  // Each of the nine operations wrote its jar back once, in its own hold.
  expect(await generation(f.store)).toBe(before + 9);

  hold = true;
  const reading = clients[0]?.keepAlive();
  await new Promise((resolve) => setTimeout(resolve, 20));
  let loggedOut = false;

  const logout = (async () => {
    await clients[1]?.logout();
    loggedOut = true;
  })();

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(loggedOut).toBe(false);
  gate.resolve();
  expect(await reading).toEqual({ status: 'kept' });
  await logout;
  expect(await readStored(f.store)).toBe('null');
  expect(maximum).toBe(1);
});
