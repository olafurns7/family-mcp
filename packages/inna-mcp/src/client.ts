import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Cookie, CookieJar } from 'tough-cookie';
import { z } from 'zod';
import { SafeError, readBody } from '@family-mcp/mcp-runtime';
import {
  defaultSessionPath,
  readPrivateFile,
  writePrivateFile,
  withFileLock,
  SessionStoreError,
  sweepTemp,
} from '@family-mcp/session-store';
import * as schemas from './schemas.js';
import { normalizeDate, parseDates } from './dates.js';

const ORIGIN = 'https://nam.inna.is';

const MAX_SESSION_BYTES = 262_144;

const cookieNames = new Set(['SESSION', 'JSESSIONID', 'XSRF-TOKEN']);

const savedSchema = z.object({
  version: z.literal(1),
  jar: z.string().max(MAX_SESSION_BYTES),
  account: schemas.bindingSchema,
  pauseUntil: z.number().default(0),
});

type Saved = z.infer<typeof savedSchema>;

type Fetch = (url: string, options: RequestInit) => Promise<Response>;

type AbsenceRecord = z.infer<typeof schemas.absenceRecordSchema>;

type AbsencePayload = {
  firstDay: string;
  lastDay: string;
  leaveStatus: 0;
  leaveType: 1 | 3;
  allDay: 1;
  comment: string;
};

const exportedCookieSchema = z.object({
  name: z.string(),
  value: z.string().min(1).max(65_536),
  domain: z.string(),
  path: z.string().default('/'),
  secure: z.boolean().default(true),
  httpOnly: z.boolean().default(false),
  expires: z.number().optional(),
  expirationDate: z.number().optional(),
  sameSite: z.string().optional(),
});

const cookieExportSchema = z.union([
  z.array(exportedCookieSchema),
  z.object({ cookies: z.array(exportedCookieSchema) }),
]);

export function sessionPath(): string {
  const path = process.env.INNA_SESSION_FILE ?? defaultSessionPath('inna-mcp');

  if (!isAbsolute(path)) throw new SafeError('INNA_SESSION_FILE must be an absolute path.');

  return path;
}

function sameAccount(a: schemas.Binding, b: schemas.Binding): boolean {
  return a.userId === b.userId && a.studentId === b.studentId && a.schoolId === b.schoolId;
}

function canRegisterAbsence(user: schemas.User, kind: schemas.AbsenceInput['kind']): boolean {
  if (kind === 'sick')
    return (
      (user.logInType === '2' && user.registerAbsenceGuardian === '1') ||
      (!user.olderThan18 && user.registerAbsenceUnder18 === '1') ||
      (user.olderThan18 && user.registerAbsenceOver18 === '1')
    );

  return (
    (user.logInType === '2' && (user.registerLeave === '1' || user.registerAbsence === '1')) ||
    (user.logInType === '1' &&
      user.olderThan18 &&
      (user.student18RegisterLeave === '1' || user.student18RegisterAbsence === '1'))
  );
}

async function readSaved(path: string): Promise<Saved | undefined> {
  try {
    return savedSchema.parse(
      JSON.parse(await readPrivateFile(path, { maxBytes: MAX_SESSION_BYTES })),
    );
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return undefined;
    throw new SafeError(
      'Cannot read the Inna session. Check its format and owner-only permissions.',
    );
  }
}

async function readAbsence(path: string): Promise<AbsenceRecord | undefined> {
  try {
    return schemas.absenceRecordSchema.parse(
      JSON.parse(await readPrivateFile(`${path}.absence.json`, { maxBytes: 32_768 })),
    );
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return undefined;
    throw new SafeError(
      'Cannot read the private absence record. Do not delete it to retry a submission.',
    );
  }
}

async function saveAbsence(path: string, record: AbsenceRecord): Promise<void> {
  await writePrivateFile(`${path}.absence.json`, JSON.stringify(record));
}

function upstreamDate(value: string): string {
  const parsed = normalizeDate(value);

  if (!parsed)
    throw new SafeError(
      'Inna returned an unrecognized absence date. Review history before submitting.',
    );

  return parsed.slice(0, 10);
}

class Connection {
  constructor(
    readonly jar: CookieJar,
    private readonly saved: Pick<Saved, 'pauseUntil'>,
    private readonly fetcher: Fetch,
    private readonly now: () => number,
    private readonly signal?: AbortSignal,
  ) {}

  async request<T extends z.ZodType>(
    endpoint: string,
    schema: T,
    params = new URLSearchParams(),
    body?: AbsencePayload,
  ): Promise<z.output<T>> {
    if (this.saved.pauseUntil > this.now())
      throw new SafeError('Inna requested a pause. Wait before making another request.');
    const url = new URL(endpoint, ORIGIN);

    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/'))
      throw new SafeError('Inna requests must use the verified API origin.');
    url.search = params.toString();
    const cookies = await this.jar.getCookies(url.href);
    const xsrf = cookies.find((cookie) => cookie.key === 'XSRF-TOKEN');

    if (!cookies.some((cookie) => cookie.key === 'SESSION') || !xsrf)
      throw new SafeError(
        'Inna session expired. Run inna-mcp auth login or import a fresh private browser cookie export.',
      );

    const headers = new Headers({
      Accept: 'application/json',
      'X-Requested-By': 'XMLHttpRequest',
      Cookie: await this.jar.getCookieString(url.href),
      'X-XSRF-TOKEN': xsrf.value,
    });

    if (body) headers.set('Content-Type', 'application/json;charset=UTF-8');
    const timeout = AbortSignal.timeout(30_000);

    const options: RequestInit = {
      method: body ? 'POST' : 'GET',
      headers,
      redirect: 'manual',
      signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
    };

    if (body) options.body = JSON.stringify(body);
    const response = await this.fetcher(url.href, options);

    for (const header of response.headers.getSetCookie()) {
      const cookie = Cookie.parse(header);

      if (cookie && cookieNames.has(cookie.key)) await this.jar.setCookie(cookie, ORIGIN);
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      const retry = response.headers.get('retry-after');

      const milliseconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : retry
            ? Date.parse(retry) - this.now()
            : NaN;

      const wait =
        Number.isFinite(milliseconds) && milliseconds > 0 ? Math.max(60_000, milliseconds) : 60_000;

      this.saved.pauseUntil = Math.min(Date.parse('9999-12-31T23:59:59.999Z'), this.now() + wait);
      throw new SafeError('Inna rate limited this session. Wait before trying again.');
    }

    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw new SafeError(
        'Inna sign-in is required. Run auth login or import a fresh private cookie export.',
      );
    }

    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new SafeError('Inna denied access to this operation.');
    }

    if (
      !response.ok ||
      !response.headers.get('content-type')?.toLowerCase().includes('application/json')
    ) {
      await response.body?.cancel().catch(() => {});
      throw new SafeError('Inna returned an unavailable or unexpected response.');
    }

    return schema.parse(
      JSON.parse(await readBody(response, 8 * 1024 * 1024, options.signal ?? undefined)),
    );
  }
}

export type ClientOptions = {
  sessionFile?: string;
  fetch?: Fetch;
  now?: () => number;
  allowAbsenceWrites?: boolean;
};

export class InnaClient {
  readonly path: string;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly allowAbsenceWrites: boolean;

  constructor(options: ClientOptions = {}) {
    this.path = options.sessionFile ?? sessionPath();

    if (!isAbsolute(this.path)) throw new SafeError('The Inna session path must be absolute.');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.allowAbsenceWrites = options.allowAbsenceWrites ?? false;
  }

  private async locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await withFileLock(this.path, { signal }, async () => {
        await sweepTemp(this.path);
        await sweepTemp(`${this.path}.absence.json`);

        return work();
      });
    } catch (error) {
      if (error instanceof SessionStoreError)
        throw new SafeError(
          'Cannot access the private Inna files. Check permissions or wait for another operation.',
        );
      throw error;
    }
  }

  private async withUser<T extends object>(
    work: (connection: Connection, user: schemas.User) => Promise<T>,
    signal?: AbortSignal,
    verifyAfter = true,
  ): Promise<T & { retrievedAt: string; timeZone: 'UTC' }> {
    return this.locked(async () => {
      const saved = await readSaved(this.path);

      if (!saved)
        throw new SafeError(
          'No Inna session. Run inna-mcp auth login or auth import with a private cookie export.',
        );
      const jar = await CookieJar.deserialize(saved.jar);
      const connection = new Connection(jar, saved, this.fetcher, this.now, signal);

      try {
        const user = await connection.request('/api/UserData/GetLoggedInUser', schemas.userSchema);

        if (!sameAccount(saved.account, user))
          throw new SafeError(
            'Inna changed account, student, or school. Import the intended session explicitly.',
          );

        const output = await work(connection, user);

        if (verifyAfter) {
          const current = await connection.request(
            '/api/UserData/GetLoggedInUser',
            schemas.userSchema,
          );

          if (!sameAccount(saved.account, current))
            throw new SafeError(
              'Inna changed account, student, or school during the read. The result was discarded.',
            );
        }

        return {
          ...output,
          retrievedAt: new Date(this.now()).toISOString(),
          timeZone: 'UTC',
        };
      } finally {
        saved.jar = JSON.stringify(await jar.serialize());
        await writePrivateFile(this.path, JSON.stringify(saved));
      }
    }, signal);
  }

  async importSession(source: string, allowAccountChange = false): Promise<void> {
    if (!isAbsolute(source)) throw new SafeError('The cookie export path must be absolute.');

    const input = cookieExportSchema.parse(
      JSON.parse(await readPrivateFile(source, { maxBytes: MAX_SESSION_BYTES })),
    );

    const cookies = Array.isArray(input) ? input : input.cookies;
    const jar = new CookieJar();

    for (const entry of cookies) {
      if (!cookieNames.has(entry.name)) continue;

      if (entry.domain.replace(/^\./, '') !== 'nam.inna.is' || entry.path !== '/')
        throw new SafeError('Import only the verified nam.inna.is session cookies.');
      const expiry = entry.expires ?? entry.expirationDate;
      const sameSite = entry.sameSite?.toLowerCase();

      const cookie = new Cookie({
        key: entry.name,
        value: entry.value,
        path: '/',
        secure: true,
        httpOnly: entry.httpOnly,
      });

      if (expiry !== undefined && expiry > 0) cookie.expires = new Date(expiry * 1000);

      if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none')
        cookie.sameSite = sameSite;
      await jar.setCookie(cookie, ORIGIN);
    }

    await this.saveVerifiedSession(jar, allowAccountChange);
  }

  async saveVerifiedSession(
    jar: CookieJar,
    allowAccountChange = false,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.locked(async () => {
      const prior = await readSaved(this.path);
      const throttle = { pauseUntil: prior?.pauseUntil ?? 0 };
      const connection = new Connection(jar, throttle, this.fetcher, this.now, signal);
      let user: schemas.User;

      try {
        user = await connection.request('/api/UserData/GetLoggedInUser', schemas.userSchema);
      } catch (error) {
        if (prior && throttle.pauseUntil > prior.pauseUntil) {
          prior.pauseUntil = throttle.pauseUntil;
          await writePrivateFile(this.path, JSON.stringify(prior));
        }

        throw error;
      }

      if (prior && !sameAccount(prior.account, user) && !allowAccountChange)
        throw new SafeError(
          'This export changes the account, student, or school. Use --allow-account-change deliberately.',
        );

      const candidate: Saved = {
        version: 1,
        jar: JSON.stringify(await jar.serialize()),
        account: schemas.bindingSchema.parse(user),
        pauseUntil: throttle.pauseUntil,
      };

      signal?.throwIfAborted();
      await writePrivateFile(this.path, JSON.stringify(candidate));
    }, signal);
  }

  async logout(): Promise<void> {
    await this.locked(async () => {
      const saved = await readSaved(this.path);

      if (saved) await unlink(this.path);
      // A logout cannot discard evidence of a possibly submitted absence.
    });
  }

  async status(signal?: AbortSignal) {
    if (!(await readSaved(this.path))) return { authenticated: false };

    return this.withUser(
      async (_connection, user) => ({
        authenticated: true,
        context: schemas.contextSchema.parse(user),
      }),
      signal,
    );
  }

  async overview(signal?: AbortSignal) {
    return this.withUser(async (connection, user) => {
      const announcements = await connection.request(
        '/api/Announcements/GetStudentAnnouncements',
        schemas.announcementsSchema,
      );

      for (const announcement of announcements) {
        announcement.contentHtml = schemas.plainText(announcement.contentHtml);
        announcement.dates = parseDates({ date: announcement.date });
      }

      const courses = await connection.request(
        '/api/ModulesAndBooklist/GetModulesAndBooklist',
        schemas.coursesSchema,
        new URLSearchParams({ termId: '' }),
      );

      for (const course of courses)
        course.dates = parseDates({ dateFrom: course.dateFrom, dateTo: course.dateTo });

      return {
        context: schemas.contextSchema.parse(user),
        terms: await connection.request('/api/StudentTerms/GetStudentTerms', schemas.termsSchema),
        courses,
        announcements,
      };
    }, signal);
  }

  async timetable(input: z.infer<typeof schemas.dateRange>, signal?: AbortSignal) {
    const request = schemas.dateRange.parse(input);

    return this.withUser(async (connection, user) => {
      const entries = await connection.request(
        '/api/Timetable/GetTimetable',
        schemas.timetableSchema,
        new URLSearchParams({
          staff_id: '',
          student_id: user.studentId,
          moduleId: '',
          classroom_id: '',
          class_id: '',
          groupId: '',
          terms: '',
          date_from: schemas.innaDate(request.dateFrom),
          date_to: schemas.innaDate(request.dateTo),
          attendanceOverview: '',
        }),
      );

      for (const entry of entries) entry.dates = parseDates({ start: entry.start, end: entry.end });

      return { context: schemas.contextSchema.parse(user), entries };
    }, signal);
  }

  async assignments(type: 'assignments' | 'exams' | 'all', signal?: AbortSignal) {
    return this.withUser(async (connection, user) => {
      const entries: z.infer<typeof schemas.assignmentsSchema> = [];

      for (const value of type === 'all' ? ['0', '1'] : [type === 'exams' ? '1' : '0']) {
        entries.push(
          ...(await connection.request(
            '/api/GetAssignments/GetStudentAssignments',
            schemas.assignmentsSchema,
            new URLSearchParams({ type: value, control: '0', order: '0' }),
          )),
        );
      }

      const homework = await connection.request(
        '/api/Homework/GetStudentHomework',
        schemas.homeworkSchema,
        new URLSearchParams({ groupId: '', type: '1', control: '0', order: '0' }),
      );

      for (const item of homework) {
        item.text = schemas.plainText(item.text);
        item.dates = parseDates({ date: item.date });
      }

      for (const entry of entries)
        entry.dates = parseDates({
          assignedFullDate: entry.assignedFullDate,
          handInFullDate: entry.handInFullDate,
        });

      return {
        context: schemas.contextSchema.parse(user),
        entries,
        homework,
      };
    }, signal);
  }

  async assignment(assignmentId: string, signal?: AbortSignal) {
    schemas.id.parse(assignmentId);

    return this.withUser(async (connection, user) => {
      const assignment = await connection.request(
        '/api/GetAssignments/GetAssignmentInfo',
        schemas.assignmentSchema,
        new URLSearchParams({ assignmentId }),
      );

      assignment.description = schemas.plainText(assignment.description);
      assignment.dates = parseDates({ returnDate: assignment.returnDate });

      return { context: schemas.contextSchema.parse(user), assignment };
    }, signal);
  }

  async grades(termId?: string, signal?: AbortSignal) {
    if (termId !== undefined) schemas.id.parse(termId);

    return this.withUser(async (connection, user) => {
      const entries = await connection.request(
        '/api/StudentGrades/GetStudentGrades',
        schemas.gradesSchema,
        new URLSearchParams({ termId: termId ?? user.defaultTermId }),
      );

      for (const entry of entries) entry.dates = parseDates({ dateFinished: entry.dateFinished });

      return { context: schemas.contextSchema.parse(user), entries };
    }, signal);
  }

  async courseGrades(groupId: string, signal?: AbortSignal) {
    schemas.id.parse(groupId);

    return this.withUser(async (connection, user) => {
      const { assignments } = await connection.request(
        `/api/GetAssignments/Groups/${groupId}/StudentProjects`,
        schemas.courseGradesSchema,
      );

      for (const entry of assignments)
        entry.dates = parseDates({ assignDate: entry.assignDate, returnDate: entry.returnDate });

      return { context: schemas.contextSchema.parse(user), assignments };
    }, signal);
  }

  async attendance(termId = '', signal?: AbortSignal) {
    if (termId) schemas.id.parse(termId);

    return this.withUser(async (connection, user) => {
      const attendance = await connection.request(
        '/api/Attendance/GetAttendance',
        schemas.attendanceSchema,
        new URLSearchParams({ termId, type: '0' }),
      );

      attendance.dates = parseDates({ dateFrom: attendance.dateFrom, dateTo: attendance.dateTo });

      return { context: schemas.contextSchema.parse(user), attendance };
    }, signal);
  }

  async materials(groupId: string, signal?: AbortSignal) {
    schemas.id.parse(groupId);

    return this.withUser(async (connection, user) => {
      const groups = await connection.request(
        '/api/Attachment/GetModuleFiles',
        schemas.materialsSchema,
        new URLSearchParams({ groupId, isStudent: '1' }),
      );

      for (const group of groups) {
        for (const file of group.files) {
          file.dates = parseDates({ dateOpened: file.dateOpened });

          if (file.description !== undefined)
            file.description = schemas.plainText(file.description);
        }
      }

      return { context: schemas.contextSchema.parse(user), groups };
    }, signal);
  }

  async messages(rowFrom = 1, rowTo = 21, signal?: AbortSignal) {
    z.number().int().min(1).parse(rowFrom);
    z.number()
      .int()
      .min(rowFrom)
      .max(rowFrom + 100)
      .parse(rowTo);

    return this.withUser(async (connection, user) => {
      const page = await connection.request(
        '/api/Messages/GetReceivedMessages',
        schemas.messagesSchema,
        new URLSearchParams({
          dateFrom: '',
          dateTo: '',
          rowFrom: String(rowFrom),
          rowTo: String(rowTo),
        }),
      );

      const next = rowFrom + page.messages.length;

      if (page.messages.length === 0 && rowFrom <= page.count)
        throw new SafeError(
          'Inna returned an incomplete message page. Do not treat it as an empty inbox.',
        );

      const keys = new Set(
        page.messages.map((message) => `${message.table}:${message.messagesId}`),
      );

      if (
        keys.size !== page.messages.length ||
        page.messages.length > rowTo - rowFrom + 1 ||
        (page.messages.length > 0 && next - 1 > page.count)
      )
        throw new SafeError('Inna returned inconsistent message paging. The result was discarded.');

      for (const message of page.messages)
        message.dates = parseDates({ date: message.date, dateOpened: message.dateOpened });

      return {
        context: schemas.contextSchema.parse(user),
        count: page.count,
        messages: page.messages,
        rowFrom,
        rowTo,
        nextRowFrom: next <= page.count ? next : null,
      };
    }, signal);
  }

  async message(messageId: string, type: string, signal?: AbortSignal) {
    schemas.id.parse(messageId);
    z.string()
      .regex(/^[A-Z]$/)
      .parse(type);

    return this.withUser(async (connection, user) => {
      const message = await connection.request(
        '/api/Messages/GetMessageDetails',
        schemas.messageSchema,
        new URLSearchParams({ messageId, type }),
      );

      message.message = schemas.plainText(message.message);
      message.dates = parseDates({ dateCreated: message.dateCreated, dateSent: message.dateSent });

      return { context: schemas.contextSchema.parse(user), message };
    }, signal);
  }

  async absences(input: z.infer<typeof schemas.dateRange>, signal?: AbortSignal) {
    const request = schemas.dateRange.parse(input);

    return this.withUser(async (connection, user) => {
      const sickOptions = await connection.request(
        '/api/RegisterAbsence/GetRegisterAbsences',
        schemas.sickOptionsSchema,
      );

      const sick = await connection.request(
        '/api/RegisterAbsence/GetStudentRegisteredAbsences',
        schemas.sicknessSchema,
        new URLSearchParams({
          dateFrom: schemas.innaDate(request.dateFrom),
          dateTo: schemas.innaDate(request.dateTo),
        }),
      );

      const leave = await connection.request(
        '/api/RegisterAbsence/GetLeaves',
        schemas.leavesSchema,
        new URLSearchParams({
          getDateFrom: schemas.innaDate(request.dateFrom),
          getDateTo: schemas.innaDate(request.dateTo),
        }),
      );

      for (const record of sick) record.dates = parseDates({ date: record.date });

      for (const record of leave)
        record.dates = parseDates({
          dateFrom: record.dateFrom,
          dateTo: record.dateTo,
          created: record.created,
        });

      for (const record of [...sick, ...leave])
        for (const lesson of record.classes) lesson.dates = parseDates({ date: lesson.date });

      return { context: schemas.contextSchema.parse(user), sickOptions, sick, leave };
    }, signal);
  }

  private async checkAbsence(
    connection: Connection,
    user: schemas.User,
    request: schemas.AbsenceInput,
  ): Promise<string> {
    const checkedAt = this.now();
    const today = new Date(checkedAt).toISOString().slice(0, 10);

    if (request.dateFrom < today)
      throw new SafeError('New absence requests cannot start in the past.');

    if (!canRegisterAbsence(user, request.kind))
      throw new SafeError('Inna does not permit this absence request for that account.');

    if (request.kind === 'sick') {
      const options = await connection.request(
        '/api/RegisterAbsence/GetRegisterAbsences',
        schemas.sickOptionsSchema,
      );

      const tomorrow = new Date(checkedAt + 86_400_000).toISOString().slice(0, 10);

      if (
        !(request.dateFrom === today
          ? options.todayAllowed
          : request.dateFrom === tomorrow &&
            options.tomorrowAllowed &&
            user.registerIllnessTomorrow === '1')
      )
        throw new SafeError(
          'Inna does not permit sick-day registration for that date and account.',
        );
    }

    const records = await connection.request(
      '/api/RegisterAbsence/GetStudentRegisteredAbsences',
      schemas.sicknessSchema,
      new URLSearchParams({
        dateFrom: schemas.innaDate(request.dateFrom),
        dateTo: schemas.innaDate(request.dateTo),
      }),
    );

    if (
      records.some((record) => {
        const day = upstreamDate(record.date);

        return day >= request.dateFrom && day <= request.dateTo;
      })
    )
      throw new SafeError(
        'An absence is already registered in that date range. Review it in Inna before submitting another.',
      );

    const leaves = await connection.request(
      '/api/RegisterAbsence/GetLeaves',
      schemas.leavesSchema,
      new URLSearchParams({
        getDateFrom: schemas.innaDate(request.dateFrom),
        getDateTo: schemas.innaDate(request.dateTo),
      }),
    );

    if (
      leaves.some(
        (record) =>
          upstreamDate(record.dateFrom) <= request.dateTo &&
          upstreamDate(record.dateTo) >= request.dateFrom,
      )
    )
      throw new SafeError(
        'An overlapping absence application exists. Review it in Inna before submitting another.',
      );

    return today;
  }

  async prepareAbsence(input: schemas.AbsenceInput, signal?: AbortSignal) {
    if (!this.allowAbsenceWrites)
      throw new SafeError('Absence writes require --allow-absence-writes.');
    const request = schemas.absenceInputSchema.parse(input);

    return this.withUser(
      async (connection, user) => {
        const previous = await readAbsence(this.path);

        if (previous?.state === 'submitting' || previous?.state === 'unknown')
          throw new SafeError(
            'An earlier absence submission is uncertain. Review its status and Inna history; do not retry it.',
          );
        await this.checkAbsence(connection, user, request);

        const record: AbsenceRecord = {
          operationId: randomUUID(),
          account: schemas.bindingSchema.parse(user),
          request,
          state: 'prepared',
          expiresAt: this.now() + 10 * 60_000,
        };

        await saveAbsence(this.path, record);

        return { ...record, studentName: user.studentName, schoolName: user.schoolLong };
      },
      signal,
      false,
    );
  }

  async submitAbsence(operationId: string, confirm: true, signal?: AbortSignal) {
    if (!this.allowAbsenceWrites)
      throw new SafeError('Absence writes require --allow-absence-writes.');
    z.uuid().parse(operationId);
    z.literal(true).parse(confirm);

    return this.withUser(
      async (connection, user) => {
        const record = await readAbsence(this.path);

        if (!record || record.operationId !== operationId || !sameAccount(record.account, user))
          throw new SafeError('No matching absence preview for this account, student, and school.');

        if (record.state === 'submitted') return record;

        if (record.state !== 'prepared')
          throw new SafeError(
            'Submission outcome is uncertain. Review Inna history; this request will not be replayed.',
          );

        if (record.expiresAt <= this.now())
          throw new SafeError('The absence preview expired. Prepare and approve a fresh preview.');

        const checkedDay = await this.checkAbsence(connection, user, record.request);

        const current = await connection.request(
          '/api/UserData/GetLoggedInUser',
          schemas.userSchema,
        );

        if (
          !sameAccount(record.account, current) ||
          !canRegisterAbsence(current, record.request.kind)
        )
          throw new SafeError(
            'Inna context or permissions changed during absence checks. Review the intended account before preparing another request.',
          );

        if (new Date(this.now()).toISOString().slice(0, 10) !== checkedDay)
          throw new SafeError(
            'The UTC day changed during absence checks. Prepare and approve a fresh preview.',
          );

        if (record.expiresAt <= this.now())
          throw new SafeError('The absence preview expired. Prepare and approve a fresh preview.');

        record.state = 'submitting';
        await saveAbsence(this.path, record);

        try {
          // ponytail: whole days only; partial days need per-lesson writes and partial-success recovery.
          const response = await connection.request(
            '/api/RegisterAbsence/AddNewLeave',
            z.object({ id: z.number().int().positive() }),
            new URLSearchParams(),
            {
              firstDay: schemas.innaDate(record.request.dateFrom),
              lastDay: schemas.innaDate(record.request.dateTo),
              leaveStatus: 0,
              leaveType: record.request.kind === 'sick' ? 1 : 3,
              allDay: 1,
              comment: record.request.reason,
            },
          );

          record.state = 'submitted';
          record.upstreamId = response.id;
          await saveAbsence(this.path, record);

          return record;
        } catch {
          record.state = 'unknown';
          await saveAbsence(this.path, record);
          throw new SafeError(
            'Absence submission outcome is uncertain. Do not retry; review the saved operation and Inna history.',
          );
        }
      },
      signal,
      false,
    );
  }

  async absenceStatus(signal?: AbortSignal) {
    return this.withUser(async (_connection, user) => {
      const record = await readAbsence(this.path);

      if (record && !sameAccount(record.account, user))
        throw new SafeError(
          'The saved absence operation belongs to another account, student, or school.',
        );

      return { context: schemas.contextSchema.parse(user), operation: record ?? null };
    }, signal);
  }
}
