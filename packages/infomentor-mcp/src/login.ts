import { resolve } from 'node:path';
import { InfoMentorHttp, parseForms } from './http.js';
import { withSessionLock } from './lock.js';
import {
  credentialsSchema,
  promptCredentials,
  readCredentials,
  type Credentials,
  type OpenBrowser,
} from './credentials.js';
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
  writeSession,
  type SavedSession,
  type SessionOptions,
} from './session.js';

export type ImportOptions = SessionOptions & {
  /** Replace a saved session that belongs to a different verified account. Default false. */
  allowAccountChange?: boolean;
};

export type LoginOptions = ImportOptions & {
  localForm?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: 'waiting' | 'saved', loginUrl?: string) => void;
  openBrowser?: OpenBrowser;
};

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

/** Build a verified candidate; the caller commits only after checking account/context. */
export async function createAuthenticatedHttp(options: LoginOptions): Promise<InfoMentorHttp> {
  const timeout = options.timeoutMs ?? 300_000;

  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 3_600_000)
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Login timeout must be between 1 millisecond and one hour.',
    );
  throwIfAborted(options.signal);
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let credentials: Credentials | undefined;

  try {
    const file = options.credentialsFile ?? process.env['INFOMENTOR_CREDENTIALS_FILE'];

    if (file) credentials = await readCredentials(resolve(file), signal);
    else if (
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
      credentials = configured.data;
    } else if (options.localForm) {
      credentials = await promptCredentials(
        signal,
        (url) => options.onProgress?.('waiting', url),
        options.openBrowser,
      );
    } else
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Credentials required. Use the app’s private secret input for INFOMENTOR_USERNAME (kennitala or InfoMentor username; no email required) and INFOMENTOR_PASSWORD, then run infomentor-mcp login with those secrets injected into its environment. If the MCP process already has them, call infomentor_login. Alternatively supply credentialsFile or importFile. Never put secret values in chat or MCP arguments. Browser login is opt-in with localForm; do not use it on a remote VM.',
      );

    const http = new InfoMentorHttp(undefined, 0, options.fetch);
    await authenticate(http, credentials, signal);
    credentials.password = '';
    await http.readParent(signal);

    return http;
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted)
      throw new InfoMentorError(
        'LOGIN_TIMEOUT',
        'Sign-in timed out. The previous saved session was kept.',
      );
    throwIfAborted(options.signal);
    throw error;
  } finally {
    if (credentials) credentials.password = '';
  }
}

export async function login(options: LoginOptions = {}): Promise<void> {
  const file = sessionPath(options.sessionFile);
  await withSessionLock(file, options.signal, async () => {
    const http = await createAuthenticatedHttp(options);
    const session = sessionFromHttp(http);
    await requireSameAccount(file, session, options.allowAccountChange);
    await (options.writeSession ?? writeSession)(session, file, options.signal);
    options.onProgress?.('saved');
  });
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
 * An explicit login or import must not silently switch the saved account: a local attacker who
 * hijacks the loopback form, or a mistaken credentials file, would otherwise take over the MCP.
 * Missing, unreadable, and legacy files protect nothing and may be replaced.
 */
async function requireSameAccount(
  file: string,
  candidate: SavedSession,
  allowAccountChange: boolean | undefined,
): Promise<void> {
  if (allowAccountChange) return;
  let previous: SavedSession;

  try {
    previous = await readSession(file);
  } catch {
    return;
  }

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

export async function importSession(
  file: string,
  options: ImportOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const destination = sessionPath(options.sessionFile);
  await withSessionLock(destination, signal, async () => {
    const imported = await readSession(resolve(file));
    const http = httpFromSession(imported, options.fetch);
    await http.requireAuthentication(signal);
    await http.readParent(signal);
    const session = sessionFromHttp(http);
    await requireSameAccount(destination, session, options.allowAccountChange);
    await (options.writeSession ?? writeSession)(session, destination, signal);
  });
}
