import { resolve } from 'node:path';
import { InfoMentorHttp, parseForms } from './http.js';
import { credentialsSchema, readCredentials, type Credentials } from './credentials.js';
import {
  captureSession,
  InfoMentorError,
  LOGIN_URL,
  rateLimitCooldown,
  readSession,
  restoreCookies,
  sessionPath,
  throwIfAborted,
  trustedUrl,
  type SavedSession,
  type SessionOptions,
} from './session.js';
import { changeSession, commitChange, prepareChange, type Previous } from './store.js';

export type ImportOptions = SessionOptions & {
  /** Replace a saved session that belongs to a different verified account. Default false. */
  allowAccountChange?: boolean;
};

export type LoginOptions = ImportOptions & {
  timeoutMs?: number;
  signal?: AbortSignal;
};

function loginDeadline(timeoutMs = 300_000): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000)
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Login timeout must be between 1 millisecond and one hour.',
    );

  return AbortSignal.timeout(timeoutMs);
}

const loginTimedOut = () =>
  new InfoMentorError('LOGIN_TIMEOUT', 'Sign-in timed out. The previous saved session was kept.');

/** One credential submission, then the observed hidden-form relay. No page JavaScript runs. */
export async function authenticate(
  http: InfoMentorHttp,
  credentials: Credentials,
  signal?: AbortSignal,
): Promise<void> {
  const checked = credentialsSchema.safeParse(credentials);

  if (!checked.success)
    throw new InfoMentorError('INVALID_CONFIGURATION', 'Enter a valid username and password.');
  const page = await http.request(LOGIN_URL, undefined, signal, LOGIN_URL);

  const form = parseForms(page.text).find(
    (candidate) => candidate.fields.has('__VIEWSTATE') && candidate.fields.has('__EVENTVALIDATION'),
  );

  if (!form || form.method !== 'post')
    throw new InfoMentorError('UNEXPECTED_PAGE', 'InfoMentor returned an unsupported login form.');
  const action = trustedUrl(new URL(form.action, page.url).href);

  if (action.origin !== new URL(LOGIN_URL).origin)
    throw new InfoMentorError(
      'UNEXPECTED_PAGE',
      'InfoMentor changed its password form destination. Login stopped.',
    );
  form.fields.set('login_ascx$txtNotandanafn', checked.data.username);
  form.fields.set('login_ascx$txtLykilord', checked.data.password);
  form.fields.set('login_ascx$btnLogin', 'Innskrá');
  let response;

  try {
    response = await http.request(action.href, form.fields, signal, page.url);
  } finally {
    form.fields.delete('login_ascx$txtLykilord');
    checked.data.password = '';
  }

  const relay = parseForms(response.text).find((candidate) => candidate.id === 'openid_message');

  if (relay) {
    const destination = trustedUrl(new URL(relay.action, response.url).href);

    if (
      relay.method !== 'post' ||
      !relay.fields.has('oauth_token') ||
      destination.origin !== new URL(LOGIN_URL).origin
    )
      throw new InfoMentorError(
        'UNEXPECTED_PAGE',
        'InfoMentor returned an unsupported authentication handoff.',
      );
    await http.request(destination.href, relay.fields, signal, response.url);
  }

  if (!(await http.isAuthenticated(signal)))
    throw new InfoMentorError(
      'LOGIN_REQUIRED',
      'InfoMentor did not accept the login. Check your credentials; no automatic retry was made.',
    );
}

export function hasConfiguredCredentials(options: SessionOptions): boolean {
  return (
    Boolean(options.credentialsFile ?? process.env['INFOMENTOR_CREDENTIALS_FILE']) ||
    process.env['INFOMENTOR_USERNAME'] !== undefined ||
    process.env['INFOMENTOR_PASSWORD'] !== undefined
  );
}

/**
 * The sign-in to submit: `stored` (renewal) first, then the configured sources. `file` is the
 * credentials file read, as configured.
 */
export async function resolveCredentials(
  options: SessionOptions,
  signal?: AbortSignal,
  stored?: Credentials | null,
): Promise<{ credentials: Credentials; file?: string }> {
  throwIfAborted(signal);

  if (stored) return { credentials: { ...stored } };
  const file = options.credentialsFile ?? process.env['INFOMENTOR_CREDENTIALS_FILE'];

  if (file) return { credentials: await readCredentials(resolve(file), signal), file };

  if (
    process.env['INFOMENTOR_USERNAME'] !== undefined ||
    process.env['INFOMENTOR_PASSWORD'] !== undefined
  ) {
    const configured = credentialsSchema.safeParse({
      username: process.env['INFOMENTOR_USERNAME'],
      password: process.env['INFOMENTOR_PASSWORD'],
    });

    if (!configured.success)
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Use the app’s private secret input to provide both INFOMENTOR_USERNAME (kennitala or InfoMentor username; no email required) and INFOMENTOR_PASSWORD to the login process. Never put their values in chat or MCP arguments.',
      );

    return { credentials: configured.data };
  }

  throw new InfoMentorError(
    'INVALID_CONFIGURATION',
    'Credentials required. Use the app’s private secret input for INFOMENTOR_USERNAME (kennitala or InfoMentor username; no email required) and INFOMENTOR_PASSWORD, then run infomentor-mcp login with those secrets injected into its environment. If the MCP process already has them, call infomentor_login. Alternatively supply credentialsFile or importFile. Never put secret values in chat or MCP arguments.',
  );
}

/** Build a verified candidate; the caller commits only after checking account/context. */
export async function createAuthenticatedHttp(
  options: LoginOptions,
  credentials: Credentials,
  deadline = loginDeadline(options.timeoutMs),
): Promise<InfoMentorHttp> {
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  try {
    throwIfAborted(signal);
    const http = new InfoMentorHttp(undefined, 0, options.fetch);
    await authenticate(http, credentials, signal);
    await http.readParent(signal);

    return http;
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted) throw loginTimedOut();
    throwIfAborted(options.signal);
    throw error;
  } finally {
    credentials.password = '';
  }
}

/**
 * Sign in and save the verified session with the sign-in it used in one store write, then remove
 * the plaintext file. Returns the credentials file read, as configured, if any.
 */
export async function login(options: LoginOptions = {}): Promise<string | undefined> {
  const legacy = sessionPath(options.sessionFile);
  const deadline = loginDeadline(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  // Once the record is written, a late plaintext-removal failure reports itself, not a timeout.
  const write = { committed: false };

  try {
    return await changeSession(legacy, options.keys, signal, async (store, record) => {
      const { credentials, file } = await resolveCredentials(options, signal);
      const previous = await prepareChange(store, record, legacy);
      const http = await createAuthenticatedHttp(options, { ...credentials }, deadline);
      const session = sessionFromHttp(http);
      requireSameAccount(previous.session, session, options.allowAccountChange);
      throwIfAborted(signal);
      await commitChange(store, legacy, { version: 1, session, credentials }, () => {
        write.committed = true;
      });

      return file;
    });
  } catch (error) {
    if (write.committed) throw error;

    if (deadline.aborted && !options.signal?.aborted) throw loginTimedOut();
    throwIfAborted(options.signal);
    throw error;
  }
}

export function sessionFromHttp(http: InfoMentorHttp): SavedSession {
  const session = captureSession(http.jar);

  if (http.parent) {
    session.accountId = http.parent.account.currentUser.id;
    const selected = http.parent.account.pupils.filter((pupil) => pupil.selected);

    if (selected.length === 1 && selected[0]) session.selectedChildId = selected[0].id;
  }

  if (http.rateLimitedUntil > Date.now())
    session.rateLimitedUntil = new Date(http.rateLimitedUntil).toISOString();

  return session;
}

/** Cookies plus the pause InfoMentor requested, so every process sharing the file honours it. */
export function httpFromSession(
  session: SavedSession,
  fetcher?: SessionOptions['fetch'],
): InfoMentorHttp {
  return new InfoMentorHttp(restoreCookies(session), rateLimitCooldown(session), fetcher);
}

/**
 * An explicit login or import must not silently switch the saved account: a mistaken
 * credentials or session file would otherwise replace the account used by the MCP.
 * Missing and legacy-v1 sessions protect nothing. An unsafe or unrecognized saved session cannot
 * safely establish which account it represents, so replacement requires an explicit override.
 */
function requireSameAccount(
  previous: Previous['session'],
  candidate: SavedSession,
  allowAccountChange: boolean | undefined,
): void {
  if (allowAccountChange || previous === null) return;

  if (previous === undefined)
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'The existing InfoMentor session cannot be verified. The previous session was kept. Log out first, or pass allowAccountChange to replace it.',
    );

  if (
    previous.accountId !== undefined &&
    candidate.accountId !== undefined &&
    previous.accountId !== candidate.accountId
  )
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'The new sign-in belongs to a different InfoMentor account than the saved session. The previous session was kept. Log out first, or pass allowAccountChange to replace it.',
    );
}

/** Verify and save an exported session; a stored sign-in is kept only for the same account. */
export async function importSession(
  file: string,
  options: ImportOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const legacy = sessionPath(options.sessionFile);
  await changeSession(legacy, options.keys, signal, async (store, record) => {
    const imported = await readSession(resolve(file));
    const previous = await prepareChange(store, record, legacy);
    const http = httpFromSession(imported, options.fetch);
    await http.requireAuthentication(signal);
    await http.readParent(signal);
    const session = sessionFromHttp(http);
    requireSameAccount(previous.session, session, options.allowAccountChange);
    throwIfAborted(signal);
    const kept = previous.record?.session?.accountId;

    await commitChange(store, legacy, {
      version: 1,
      session,
      credentials:
        kept !== undefined && kept === session.accountId
          ? (previous.record?.credentials ?? null)
          : null,
    });
  });
}
