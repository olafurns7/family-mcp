import { createHash, randomUUID } from 'node:crypto';
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

export const ORIGIN = 'https://nam.inna.is';

const MAX_SESSION_BYTES = 262_144;

export const cookieNames = new Set(['SESSION', 'JSESSIONID', 'XSRF-TOKEN']);

const studentPaths = new Set(['/Components/Students/Students.html', '/auth/system']);

const USER_ENDPOINT = '/api/UserData/GetLoggedInUser';

const STUDENTS_PATH = '/Components/Students/Students.html';

// Inna JWTs live one hour and its web application refreshes ten minutes before expiry. Refresh
// once under this margin; it must exceed the interval of whatever runs keep-alive.
export const REFRESH_BEFORE_EXPIRY_MS = 20 * 60_000;

const HANDOFF_HOP_LIMIT = 10;

const RENEWAL_TIMEOUT_MS = 30_000;

function signInRequired(): SafeError {
  return new SafeError(
    'Inna sign-in is required. Run auth login or import a fresh private cookie export.',
  );
}

function switchRefused(): SafeError {
  return new SafeError(
    'Inna refused the student switch and asked for sign-in. The session may have ended; sign in again and report this.',
  );
}

function contextChanged(): SafeError {
  return new SafeError(
    'Inna changed account, student, or school. Import the intended session explicitly.',
  );
}

function sessionExpired(): SafeError {
  return new SafeError(
    'Inna session expired. Run inna-mcp auth login or import a fresh private browser cookie export.',
  );
}

function needsSignIn(error: SafeError): boolean {
  return [signInRequired().message, sessionExpired().message].includes(error.message);
}

function noPreview(): SafeError {
  return new SafeError('No matching absence preview for this account, student, and school.');
}

// Version 1 files hold one binding; they are read as version 2 without learned students.
// Version 2 adds learned students. Version 3 adds the inna.is token for renewal.
const savedSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  jar: z.string().max(MAX_SESSION_BYTES),
  account: schemas.bindingSchema,
  students: z.record(schemas.id, schemas.learnedStudentSchema).default({}),
  pauseUntil: z.number().default(0),
  token: z.string().max(65_536).optional(),
  tokenRefreshedAt: z.number().default(0),
});

type Saved = z.infer<typeof savedSchema>;

const jarSchema = z.object({
  cookies: z.array(z.object({ key: z.string(), value: z.string().default('') })),
});

// Identifies saved credentials by cookie values alone, so rewritten access times do not change it.
function credentials(saved: Saved): string {
  const pairs = jarSchema
    .parse(JSON.parse(saved.jar))
    .cookies.flatMap((cookie) =>
      cookieNames.has(cookie.key) ? [`${cookie.key}=${cookie.value}`] : [],
    );

  return createHash('sha256').update(pairs.toSorted().join('\n')).digest('hex');
}

// Decode only non-sensitive JWT claims: exp, iat, orig_iat.
function parseTokenClaims(token: string):
  | {
      exp?: number | undefined;
      iat?: number | undefined;
      orig_iat?: number | undefined;
    }
  | undefined {
  try {
    const parts = token.split('.');

    if (parts.length !== 3) return undefined;
    const payload = parts[1];

    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    const parsed = z
      .object({
        exp: z.number().optional(),
        iat: z.number().optional(),
        orig_iat: z.number().optional(),
      })
      .safeParse(decoded);

    if (!parsed.success) return undefined;

    return parsed.data;
  } catch {
    return undefined;
  }
}

type Student = z.infer<typeof schemas.accessStudentSchema> & { index: number };

type Target = { user: schemas.User; binding: schemas.Binding; key: string | undefined };

type Stamp = { retrievedAt: string; timeZone: 'UTC' };

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

export const cookieExportSchema = z.union([
  z.array(exportedCookieSchema),
  z.object({ cookies: z.array(exportedCookieSchema) }),
]);

// The only cookies a saved session holds: the three nam.inna.is session cookies at path /.
export async function sessionJar(input: z.infer<typeof cookieExportSchema>): Promise<CookieJar> {
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

  return jar;
}

export function sessionPath(): string {
  const path = process.env.INNA_SESSION_FILE ?? defaultSessionPath('inna-mcp');

  if (!isAbsolute(path)) throw new SafeError('INNA_SESSION_FILE must be an absolute path.');

  return path;
}

function sameAccount(a: schemas.Binding, b: schemas.Binding): boolean {
  return a.userId === b.userId && a.studentId === b.studentId && a.schoolId === b.schoolId;
}

// Returns undefined when Inna's access list is absent or cannot be read without guessing.
function studentEntries(user: schemas.User): Student[] | undefined {
  const access = z.array(z.unknown()).safeParse(user.access);

  if (!access.success) return undefined;
  const students: Student[] = [];

  for (const [index, raw] of access.data.entries()) {
    const system = schemas.accessSystemSchema.safeParse(raw);

    if (!system.success) return undefined;

    if (system.data.system !== '1') continue;
    const entry = schemas.accessStudentSchema.safeParse(raw);

    if (!entry.success || students.some((student) => student.userId === entry.data.userId))
      return undefined;
    students.push({ ...entry.data, index });
  }

  return students;
}

function selectedKey(students: Student[] | undefined): string | undefined {
  const selected = students?.filter((student) => student.loggedIn) ?? [];

  return selected.length === 1 ? selected[0]?.userId : undefined;
}

// Inna's selected access entry carries the same userId as the logged-in context.
function defaultKey(saved: Pick<Saved, 'account'>): string {
  return String(saved.account.userId);
}

// The context must be the only selected student entry and agree with it on user and school.
function matchesEntry(user: schemas.User, key: string): boolean {
  const students = studentEntries(user);
  const entry = students?.find((student) => student.userId === key);

  return (
    selectedKey(students) === key &&
    String(user.userId) === key &&
    user.schoolId === entry?.skoli_id
  );
}

function unknownStudent(): SafeError {
  return new SafeError(
    'That student is not in this Inna session. Use a studentKey from inna_list_students.',
  );
}

// Trust on first use: a key keeps the binding first verified for it.
function learn(
  saved: Pick<Saved, 'account' | 'students'>,
  key: string,
  user: schemas.User,
): schemas.Binding {
  const known = saved.students[key];

  if (known) {
    if (!sameAccount(known, user)) throw contextChanged();

    return known;
  }

  const taken = Object.values(saved.students).map((student) => student.studentId);

  if (key === defaultKey(saved)) {
    if (!sameAccount(saved.account, user)) throw contextChanged();
  } else taken.push(saved.account.studentId);

  if (taken.includes(user.studentId))
    throw new SafeError(
      'Inna returned a student already saved under another studentKey. The result was discarded.',
    );
  const learned = schemas.learnedStudentSchema.parse(user);
  saved.students[key] = learned;

  return learned;
}

function stillSelected(target: Target, current: schemas.User): boolean {
  return (
    sameAccount(target.binding, current) &&
    (target.key === undefined || matchesEntry(current, target.key))
  );
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
    return {
      ...savedSchema.parse(
        JSON.parse(await readPrivateFile(path, { maxBytes: MAX_SESSION_BYTES })),
      ),
      version: 2,
    };
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
    this.checkPause();
    const url = new URL(endpoint, ORIGIN);

    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/'))
      throw new SafeError('Inna requests must use the verified API origin.');
    url.search = params.toString();
    const cookies = await this.jar.getCookies(url.href);
    const xsrf = cookies.find((cookie) => cookie.key === 'XSRF-TOKEN');

    if (!cookies.some((cookie) => cookie.key === 'SESSION') || !xsrf) throw sessionExpired();

    const headers = new Headers({
      Accept: 'application/json',
      'X-Requested-By': 'XMLHttpRequest',
      Cookie: await this.jar.getCookieString(url.href),
      'X-XSRF-TOKEN': xsrf.value,
    });

    if (body) headers.set('Content-Type', 'application/json;charset=UTF-8');

    const options: RequestInit = {
      method: body ? 'POST' : 'GET',
      headers,
      redirect: 'manual',
      signal: this.deadline(),
    };

    if (body) options.body = JSON.stringify(body);
    const response = await this.fetcher(url.href, options);
    await this.capture(response);

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      throw this.pause(response);
    }

    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw signInRequired();
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

  // Inna's own student switch: a cookie-only navigation that ends on the student application.
  async selectStudent(student: Student): Promise<void> {
    this.checkPause();
    let url = new URL('/auth/system', ORIGIN);

    url.search = new URLSearchParams({
      i: String(student.index),
      system: student.system,
      status: student.status,
      user_id: student.userId,
    }).toString();

    for (let hop = 0; hop < 5; hop += 1) {
      const cookies = await this.jar.getCookies(url.href);

      if (!cookies.some((cookie) => cookie.key === 'SESSION')) throw sessionExpired();

      const response = await this.fetcher(url.href, {
        method: 'GET',
        headers: new Headers({
          Accept: 'text/html',
          Cookie: await this.jar.getCookieString(url.href),
        }),
        redirect: 'manual',
        signal: this.deadline(),
      });

      await this.capture(response);
      await response.body?.cancel().catch(() => {});

      if (response.status === 429) throw this.pause(response);

      if (response.status === 200) return;
      const location = response.headers.get('location');

      if (response.status === 401) throw switchRefused();

      if (response.status < 300 || response.status >= 400 || !location)
        throw new SafeError('Inna returned an unavailable or unexpected response.');
      const next = new URL(location, url);

      if (next.protocol === 'http:' && next.host === 'nam.inna.is') next.protocol = 'https:';

      if (next.origin !== ORIGIN || !studentPaths.has(next.pathname)) throw switchRefused();
      next.hash = '';
      url = next;
    }

    throw new SafeError('Inna returned an unavailable or unexpected response.');
  }

  private checkPause(): void {
    if (this.saved.pauseUntil > this.now())
      throw new SafeError('Inna requested a pause. Wait before making another request.');
  }

  private deadline(): AbortSignal {
    const timeout = AbortSignal.timeout(30_000);

    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  private async capture(response: Response): Promise<void> {
    for (const header of response.headers.getSetCookie()) {
      const cookie = Cookie.parse(header);

      if (cookie && cookieNames.has(cookie.key)) await this.jar.setCookie(cookie, ORIGIN);
    }
  }

  private pause(response: Response): SafeError {
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

    return new SafeError('Inna rate limited this session. Wait before trying again.');
  }
}

async function select(
  connection: Connection,
  saved: Saved,
  user: schemas.User,
  studentKey: string | undefined,
): Promise<Target> {
  const students = studentEntries(user);

  if (!students?.length) {
    // Without a usable student list nothing can be selected: only the saved binding decides.
    if (studentKey !== undefined) throw unknownStudent();

    if (!sameAccount(saved.account, user)) throw contextChanged();

    return { user, binding: saved.account, key: undefined };
  }

  const key = studentKey ?? defaultKey(saved);
  const target = students.find((student) => student.userId === key);

  if (!target) throw studentKey === undefined ? contextChanged() : unknownStudent();

  if (selectedKey(students) === key) {
    if (!matchesEntry(user, key)) throw contextChanged();

    return { user, binding: learn(saved, key, user), key };
  }

  await connection.selectStudent(target);
  const switched = await connection.request(USER_ENDPOINT, schemas.userSchema);

  if (!matchesEntry(switched, key))
    throw new SafeError('Inna did not select the requested student. The result was discarded.');

  return { user: switched, binding: learn(saved, key, switched), key };
}

export type ClientOptions = {
  sessionFile?: string;
  fetch?: Fetch;
  now?: () => number;
  allowAbsenceWrites?: boolean;
  log?: (message: string) => void;
};

export type KeepAlive = { status: 'kept' | 'skipped' | 'signInRequired' | 'failed' | 'renewed' };

export class InnaClient {
  readonly path: string;
  // Hash of the credentials Inna last refused, in memory only; keep-alive waits for new ones.
  private refused: string | undefined;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly allowAbsenceWrites: boolean;
  private readonly log: (message: string) => void;

  constructor(options: ClientOptions = {}) {
    this.path = options.sessionFile ?? sessionPath();

    if (!isAbsolute(this.path)) throw new SafeError('The Inna session path must be absolute.');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.allowAbsenceWrites = options.allowAbsenceWrites ?? false;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
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

  private stamp(): Stamp {
    return { retrievedAt: new Date(this.now()).toISOString(), timeZone: 'UTC' };
  }

  private async session<T>(
    work: (connection: Connection, saved: Saved) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.locked(async () => {
      const saved = await readSaved(this.path);

      if (!saved)
        throw new SafeError(
          'No Inna session. Run inna-mcp auth login or auth import with a private cookie export.',
        );

      await this.refreshIfDue(saved, signal);

      try {
        return await this.persisting(saved, work, signal);
      } catch (error) {
        if (saved.token && error instanceof SafeError && needsSignIn(error)) {
          this.event('Session expired, attempting automatic renewal');

          if (await this.renewSession(saved, signal)) {
            await writePrivateFile(this.path, JSON.stringify(saved));

            return await this.persisting(saved, work, signal);
          }

          this.event('Automatic renewal failed');
        }

        throw error;
      }
    }, signal);
  }

  private event(message: string): void {
    this.log(`${new Date(this.now()).toISOString()} ${message}`);
  }

  private renewalSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(RENEWAL_TIMEOUT_MS);

    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  // Refreshes a token close to expiry and saves it at once; an expired token cannot be refreshed.
  private async refreshIfDue(saved: Saved, signal?: AbortSignal): Promise<void> {
    if (!saved.token) return;

    const expiresAt = parseTokenClaims(saved.token)?.exp;

    if (expiresAt === undefined) return;

    const remaining = expiresAt * 1000 - this.now();

    // Inna refuses to refresh an expired token, so there is nothing to try once it has lapsed.
    if (remaining <= 0 || remaining >= REFRESH_BEFORE_EXPIRY_MS) return;

    await this.refreshAndSave(saved, signal);
  }

  // A refreshed token replaces the old one on disk before anything else can fail.
  private async refreshAndSave(saved: Saved, signal?: AbortSignal): Promise<string | undefined> {
    const refreshed = await this.refreshToken(saved, signal);

    if (!refreshed) {
      this.event('Token refresh failed');

      return undefined;
    }

    saved.token = refreshed;
    saved.tokenRefreshedAt = this.now();
    await writePrivateFile(this.path, JSON.stringify(saved));

    return refreshed;
  }

  // Runs work on the saved cookies and always writes back the jar and any rate-limit pause.
  private async persisting<T>(
    saved: Saved,
    work: (connection: Connection, saved: Saved) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const jar = await CookieJar.deserialize(saved.jar);

    try {
      return await work(new Connection(jar, saved, this.fetcher, this.now, signal), saved);
    } finally {
      saved.version = 3;
      saved.jar = JSON.stringify(await jar.serialize());
      await writePrivateFile(this.path, JSON.stringify(saved));
    }
  }

  private async refreshToken(saved: Saved, signal?: AbortSignal): Promise<string | undefined> {
    if (!saved.token) return undefined;

    try {
      const response = await this.fetcher('https://inna.is/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: saved.token }),
        signal: this.renewalSignal(signal),
      });

      if (!response.ok) return undefined;

      const result = z
        .object({ token: z.string().min(1).max(65_536) })
        .safeParse(await response.json());

      if (!result.success) return undefined;
      const claims = parseTokenClaims(result.data.token);

      this.event(
        claims?.exp
          ? `Inna token refreshed (expires ${new Date(claims.exp * 1000).toISOString()})`
          : 'Inna token refreshed',
      );

      return result.data.token;
    } catch {
      return undefined;
    }
  }

  // Inna's own handoff, as the web application does it: access list, terms, school selection,
  // then a browser-style navigation from the one-time /auth/token URL to the student application.
  private async mintSchoolSession(
    saved: Saved,
    token: string,
    signal?: AbortSignal,
  ): Promise<CookieJar | undefined> {
    try {
      const accessResponse = await this.fetcher('https://inna.is/auth/access', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: this.renewalSignal(signal),
      });

      if (!accessResponse.ok) return this.mintFailed(`access returned ${accessResponse.status}`);

      const accessSchema = z.array(
        z.object({
          system: z.number().int(),
          user_id: z.number().int(),
          status: z.number().int(),
          is_access: z.boolean(),
        }),
      );

      const access = accessSchema.safeParse(await accessResponse.json());

      if (!access.success) return this.mintFailed('access list was not recognized');

      const termsResponse = await this.fetcher('https://inna.is/auth/user-terms-confirmed', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: this.renewalSignal(signal),
      });

      const terms = z
        .object({ confirmed: z.boolean() })
        .safeParse(termsResponse.ok ? await termsResponse.json() : undefined);

      if (!terms.success || !terms.data.confirmed)
        return this.mintFailed('Inna terms must be confirmed in the browser');

      const candidates = access.data.flatMap((entry, index) =>
        entry.is_access && entry.system === 1 ? [{ entry, index }] : [],
      );

      const chosen =
        candidates.find((candidate) => candidate.entry.user_id === saved.account.userId) ??
        candidates[0];

      if (!chosen) return this.mintFailed('no school access');

      const { entry } = chosen;

      const params = new URLSearchParams({
        i: String(chosen.index),
        system: String(entry.system),
        user_id: String(entry.user_id),
        status: String(entry.status),
      });

      const schoolResponse = await this.fetcher(`https://inna.is/auth/system?${params}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: this.renewalSignal(signal),
      });

      if (!schoolResponse.ok) return this.mintFailed(`system returned ${schoolResponse.status}`);
      const schoolResult = z.object({ url: z.string() }).safeParse(await schoolResponse.json());

      if (!schoolResult.success || !URL.canParse(schoolResult.data.url))
        return this.mintFailed('system returned no handoff');
      const schoolUrl = new URL(schoolResult.data.url);

      if (schoolUrl.protocol === 'http:' && schoolUrl.host === 'nam.inna.is')
        schoolUrl.protocol = 'https:';

      if (schoolUrl.origin !== ORIGIN || schoolUrl.pathname !== '/auth/token')
        return this.mintFailed('system returned an unexpected handoff');

      return await this.followHandoff(schoolUrl, signal);
    } catch {
      return this.mintFailed('request failed');
    }
  }

  private mintFailed(reason: string): undefined {
    this.event(`School session minting failed: ${reason}`);

    return undefined;
  }

  // nam.inna.is hands out SESSION, JSESSIONID and XSRF-TOKEN to anyone, even on a refused handoff,
  // so only arriving on the student application proves the redirects completed the sign-in.
  private async followHandoff(start: URL, signal?: AbortSignal): Promise<CookieJar | undefined> {
    const jar = new CookieJar();
    const hops: string[] = [];
    let url = start;

    for (let hop = 0; hop < HANDOFF_HOP_LIMIT; hop += 1) {
      const response = await this.fetcher(url.href, {
        method: 'GET',
        headers: new Headers({ Accept: 'text/html', Cookie: await jar.getCookieString(url.href) }),
        redirect: 'manual',
        signal: this.renewalSignal(signal),
      });

      for (const header of response.headers.getSetCookie()) {
        const cookie = Cookie.parse(header);

        if (cookie && cookieNames.has(cookie.key)) {
          cookie.secure = true;
          await jar.setCookie(cookie, ORIGIN);
        }
      }

      await response.body?.cancel().catch(() => {});
      // Paths and statuses only: the handoff query carries a one-time credential.
      hops.push(`${url.pathname} ${response.status}`);

      if (response.status === 200 && url.pathname === STUDENTS_PATH) {
        this.event(`School handoff: ${hops.join(' -> ')}`);

        return jar;
      }

      const location = response.headers.get('location');

      if (response.status < 300 || response.status >= 400 || !location) break;

      const next = new URL(location, url);

      if (next.protocol === 'http:' && next.host === 'nam.inna.is') next.protocol = 'https:';

      if (next.origin !== ORIGIN) break;
      next.hash = '';
      url = next;
    }

    return this.mintFailed(`handoff did not reach the student application (${hops.join(' -> ')})`);
  }

  private async renewSession(saved: Saved, signal?: AbortSignal): Promise<boolean> {
    if (!saved.token) return false;

    this.event('Attempting session renewal');
    const refreshed = await this.refreshAndSave(saved, signal);

    if (!refreshed) return false;

    const jar = await this.mintSchoolSession(saved, refreshed, signal);

    if (!jar) return false;

    const connection = new Connection(jar, saved, this.fetcher, this.now, signal);

    try {
      const user = await connection.request(USER_ENDPOINT, schemas.userSchema);

      if (!sameAccount(saved.account, user)) {
        this.event('Renewed session has different account');

        return false;
      }

      saved.jar = JSON.stringify(await jar.serialize());
      this.event('Session renewed successfully');

      return true;
    } catch {
      this.event('Session renewal verification failed');

      return false;
    }
  }

  /**
   * Touches the saved session so Inna does not idle it out. Reads no school data, never
   * switches or learns a student, and reports every failure as a status instead of throwing.
   * Also refreshes the inna.is token once it is within REFRESH_BEFORE_EXPIRY_MS of expiry.
   */
  async keepAlive(signal?: AbortSignal): Promise<KeepAlive> {
    let saved: Saved | undefined;

    try {
      return await this.locked(async () => {
        saved = await readSaved(this.path);

        // Refused cookies are retried only while a token can still mint a fresh session.
        if (
          !saved ||
          saved.pauseUntil > this.now() ||
          (!saved.token && credentials(saved) === this.refused)
        )
          return { status: 'skipped' };

        await this.refreshIfDue(saved, signal);

        try {
          await this.persisting(
            saved,
            async (connection) => {
              await connection.request(USER_ENDPOINT, schemas.userSchema);
            },
            signal,
          );

          return { status: 'kept' };
        } catch (error) {
          if (!saved.token || !(error instanceof SafeError) || !needsSignIn(error)) throw error;

          // Renewal stays inside the file lock, so no other process can interleave writes.
          this.event('Session expired, attempting automatic renewal');

          if (await this.renewSession(saved, signal)) {
            await writePrivateFile(this.path, JSON.stringify(saved));
            this.refused = undefined;

            return { status: 'renewed' };
          }

          this.event('Automatic renewal failed');
          throw error;
        }
      }, signal);
    } catch (error) {
      if (!(error instanceof SafeError) || !needsSignIn(error)) return { status: 'failed' };
      // Taken from the jar as written back, so a cookie set by the refusal itself is included.
      this.refused = saved && credentials(saved);

      return { status: 'signInRequired' };
    }
  }

  private async withStudent<T extends object>(
    pick: () => Promise<string | undefined>,
    work: (connection: Connection, user: schemas.User, target: Target) => Promise<T>,
    signal?: AbortSignal,
    verifyAfter = true,
  ): Promise<T & Stamp> {
    return this.session(async (connection, saved) => {
      const key = schemas.studentKey.parse(await pick());

      const target = await select(
        connection,
        saved,
        await connection.request(USER_ENDPOINT, schemas.userSchema),
        key,
      );

      const output = await work(connection, target.user, target);

      if (
        verifyAfter &&
        !stillSelected(target, await connection.request(USER_ENDPOINT, schemas.userSchema))
      )
        throw new SafeError(
          'Inna changed account, student, or school during the read. The result was discarded.',
        );

      return { ...output, ...this.stamp() };
    }, signal);
  }

  private async withUser<T extends object>(
    studentKey: string | undefined,
    signal: AbortSignal | undefined,
    work: (connection: Connection, user: schemas.User, target: Target) => Promise<T>,
    verifyAfter = true,
  ): Promise<T & Stamp> {
    return this.withStudent(async () => studentKey, work, signal, verifyAfter);
  }

  async importSession(source: string, allowAccountChange = false): Promise<void> {
    if (!isAbsolute(source)) throw new SafeError('The cookie export path must be absolute.');

    const input = cookieExportSchema.parse(
      JSON.parse(await readPrivateFile(source, { maxBytes: MAX_SESSION_BYTES })),
    );

    await this.saveVerifiedSession(await sessionJar(input), allowAccountChange, undefined);
  }

  /** The saved default student's user id, read locally; a fresh login prefers it. */
  async defaultUserId(): Promise<number | undefined> {
    return this.locked(async () => (await readSaved(this.path))?.account.userId);
  }

  async saveVerifiedSession(
    jar: CookieJar,
    allowAccountChange = false,
    token?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.locked(async () => {
      let prior: Saved | undefined;

      try {
        prior = await readSaved(this.path);
      } catch {
        // If we can't read the existing session (corrupted, wrong permissions, etc.),
        // treat it as if no session exists so we can save the new one.
        prior = undefined;
      }

      const throttle = { pauseUntil: prior?.pauseUntil ?? 0 };

      const connection = new Connection(jar, throttle, this.fetcher, this.now, signal);

      let user: schemas.User;

      try {
        user = await connection.request(USER_ENDPOINT, schemas.userSchema);
      } catch (error) {
        if (prior && throttle.pauseUntil > prior.pauseUntil) {
          prior.pauseUntil = throttle.pauseUntil;
          await writePrivateFile(this.path, JSON.stringify(prior));
        }

        throw error;
      }

      const kept = prior && sameAccount(prior.account, user) ? prior.students : {};

      if (prior && kept !== prior.students && !allowAccountChange) {
        if (Object.values(prior.students).some((student) => sameAccount(student, user)))
          throw new SafeError(
            'This session has another saved student selected. Select the default student in the Inna browser session first, or use --allow-account-change deliberately.',
          );
        throw new SafeError(
          'This export changes the account, student, or school. Use --allow-account-change deliberately.',
        );
      }

      const candidate: Saved = {
        version: 3,
        jar: JSON.stringify(await jar.serialize()),
        account: schemas.bindingSchema.parse(user),
        students: { ...kept },
        pauseUntil: throttle.pauseUntil,
        token: token && token.length > 10 ? token : undefined,
        tokenRefreshedAt: token ? this.now() : 0,
      };

      if (studentEntries(user)?.length) {
        const key = String(user.userId);

        if (!matchesEntry(user, key))
          throw new SafeError(
            'Inna did not report one selected student matching this session. Select the intended student in Inna and sign in again.',
          );
        candidate.students[key] = schemas.learnedStudentSchema.parse(user);
      }

      if (token) {
        const claims = parseTokenClaims(token);

        if (claims?.exp) {
          const timestamp = new Date(this.now()).toISOString();
          const expiresAt = new Date(claims.exp * 1000).toISOString();

          this.log(`${timestamp} Inna token saved (expires ${expiresAt})`);
        }
      }

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

  async status(signal?: AbortSignal, studentKey?: string) {
    if (!(await readSaved(this.path))) return { authenticated: false };

    return this.withUser(studentKey, signal, async (_connection, user) => ({
      authenticated: true,
      context: schemas.contextSchema.parse(user),
    }));
  }

  async listStudents(signal?: AbortSignal) {
    return this.session(async (connection, saved) => {
      const user = await connection.request(USER_ENDPOINT, schemas.userSchema);
      const entries = studentEntries(user);

      if (!entries)
        throw new SafeError(
          'Inna returned no usable student list. Omit studentKey to read the default student.',
        );
      const context = schemas.contextSchema.parse(user);
      const onDefault = sameAccount(saved.account, user);

      if (entries.length === 0)
        return {
          students: [
            {
              schoolName: user.schoolLong,
              schoolId: user.schoolId,
              selected: true,
              isDefault: onDefault,
              studentId: user.studentId,
              studentName: user.studentName,
            },
          ],
          context,
          ...this.stamp(),
        };
      const known = defaultKey(saved);

      return {
        students: entries.map((entry) => ({
          studentKey: entry.userId,
          title: entry.title,
          schoolName: entry.skoli_heiti,
          schoolId: entry.skoli_id,
          selected: entry.loggedIn,
          isDefault: entry.userId === known,
          studentId: saved.students[entry.userId]?.studentId,
          studentName: entry.nafn,
        })),
        context,
        ...this.stamp(),
      };
    }, signal);
  }

  async overview(signal?: AbortSignal, studentKey?: string) {
    return this.withUser(studentKey, signal, async (connection, user) => {
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
    });
  }

  async timetable(input: z.infer<typeof schemas.dateRange>, signal?: AbortSignal) {
    const request = schemas.dateRange.parse(input);

    return this.withUser(request.studentKey, signal, async (connection, user) => {
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
    });
  }

  async assignments(
    type: 'assignments' | 'exams' | 'all',
    signal?: AbortSignal,
    studentKey?: string,
  ) {
    return this.withUser(studentKey, signal, async (connection, user) => {
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
    });
  }

  async assignment(assignmentId: string, signal?: AbortSignal, studentKey?: string) {
    schemas.id.parse(assignmentId);

    return this.withUser(studentKey, signal, async (connection, user) => {
      const assignment = await connection.request(
        '/api/GetAssignments/GetAssignmentInfo',
        schemas.assignmentSchema,
        new URLSearchParams({ assignmentId }),
      );

      assignment.description = schemas.plainText(assignment.description);
      assignment.dates = parseDates({ returnDate: assignment.returnDate });

      return { context: schemas.contextSchema.parse(user), assignment };
    });
  }

  async grades(termId?: string, signal?: AbortSignal, studentKey?: string) {
    if (termId !== undefined) schemas.id.parse(termId);

    return this.withUser(studentKey, signal, async (connection, user) => {
      const entries = await connection.request(
        '/api/StudentGrades/GetStudentGrades',
        schemas.gradesSchema,
        new URLSearchParams({ termId: termId ?? user.defaultTermId }),
      );

      for (const entry of entries) entry.dates = parseDates({ dateFinished: entry.dateFinished });

      return { context: schemas.contextSchema.parse(user), entries };
    });
  }

  async courseGrades(groupId: string, signal?: AbortSignal, studentKey?: string) {
    schemas.id.parse(groupId);

    return this.withUser(studentKey, signal, async (connection, user) => {
      const { assignments } = await connection.request(
        `/api/GetAssignments/Groups/${groupId}/StudentProjects`,
        schemas.courseGradesSchema,
      );

      for (const entry of assignments)
        entry.dates = parseDates({ assignDate: entry.assignDate, returnDate: entry.returnDate });

      return { context: schemas.contextSchema.parse(user), assignments };
    });
  }

  async attendance(termId = '', signal?: AbortSignal, studentKey?: string) {
    if (termId) schemas.id.parse(termId);

    return this.withUser(studentKey, signal, async (connection, user) => {
      const attendance = await connection.request(
        '/api/Attendance/GetAttendance',
        schemas.attendanceSchema,
        new URLSearchParams({ termId, type: '0' }),
      );

      attendance.dates = parseDates({ dateFrom: attendance.dateFrom, dateTo: attendance.dateTo });

      return { context: schemas.contextSchema.parse(user), attendance };
    });
  }

  async materials(groupId: string, signal?: AbortSignal, studentKey?: string) {
    schemas.id.parse(groupId);

    return this.withUser(studentKey, signal, async (connection, user) => {
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
    });
  }

  async messages(rowFrom = 1, rowTo = 21, signal?: AbortSignal, studentKey?: string) {
    z.number().int().min(1).parse(rowFrom);
    z.number()
      .int()
      .min(rowFrom)
      .max(rowFrom + 100)
      .parse(rowTo);

    return this.withUser(studentKey, signal, async (connection, user) => {
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
    });
  }

  async message(messageId: string, type: string, signal?: AbortSignal, studentKey?: string) {
    schemas.id.parse(messageId);
    z.string()
      .regex(/^[A-Z]$/)
      .parse(type);

    return this.withUser(studentKey, signal, async (connection, user) => {
      const message = await connection.request(
        '/api/Messages/GetMessageDetails',
        schemas.messageSchema,
        new URLSearchParams({ messageId, type }),
      );

      message.message = schemas.plainText(message.message);
      message.dates = parseDates({
        dateCreated: message.dateCreated,
        dateSent: message.dateSent,
      });

      return { context: schemas.contextSchema.parse(user), message };
    });
  }

  async absences(input: z.infer<typeof schemas.dateRange>, signal?: AbortSignal) {
    const request = schemas.dateRange.parse(input);

    return this.withUser(request.studentKey, signal, async (connection, user) => {
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
    });
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
    const { studentKey, ...request } = schemas.absenceInputSchema.parse(input);

    return this.withUser(
      studentKey,
      signal,
      async (connection, user, target) => {
        const previous = await readAbsence(this.path);

        if (previous?.state === 'submitting' || previous?.state === 'unknown')
          throw new SafeError(
            'An earlier absence submission is uncertain. Review its status and Inna history; do not retry it.',
          );
        await this.checkAbsence(connection, user, request);

        const record: AbsenceRecord = {
          operationId: randomUUID(),
          account: schemas.bindingSchema.parse(user),
          studentKey: target.key,
          request,
          state: 'prepared',
          expiresAt: this.now() + 10 * 60_000,
        };

        await saveAbsence(this.path, record);

        return { ...record, studentName: user.studentName, schoolName: user.schoolLong };
      },
      false,
    );
  }

  async submitAbsence(operationId: string, confirm: true, signal?: AbortSignal) {
    if (!this.allowAbsenceWrites)
      throw new SafeError('Absence writes require --allow-absence-writes.');
    z.uuid().parse(operationId);
    z.literal(true).parse(confirm);

    return this.withStudent(
      // The preview decides the student: Inna is switched to it before any check.
      async () => {
        const record = await readAbsence(this.path);

        if (record?.operationId !== operationId) throw noPreview();

        return record.studentKey;
      },
      async (connection, user, target) => {
        const record = await readAbsence(this.path);

        if (record?.operationId !== operationId || !sameAccount(record.account, user))
          throw noPreview();

        if (record.state === 'submitted') return record;

        if (record.state !== 'prepared')
          throw new SafeError(
            'Submission outcome is uncertain. Review Inna history; this request will not be replayed.',
          );

        if (record.expiresAt <= this.now())
          throw new SafeError('The absence preview expired. Prepare and approve a fresh preview.');

        const checkedDay = await this.checkAbsence(connection, user, record.request);

        const current = await connection.request(USER_ENDPOINT, schemas.userSchema);

        if (
          !sameAccount(record.account, current) ||
          !stillSelected(target, current) ||
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

  // Reads the current context without switching, so an uncertain operation stays reviewable.
  async absenceStatus(signal?: AbortSignal) {
    return this.session(async (connection, saved) => {
      const user = await connection.request(USER_ENDPOINT, schemas.userSchema);
      const record = await readAbsence(this.path);

      if (
        record &&
        ![saved.account, ...Object.values(saved.students)].some((student) =>
          sameAccount(record.account, student),
        )
      )
        throw new SafeError(
          'The saved absence operation belongs to another account, student, or school.',
        );

      return {
        context: schemas.contextSchema.parse(user),
        operation: record ?? null,
        ...this.stamp(),
      };
    }, signal);
  }
}
