import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Cookie, CookieJar } from 'tough-cookie';
import { z } from 'zod';
import { SafeError, readBody } from '@family-mcp/mcp-runtime';
import {
  defaultKeyProvider,
  defaultSecretRecordPath,
  defaultSessionPath,
  LocalKeyFileProvider,
  readPrivateFile,
  retiredStorePaths,
  SessionStoreError,
  startupCheck,
  sweepTemp,
  withFileLock,
  withSecretStore,
  writePrivateFile,
  type KeyProvider,
  type SecretRecordOptions,
  type SecretStore,
} from '@family-mcp/session-store';
import * as schemas from './schemas.js';
import { normalizeDate, parseDates } from './dates.js';

export const ORIGIN = 'https://nam.inna.is';

export const MAX_SESSION_BYTES = 262_144;

const MAX_STUDENTS = 64;

const MAX_NAME_LENGTH = 256;

// A string character is at most six bytes of JSON (an escaped control character or surrogate).
const BINDING_BYTES = '{"userId":,"studentId":"","schoolId":""}'.length + 16 + 32 + 32;

const STUDENT_BYTES =
  '"":,'.length + 32 + BINDING_BYTES + ',"studentName":""'.length + 6 * MAX_NAME_LENGTH;

/** The largest JSON the saved-session schema can produce, so a valid session always fits. */
export const RECORD_MAX_BYTES =
  '{"version":2,"jar":"","account":,"students":{},"pauseUntil":}'.length +
  6 * MAX_SESSION_BYTES +
  BINDING_BYTES +
  (MAX_STUDENTS * STUDENT_BYTES - 1) +
  24;

export const cookieNames = new Set(['SESSION', 'JSESSIONID', 'XSRF-TOKEN']);

const studentPaths = new Set(['/Components/Students/Students.html', '/auth/system']);

const USER_ENDPOINT = '/api/UserData/GetLoggedInUser';

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

function noPreview(): SafeError {
  return new SafeError('No matching absence preview for this account, student, and school.');
}

// Version 1 files hold one binding; they are read as version 2 without learned students.
export const savedSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  jar: z.string().max(MAX_SESSION_BYTES),
  account: schemas.bindingSchema,
  students: z
    .record(
      schemas.id,
      schemas.learnedStudentSchema.extend({
        studentName: z.string().transform((name) => name.slice(0, MAX_NAME_LENGTH)),
      }),
    )
    .default({}),
  pauseUntil: z.number().default(0),
});

type Saved = z.infer<typeof savedSchema>;

/** The student bound keeps RECORD_MAX_BYTES finite; checked after a parse for its own message. */
function bounded(saved: Saved): Saved {
  if (Object.keys(saved.students).length > MAX_STUDENTS) throw tooManyStudents();

  return saved;
}

function tooManyStudents(): SafeError {
  return new SafeError(
    'This Inna session holds more saved students than this version keeps. Run inna-mcp auth logout, then sign in again.',
  );
}

/** The store record's plaintext: the saved session, or null after logout. */
const encode = (saved: Saved | null) => JSON.stringify(saved && bounded(savedSchema.parse(saved)));

function uncertain(): SafeError {
  return new SafeError(
    'The last write to the Inna session store did not complete, so its session is not used. Remove session.enc and session.enc.marker from the Inna store folder, then run inna-mcp auth login again.',
  );
}

/** Fixed messages: a store failure never shows a path, key or cookie, and never falls back. */
function storeError(error: SessionStoreError): SafeError {
  switch (error.code) {
    case 'STORE_UNAVAILABLE':
      return new SafeError(
        'The Inna store key is missing. Run inna-mcp auth login or auth import to sign in again.',
      );
    case 'STORE_BACKEND_RETIRED':
      return new SafeError(
        'The Inna session store is a leftover of an earlier test build that kept its key in the macOS Keychain. Remove session.enc and session.enc.marker from the Inna store folder, then run inna-mcp auth login again.',
      );
    case 'STORE_WRITE_UNCERTAIN':
      return uncertain();
    case 'UNSAFE_FILE':
      return new SafeError(
        'Cannot use the Inna session store. Run inna-mcp auth status in a terminal; it names the file and the fix. Do not delete the store first.',
      );
    case 'STORE_ERROR':
      return new SafeError(
        'Cannot use the Inna session store. Its files or key are damaged, unsafe, or not readable.',
      );
    default:
      return new SafeError(
        'Cannot access the private Inna files. Check permissions or wait for another operation.',
      );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new SafeError('Cannot inspect the private Inna files. Check their permissions.');
  }
}

const STORAGE = 'Saved in an encrypted file.';

/** True when the key is missing; any other key failure, a retired store first, is thrown. */
async function keyLost(store: SecretStore): Promise<boolean> {
  try {
    await store.checkKey();

    return false;
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'STORE_UNAVAILABLE') return true;
    throw error;
  }
}

/** The committed record: a session, null after logout, or undefined while the store holds none. */
async function stored(store: SecretStore): Promise<Saved | null | undefined> {
  const text = await store.read();

  if (text === null) return undefined;

  let saved: Saved | null;

  try {
    saved = savedSchema.nullable().parse(JSON.parse(text));
  } catch {
    throw new SafeError(
      'Invalid Inna session store record. Run inna-mcp auth login or auth import again.',
    );
  }

  return saved && bounded({ ...saved, version: 2 });
}

/** The legacy session file is a credential; remove it and its orphaned temporaries, never the absence record. */
async function removeLegacy(path: string): Promise<boolean> {
  try {
    const found = await exists(path);
    await rm(path, { force: true });
    await sweepTemp(path);

    return found;
  } catch {
    throw new SafeError(
      'Cannot remove the old plaintext Inna session file. Any encrypted-store change already completed; remove that file by hand.',
    );
  }
}

/** Resolve symbolic links in the longest existing prefix, so aliases compare equal. */
async function canonical(path: string): Promise<string> {
  let existing = resolve(path);
  const rest: string[] = [];

  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch (error) {
      const parent = dirname(existing);

      if (
        parent === existing ||
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw new SafeError('Cannot resolve the Inna session paths. Check their permissions.');
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Same file, or one name is the other's `<name>.` namespace (lock, marker, temporaries) beside it. */
function overlaps(first: string, second: string): boolean {
  const [a, b] = [basename(first), basename(second)];

  return (
    dirname(first) === dirname(second) &&
    (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`))
  );
}

/** The path and every directory above it, short of the root. */
const lineage = (path: string): string[] =>
  dirname(path) === path ? [] : [path, ...lineage(dirname(path))];

/**
 * The legacy file is locked, swept and removed, and the store can be reset, so neither the legacy
 * file nor its absence record may hold, or sit inside a directory of, the record or the key file,
 * or the reverse. Checked before anything is touched.
 */
async function rejectCollisions(record: SecretRecordOptions, legacy: string): Promise<void> {
  const files = [await canonical(legacy), await canonical(`${legacy}.absence.json`)];
  const owned = [await canonical(record.path)];

  if (record.keys instanceof LocalKeyFileProvider) owned.push(await canonical(record.keys.path));

  if (
    files.some((file) =>
      owned.some(
        (path) =>
          lineage(file).some((up) => overlaps(up, path)) ||
          lineage(path).some((up) => overlaps(file, up)),
      ),
    )
  )
    throw new SafeError(
      'INNA_SESSION_FILE overlaps the encrypted Inna session store or its key. Choose another path.',
    );
}

/** One hold of the legacy lock and the store lock: where the session is, and how to save it there. */
type Held = {
  store: SecretStore;
  record: SecretRecordOptions;
  /** A marker, or even a lone record, means the store decides; the legacy file is never read. */
  decides: boolean;
  storage: string;
  read(): Promise<Saved | undefined>;
  write(saved: Saved): Promise<void>;
};

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

  if (Object.keys(saved.students).length >= MAX_STUDENTS) throw tooManyStudents();
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
  let saved: Saved;

  try {
    saved = savedSchema.parse(
      JSON.parse(await readPrivateFile(path, { maxBytes: MAX_SESSION_BYTES })),
    );
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return undefined;
    throw new SafeError(
      'Cannot read the Inna session. Check its format and owner-only permissions.',
    );
  }

  return bounded({ ...saved, version: 2 });
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
  /** The pre-store plaintext session file; the absence record keeps its path beside it. */
  sessionFile?: string;
  /** Test seam: the default is the platform record path and its key file. */
  store?: { path: string; keys: KeyProvider };
  fetch?: Fetch;
  now?: () => number;
  allowAbsenceWrites?: boolean;
};

export type KeepAlive = { status: 'kept' | 'skipped' | 'signInRequired' | 'failed' };

export type MigrateResult = 'migrated' | 'already' | 'already-removed-legacy';

/** Where the session was saved, and whether a store whose key was lost was replaced for it. */
export type SavedSession = { storage: string; replaced: boolean };

export class InnaClient {
  readonly path: string;
  // Hash of the credentials Inna last refused, in memory only; keep-alive waits for new ones.
  private refused: string | undefined;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly allowAbsenceWrites: boolean;
  private readonly store: ClientOptions['store'];

  constructor(options: ClientOptions = {}) {
    this.path = options.sessionFile ?? sessionPath();

    if (!isAbsolute(this.path)) throw new SafeError('The Inna session path must be absolute.');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.allowAbsenceWrites = options.allowAbsenceWrites ?? false;
    this.store = options.store;
  }

  /**
   * Every operation holds the legacy file's lock, which also guards the absence record, and the
   * store's lock inside it: always in that order, and never taken again within the hold.
   */
  private async locked<T>(work: (held: Held) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      const record: SecretRecordOptions = {
        path: this.store?.path ?? defaultSecretRecordPath('inna-mcp'),
        server: 'inna-mcp',
        profile: 'default',
        purpose: 'session',
        schema: 1,
        maxBytes: RECORD_MAX_BYTES,
        keys: this.store?.keys ?? defaultKeyProvider({ server: 'inna-mcp', profile: 'default' }),
        retired: retiredStorePaths('inna-mcp'),
        signal,
      };

      await rejectCollisions(record, this.path);

      return await withFileLock(this.path, { signal }, async () => {
        await sweepTemp(this.path);
        await sweepTemp(`${this.path}.absence.json`);

        return withSecretStore(record, async (store) => {
          const decides = (await store.exists()) || (await exists(record.path));

          return work({
            store,
            record,
            decides,
            storage: decides ? STORAGE : 'Saved in a plaintext file. Run inna-mcp auth migrate.',
            read: async () =>
              decides ? ((await stored(store)) ?? undefined) : readSaved(this.path),
            write: (saved) =>
              decides
                ? store.write(encode(saved))
                : writePrivateFile(this.path, JSON.stringify(saved)),
          });
        });
      });
    } catch (error) {
      if (error instanceof SessionStoreError) throw storeError(error);
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
    return this.locked(async (held) => {
      const saved = await held.read();

      if (!saved)
        throw new SafeError(
          'No Inna session. Run inna-mcp auth login or auth import with a private cookie export.',
        );

      return this.persisting(held, saved, work, signal);
    }, signal);
  }

  // Runs work on the saved cookies and always writes back the jar and any rate-limit pause.
  private async persisting<T>(
    held: Held,
    saved: Saved,
    work: (connection: Connection, saved: Saved) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const jar = await CookieJar.deserialize(saved.jar);
    const before = credentials(saved);

    try {
      return await work(new Connection(jar, saved, this.fetcher, this.now, signal), saved);
    } finally {
      saved.jar = JSON.stringify(await jar.serialize());
      await this.writeBack(held, saved, before);
    }
  }

  private async writeBack(held: Held, saved: Saved, before: string): Promise<void> {
    try {
      await held.write(saved);
    } catch (error) {
      // Unchanged cookies are still valid: keep the record and report the store failure.
      if (!held.decides || credentials(saved) === before) throw error;
      // Inna rotated the cookies, so the record must never offer the old ones again.
      // Removing it under the held lock reads as STORE_WRITE_UNCERTAIN until the next login.
      await rm(held.record.path, { force: true }).catch(() => undefined);
      throw uncertain();
    }
  }

  /**
   * Touches the saved session so Inna does not idle it out. Reads no school data, never
   * switches or learns a student, and reports every failure, store failures included, as a
   * status instead of throwing. It never resets the store.
   */
  async keepAlive(signal?: AbortSignal): Promise<KeepAlive> {
    let saved: Saved | undefined;

    try {
      return await this.locked(async (held) => {
        saved = await held.read();

        if (!saved || saved.pauseUntil > this.now() || credentials(saved) === this.refused)
          return { status: 'skipped' };

        await this.persisting(
          held,
          saved,
          async (connection) => {
            await connection.request(USER_ENDPOINT, schemas.userSchema);
          },
          signal,
        );

        return { status: 'kept' };
      }, signal);
    } catch (error) {
      if (
        !(error instanceof SafeError) ||
        ![signInRequired().message, sessionExpired().message].includes(error.message)
      )
        return { status: 'failed' };
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

  async importSession(source: string, allowAccountChange = false): Promise<SavedSession> {
    if (!isAbsolute(source)) throw new SafeError('The cookie export path must be absolute.');

    const input = cookieExportSchema.parse(
      JSON.parse(await readPrivateFile(source, { maxBytes: MAX_SESSION_BYTES })),
    );

    return this.saveVerifiedSession(await sessionJar(input), allowAccountChange);
  }

  /**
   * Refuses an unusable session store before the owner signs in, instead of after. A lost key
   * is not a refusal: the login replaces that store.
   */
  async checkStore(): Promise<void> {
    await this.locked(async (held) => {
      if (held.decides && !(await keyLost(held.store))) await stored(held.store);
    });
  }

  /** The saved default student's user id, read locally; a fresh login prefers it. */
  async defaultUserId(): Promise<number | undefined> {
    return this.locked(async (held) =>
      held.decides && (await keyLost(held.store)) ? undefined : (await held.read())?.account.userId,
    );
  }

  async saveVerifiedSession(
    jar: CookieJar,
    allowAccountChange = false,
    signal?: AbortSignal,
  ): Promise<SavedSession> {
    return this.locked(async (held) => {
      // Only this explicit login or import may replace a store whose key is lost.
      const lost = await keyLost(held.store);
      const prior = lost && held.decides ? undefined : await held.read();
      const throttle = { pauseUntil: prior?.pauseUntil ?? 0 };
      const connection = new Connection(jar, throttle, this.fetcher, this.now, signal);
      let user: schemas.User;

      try {
        user = await connection.request(USER_ENDPOINT, schemas.userSchema);
      } catch (error) {
        if (prior && throttle.pauseUntil > prior.pauseUntil) {
          prior.pauseUntil = throttle.pauseUntil;
          await held.write(prior);
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
        version: 2,
        jar: JSON.stringify(await jar.serialize()),
        account: schemas.bindingSchema.parse(user),
        students: { ...kept },
        pauseUntil: throttle.pauseUntil,
      };

      if (studentEntries(user)?.length) {
        const key = String(user.userId);

        if (!matchesEntry(user, key))
          throw new SafeError(
            'Inna did not report one selected student matching this session. Select the intended student in Inna and sign in again.',
          );
        candidate.students[key] = schemas.learnedStudentSchema.parse(user);
      }

      const text = encode(candidate);
      signal?.throwIfAborted();

      if (lost) {
        if (held.decides) await held.store.reset();
        await held.store.createKey();
      }

      await held.store.write(text);

      // The store decides from here on, so a plaintext file would never be read again.
      await removeLegacy(this.path);

      return { storage: STORAGE, replaced: lost && held.decides };
    }, signal);
  }

  /**
   * Move the legacy session into the store, which reads it back before it commits; only then
   * does the plaintext file go. A store with a marker but no record (an interrupted first write
   * or reset) takes the explicit migration. Never resets a store, never touches the absence record.
   */
  async migrate(): Promise<MigrateResult> {
    return this.locked(async (held) => {
      if (held.decides && (await stored(held.store)) !== undefined)
        return (await removeLegacy(this.path)) ? 'already-removed-legacy' : 'already';
      const legacy = await readSaved(this.path);

      if (!legacy)
        throw new SafeError(
          'No Inna session. Run inna-mcp auth login or auth import with a private cookie export.',
        );
      const text = encode(legacy);

      // A store that decides was just read, so a missing key here belongs to a store never used.
      if (await keyLost(held.store)) await held.store.createKey();

      await held.store.write(text);
      await removeLegacy(this.path);

      return 'migrated';
    });
  }

  async logout(): Promise<void> {
    await this.locked(async (held) => {
      // A logged-out record keeps the store deciding, so a planted legacy file is never read.
      if (held.decides) await held.store.write(encode(null));
      await removeLegacy(this.path);
      // A logout cannot discard evidence of a possibly submitted absence.
    });
  }

  async status(signal?: AbortSignal, studentKey?: string) {
    const storage = await this.locked(
      async (held) => ((await held.read()) ? held.storage : undefined),
      signal,
    );

    if (!storage) return { authenticated: false };

    return this.withUser(studentKey, signal, async (_connection, user) => ({
      authenticated: true,
      storage,
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

/**
 * The CLI's store preflight before it serves or runs an auth command: false, after one stderr
 * line, when the store is unsafe; a notice when an earlier build's store is still on disk.
 */
export function checkStoreAtStartup(): Promise<boolean> {
  return startupCheck({
    server: 'inna-mcp',
    signIn: 'inna-mcp auth login',
    store: () => ({
      path: defaultSecretRecordPath('inna-mcp'),
      keys: defaultKeyProvider({ server: 'inna-mcp', profile: 'default' }),
      retired: retiredStorePaths('inna-mcp'),
    }),
  });
}
