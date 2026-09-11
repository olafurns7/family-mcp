import { resolve } from 'node:path';
import { InfoMentorHttp, parseForms } from './http.js';
import { withSessionLock } from './lock.js';
import { credentialsSchema, promptCredentials, readCredentials } from './credentials.js';
import type { Credentials } from './credentials.js';
import {
  captureSession,
  InfoMentorError,
  LOGIN_URL,
  readSession,
  restoreCookies,
  sessionPath,
  throwIfAborted,
  trustedUrl,
  writeSession,
} from './session.js';
import type { SessionOptions } from './session.js';

export type LoginOptions = SessionOptions & {
  localForm?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: 'waiting' | 'saved', loginUrl?: string) => void;
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
      credentials = await promptCredentials(signal, (url) => options.onProgress?.('waiting', url));
    } else
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Credentials required. Use the app’s private secret input for INFOMENTOR_USERNAME (kennitala or InfoMentor username; no email required) and INFOMENTOR_PASSWORD, then run infomentor-mcp login with those secrets injected into its environment. If the MCP process already has them, call infomentor_login. Alternatively supply credentialsFile or importFile. Never put secret values in chat or MCP arguments. Browser login is opt-in with localForm; do not use it on a remote VM.',
      );

    const http = new InfoMentorHttp();
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
    await writeSession(sessionFromHttp(http), file, options.signal);
    options.onProgress?.('saved');
  });
}

export function sessionFromHttp(http: InfoMentorHttp): ReturnType<typeof captureSession> {
  const session = captureSession(http.jar);

  if (http.parent) {
    session.accountId = http.parent.account.currentUser.id;
    const selected = http.parent.account.pupils.filter((pupil) => pupil.selected);

    if (selected.length === 1 && selected[0]) session.selectedChildId = selected[0].id;
  }

  return session;
}

export async function importSession(
  file: string,
  options: SessionOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await withSessionLock(sessionPath(options.sessionFile), signal, async () => {
    const imported = await readSession(resolve(file));
    const http = new InfoMentorHttp(restoreCookies(imported));
    await http.requireAuthentication(signal);
    await http.readParent(signal);
    await writeSession(sessionFromHttp(http), sessionPath(options.sessionFile), signal);
  });
}
