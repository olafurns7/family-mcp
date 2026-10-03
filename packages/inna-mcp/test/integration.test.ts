import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { InnaClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import {
  absencePreviewSchema,
  absenceRecordSchema,
  dateRange,
  plainText,
  type User,
} from '../src/schemas.js';

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

    if (url.pathname === '/api/UserData/GetLoggedInUser')
      return Response.json(
        {
          ...this.user,
          access: this.access(),
          studentIdNumber: 'DO-NOT-RETURN',
          privateToken: 'DO-NOT-RETURN',
        },
        { headers: { 'Set-Cookie': 'SESSION=synthetic-rotated; Path=/; Secure; HttpOnly' } },
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
  const options = { sessionFile: path, fetch: provider.fetch, now: () => NOW, allowAbsenceWrites };
  const client = new InnaClient(options);
  await client.importSession(source);

  return { client, provider, options, path, source };
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test('every read tool round-trips through MCP without marking read or fetching external links', async () => {
  const f = await fixture();
  const server = createServer(f.options);
  const client = new Client({ name: 'inna-offline', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

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
  const server = createServer(f.options);
  const client = new Client({ name: 'inna-write-offline', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

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
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
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

    const saved = z
      .object({ pauseUntil: z.number() })
      .parse(JSON.parse(await readFile(f.path, 'utf8')));

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

  const stalled = new InnaClient({
    ...f.options,
    now: () => now,
    fetch: async (url, options) => {
      const response = await f.provider.fetch(url, options);

      return new URL(url).pathname === '/api/Messages/GetReceivedMessages'
        ? new Response(new ReadableStream(), { headers: { 'Content-Type': 'application/json' } })
        : response;
    },
  });

  await assert.rejects(stalled.messages(1, 21, AbortSignal.timeout(30)), /timed out/i);
  expect(f.provider.posts).toBe(0);
});

test('private import, principal binding, redirect refusal, and shared rate-limit pause', async () => {
  const f = await fixture();
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  await chmod(f.source, 0o644);
  await assert.rejects(f.client.importSession(f.source));
  await chmod(f.source, 0o600);
  const before = await readFile(f.path, 'utf8');
  f.provider.user = { ...f.provider.user, studentId: '99' };
  await assert.rejects(f.client.importSession(f.source), /changes the account/);
  expect(await readFile(f.path, 'utf8')).toBe(before);
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

async function savedFile(path: string) {
  return z
    .object({
      version: z.number(),
      jar: z.string(),
      account: z.object({ userId: z.number(), studentId: z.string(), schoolId: z.string() }),
      students: z.record(z.string(), z.object({ studentId: z.string(), studentName: z.string() })),
      pauseUntil: z.number(),
    })
    .parse(JSON.parse(await readFile(path, 'utf8')));
}

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
  expectClean(await readFile(f.path, 'utf8'));
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

  const saved = await savedFile(f.path);
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
  expect((await savedFile(ignored.path)).students[SIBLING]).toBeUndefined();

  for (const location of [
    'https://r.inna.is/login',
    'http://example.invalid/Components/Students/Students.html',
    'https://nam.inna.is/Components/Other/Other.html',
    'https://nam.inna.is:8443/Components/Students/Students.html',
  ]) {
    const f = await fixture();
    f.provider.switchLocation = location;
    await assert.rejects(f.client.overview(undefined, SIBLING), /sign-in is required/);
    expect(f.provider.paths().slice(-1)).toEqual(['/auth/system']);
  }

  const limited = await fixture();
  limited.provider.switchRateLimit = true;
  await assert.rejects(limited.client.overview(undefined, SIBLING), /rate limited/);
  expect((await savedFile(limited.path)).pauseUntil).toBe(NOW + 120_000);
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
  const { jar, account, pauseUntil } = await savedFile(f.path);
  await writeFile(f.path, JSON.stringify({ version: 1, jar, account, pauseUntil }));
  expect((await f.client.overview()).context.studentId).toBe('2');
  const migrated = await savedFile(f.path);
  expect(migrated.version).toBe(2);
  expect(Object.keys(migrated.students)).toEqual(['1']);
  expect((await f.client.overview(undefined, SIBLING)).context.studentId).toBe('6');
  expect((await f.client.overview()).context.studentId).toBe('2');
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);

  // A version 1 file whose browser session moved to the sibling switches back to its default.
  f.provider.selected = SIBLING;
  f.provider.user = sibling;
  await writeFile(f.path, JSON.stringify({ version: 1, jar, account, pauseUntil }));
  const switches = f.provider.switches;
  expect((await f.client.overview()).context.studentId).toBe('2');
  expect(f.provider.switches).toBe(switches + 1);
});

test('a learned student binding that later differs is refused', async () => {
  const f = await fixture();
  await f.client.overview(undefined, SIBLING);
  await f.client.overview();
  f.provider.contexts.set(SIBLING, { ...sibling, studentId: '77' });
  const from = f.provider.calls.length;
  await assert.rejects(f.client.overview(undefined, SIBLING), /changed account/);
  expect(f.provider.paths(from)).not.toContain('/api/StudentTerms/GetStudentTerms');
  expect((await savedFile(f.path)).students[SIBLING]?.studentId).toBe('6');

  expectClean(await readFile(f.path, 'utf8'));

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
    expect((await savedFile(strict.path)).students[SIBLING]).toBeUndefined();
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
  expect((await savedFile(duplicate.path)).students[SIBLING]).toBeUndefined();
});

test('import onto a learned sibling is refused unless the account change is deliberate', async () => {
  const f = await fixture(true);
  await f.client.prepareAbsence(request);
  await f.client.overview(undefined, SIBLING);
  const before = await readFile(f.path, 'utf8');
  await assert.rejects(f.client.importSession(f.source), /Select the default student/);
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect((await f.client.absenceStatus()).operation?.account.studentId).toBe('2');

  await f.client.importSession(f.source, true);
  const replaced = await savedFile(f.path);
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
  const server = createServer(f.options);
  const client = new Client({ name: 'inna-students-offline', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

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

test('dates and plain text fail safely on malformed inputs', () => {
  expect(dateRange.safeParse({ dateFrom: '2040-02-30', dateTo: '2040-03-01' }).success).toBe(false);
  expect(dateRange.safeParse({ dateFrom: '2040-03-02', dateTo: '2040-03-01' }).success).toBe(false);
  expect(plainText('<p>A &amp; B</p><style>hidden</style><script>hidden</script><p>C</p>')).toBe(
    'A & B\n\nC',
  );
});
