import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { InnaClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { dateRange, plainText, type User } from '../src/schemas.js';

const NOW = Date.parse('2040-01-02T12:00:00Z');

const directories: string[] = [];

const request = {
  kind: 'sick',
  dateFrom: '2040-01-02',
  dateTo: '2040-01-02',
  reason: 'Synthetic reason',
} satisfies Parameters<InnaClient['prepareAbsence']>[0];

class Provider {
  readonly calls: { url: URL; method: string; body: string | undefined }[] = [];
  posts = 0;
  failPost = false;
  redirect = false;
  rateLimit = false;
  user: User = {
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

  fetch = async (value: string, options: RequestInit): Promise<Response> => {
    const url = new URL(value);
    expect(url.origin).toBe('https://nam.inna.is');
    expect(options.redirect).toBe('manual');
    const headers = new Headers(options.headers);
    expect(headers.get('X-Requested-By')).toBe('XMLHttpRequest');
    expect(headers.get('X-XSRF-TOKEN')).toBe('synthetic-xsrf');
    expect(headers.get('Cookie')).toContain('SESSION=synthetic-');
    this.calls.push({
      url,
      method: options.method ?? 'GET',
      body: z.string().optional().parse(options.body),
    });

    if (this.redirect)
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://example.invalid/credential-trap' },
      });

    if (this.rateLimit)
      return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });

    if (url.pathname === '/api/UserData/GetLoggedInUser')
      return Response.json(
        { ...this.user, studentIdNumber: 'DO-NOT-RETURN', privateToken: 'DO-NOT-RETURN' },
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

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
      expect(result.structuredContent, name).toBeDefined();
      expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN');
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

test('dates and plain text fail safely on malformed inputs', () => {
  expect(dateRange.safeParse({ dateFrom: '2040-02-30', dateTo: '2040-03-01' }).success).toBe(false);
  expect(dateRange.safeParse({ dateFrom: '2040-03-02', dateTo: '2040-03-01' }).success).toBe(false);
  expect(plainText('<p>A &amp; B</p><style>hidden</style><script>hidden</script><p>C</p>')).toBe(
    'A & B\n\nC',
  );
});
