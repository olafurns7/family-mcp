import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { z } from 'zod';

export const LOGIN_URL = 'https://im1.infomentor.is/production/mentor/';

export const PARENT_URL = 'https://minn.infomentor.is/';

export const LOGIN_REQUIRED =
  'Call infomentor_login to sign in or import a session. CLI alternative: infomentor-mcp login.';

export type ErrorCode =
  | 'LOGIN_REQUIRED'
  | 'INVALID_SESSION'
  | 'INVALID_CONFIGURATION'
  | 'UNEXPECTED_PAGE'
  | 'NETWORK_ERROR'
  | 'LOGIN_TIMEOUT'
  | 'CANCELLED'
  | 'CHALLENGE_REQUIRED'
  | 'RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'OPERATION_IN_PROGRESS';

/** Only these messages are safe for CLI/MCP output; never forward upstream bodies or URLs. */
export class InfoMentorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'InfoMentorError';
  }
}

export type SessionOptions = { sessionFile?: string; credentialsFile?: string };

const isInfoMentorHost = (host: string): boolean =>
  host === 'infomentor.is' || host.endsWith('.infomentor.is');

export function trustedUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new InfoMentorError('INVALID_CONFIGURATION', 'Invalid InfoMentor URL.');
  }

  if (
    url.protocol !== 'https:' ||
    !isInfoMentorHost(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Only HTTPS hosts under infomentor.is are supported.',
    );
  }

  return url;
}

export function sessionPath(
  path = process.env['INFOMENTOR_SESSION_PATH'] ??
    join(homedir(), '.infomentor-mcp', 'session.json'),
): string {
  if (!isAbsolute(path))
    throw new InfoMentorError('INVALID_CONFIGURATION', 'The session file path must be absolute.');

  return path;
}

const cookieSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  domain: z.string().refine((value) => isInfoMentorHost(value.replace(/^\./, ''))),
  path: z.string().startsWith('/'),
  expires: z.string().optional(),
  maxAge: z.union([z.number(), z.literal('Infinity'), z.literal('-Infinity')]).optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  hostOnly: z.boolean().optional(),
  sameSite: z.enum(['strict', 'lax', 'none']).optional(),
  creation: z.string().optional(),
  lastAccessed: z.string().optional(),
});

export const savedSessionSchema = z.object({
  version: z.literal(2),
  savedAt: z.iso.datetime(),
  cookies: z.array(cookieSchema),
  accountId: z.string().min(1).optional(),
  selectedChildId: z.string().min(1).optional(),
});

export type SavedSession = z.infer<typeof savedSessionSchema>;

export const pupilSchema = z.object({ id: z.string(), name: z.string(), selected: z.boolean() });

export const timetableEntrySchema = z.object({
  start: z.string(),
  end: z.string(),
  title: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  notes: z.object({ roomInfo: z.string(), timetableNotes: z.string(), tutors: z.string() }),
  allDay: z.boolean(),
  establishmentName: z.string().nullable(),
});

export const overviewSchema = z.object({
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  retrievedAt: z.iso.datetime(),
  children: z.array(pupilSchema),
  timetable: z.array(timetableEntrySchema).nullable(),
});

export type Overview = z.infer<typeof overviewSchema>;

export const selectChildRequestSchema = z.object({ childId: z.string().min(1).max(1024) }).strict();

export type SelectChildRequest = z.infer<typeof selectChildRequestSchema>;

export const messagesRequestSchema = z
  .object({
    folder: z.enum(['inbox', 'sent']).default('inbox'),
    search: z.string().max(500).default(''),
    page: z.number().int().min(1).max(100_000).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const messageRequestSchema = z.object({ id: z.number().int().positive() }).strict();

export const notificationsRequestSchema = z
  .object({
    selectedChildOnly: z.boolean().default(false),
    includeCleared: z.boolean().default(false),
  })
  .strict();

const messageUserSchema = z.object({ id: z.number().int(), displayName: z.string() });

export const messageSummarySchema = z.object({
  id: z.number().int().positive(),
  messageContextType: z.string(),
  sentUser: messageUserSchema,
  isNew: z.boolean(),
  messageSubject: z.string(),
  timeSent: z.string(),
});

export const messageDetailSchema = messageSummarySchema.extend({
  messageBodyPlainText: z.string(),
  toUsers: z.array(messageUserSchema),
  messageFolder: z.string(),
});

export const messagesPageSchema = z.object({
  items: z.array(messageSummarySchema),
  more: z.boolean(),
});

export const messagesSchema = messagesPageSchema.extend({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  folder: z.enum(['inbox', 'sent']),
  retrievedAt: z.iso.datetime(),
});

export const messageSchema = z.object({
  message: messageDetailSchema,
  retrievedAt: z.iso.datetime(),
});

export const notificationSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  subTitle: z.string(),
  subjectsCourses: z.string(),
  dateSent: z.string(),
  appType: z.string(),
  state: z.enum(['New', 'Seen', 'Read', 'Cleared']),
  type: z.string(),
  url: z.string(),
  pupilIM2Id: z.number().int(),
  pupilSourceId: z.string(),
  currentlySelectedPupil: z.boolean(),
});

export const notificationsDataSchema = z.object({ notifications: z.array(notificationSchema) });

export const notificationsSchema = notificationsDataSchema.extend({
  selectedChildOnly: z.boolean(),
  includeCleared: z.boolean(),
  retrievedAt: z.iso.datetime(),
});

export type MessagesRequest = z.input<typeof messagesRequestSchema>;

export type MessageRequest = z.input<typeof messageRequestSchema>;

export type NotificationsRequest = z.input<typeof notificationsRequestSchema>;

export type Messages = z.infer<typeof messagesSchema>;

export type Message = z.infer<typeof messageSchema>;

export type Notifications = z.infer<typeof notificationsSchema>;

export const sessionStatusSchema = z.object({
  authenticated: z.boolean(),
  nextStep: z.string().optional(),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export function captureSession(jar: CookieJar): SavedSession {
  return savedSessionSchema.parse({
    version: 2,
    savedAt: new Date().toISOString(),
    // tough-cookie omits value for empty cookies, including authentication deletion cookies.
    cookies: (jar.serializeSync()?.cookies ?? []).filter((cookie) => cookie.value),
  });
}

export function restoreCookies(session: SavedSession): CookieJar {
  try {
    const saved = savedSessionSchema.parse(session);

    return CookieJar.fromJSON(JSON.stringify({ cookies: saved.cookies }));
  } catch {
    throw new InfoMentorError('INVALID_SESSION', 'Invalid session cookies. Sign in again.');
  }
}

export async function readSession(path = sessionPath()): Promise<SavedSession> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new InfoMentorError('LOGIN_REQUIRED', LOGIN_REQUIRED);
    throw new InfoMentorError(
      'INVALID_SESSION',
      'Cannot read the session file. Check its path and permissions.',
    );
  }

  try {
    return savedSessionSchema.parse(JSON.parse(text));
  } catch {
    throw new InfoMentorError(
      'INVALID_SESSION',
      'Invalid or older browser session file. Run login again to create an HTTP session.',
    );
  }
}

/** Atomic rename is the commit point; cancellation before it preserves the previous account. */
export async function writeSession(
  session: SavedSession,
  path = sessionPath(),
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const checked = savedSessionSchema.safeParse(session);

  if (!checked.success)
    throw new InfoMentorError('INVALID_SESSION', 'Refusing to save an invalid InfoMentor session.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';

  try {
    await writeFile(temporary, JSON.stringify(checked.data), { mode: 0o600, flag: 'wx', signal });
    throwIfAborted(signal);
    await rename(temporary, path);
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new InfoMentorError(
      'CANCELLED',
      'Operation cancelled. The existing saved session was kept.',
    );
}
