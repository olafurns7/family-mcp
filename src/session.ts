import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
import { z } from 'zod';

export const LOGIN_URL = 'https://im1.infomentor.is/production/mentor/';

export const LOGIN_REQUIRED =
  'Call infomentor_login to open a browser or import a session. CLI alternative: infomentor-mcp login.';

const isInfoMentorHost = (host: string): boolean =>
  host === 'infomentor.is' || host.endsWith('.infomentor.is');

export type ErrorCode =
  | 'LOGIN_REQUIRED'
  | 'INVALID_SESSION'
  | 'INVALID_CONFIGURATION'
  | 'BROWSER_UNAVAILABLE'
  | 'UNEXPECTED_PAGE'
  | 'NETWORK_ERROR'
  | 'LOGIN_TIMEOUT'
  | 'CANCELLED'
  | 'CHALLENGE_REQUIRED'
  | 'RATE_LIMITED'
  | 'ACCESS_DENIED'
  | 'OPERATION_IN_PROGRESS';

/** Messages are safe for CLI/MCP output; underlying browser errors are never forwarded. */
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

export const browserChoiceSchema = z.enum(['chrome', 'chromium', 'msedge', 'firefox', 'webkit']);

export type BrowserChoice = z.infer<typeof browserChoiceSchema>;

export type SessionOptions = {
  sessionFile?: string;
  browser?: BrowserChoice;
  /** An installed Chromium-compatible browser, such as Brave or Vivaldi. */
  executablePath?: string;
  /** Loopback endpoint (including an SSH tunnel), or a trusted TLS CDP endpoint. */
  cdpUrl?: string;
};

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

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

const originSchema = z.string().refine((value) => {
  try {
    return trustedUrl(value).origin === value;
  } catch {
    return false;
  }
});

const storageStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string().refine((value) => isInfoMentorHost(value.replace(/^\./, ''))),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(['Strict', 'Lax', 'None']),
      partitionKey: z.string().optional(),
    }),
  ),
  origins: z.array(
    z.object({
      origin: originSchema,
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
      // Playwright's public type omits the IndexedDB snapshot. Preserve its JSON
      // serialization rather than casting or inventing a competing database type.
      indexedDB: z.array(z.json()).optional(),
    }),
  ),
});

export const savedSessionSchema = z.object({
  version: z.literal(1),
  url: z.string().refine((value) => {
    try {
      trustedUrl(value);

      return true;
    } catch {
      return false;
    }
  }),
  savedAt: z.iso.datetime(),
  storageState: storageStateSchema,
});

export type SavedSession = z.infer<typeof savedSessionSchema>;

export const overviewSchema = z.object({
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  retrievedAt: z.iso.datetime(),
});

export type Overview = z.infer<typeof overviewSchema>;

export const sessionStatusSchema = z.object({
  authenticated: z.boolean(),
  nextStep: z.string().optional(),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export async function readSession(path = sessionPath()): Promise<SavedSession> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new InfoMentorError('LOGIN_REQUIRED', LOGIN_REQUIRED);
    }

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
      'Invalid or unsupported session file. Sign in again to create a new one.',
    );
  }
}

export async function captureSession(context: BrowserContext, url: string): Promise<SavedSession> {
  trustedUrl(url);
  const state: BrowserStorageState = await context.storageState({ indexedDB: true });

  return savedSessionSchema.parse({
    version: 1,
    url,
    savedAt: new Date().toISOString(),
    storageState: {
      cookies: state.cookies.filter(({ domain }) => isInfoMentorHost(domain.replace(/^\./, ''))),
      origins: state.origins.filter(({ origin }) => originSchema.safeParse(origin).success),
    },
  });
}

/** Atomic replacement preserves an existing session when login/import fails. */
export async function writeSession(session: SavedSession, path = sessionPath()): Promise<void> {
  const checked = savedSessionSchema.safeParse(session);

  if (!checked.success)
    throw new InfoMentorError('INVALID_SESSION', 'Refusing to save an invalid InfoMentor session.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';

  try {
    await writeFile(temporary, JSON.stringify(checked.data), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function validateCdpUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new InfoMentorError('INVALID_CONFIGURATION', 'Invalid remote-browser endpoint.');
  }

  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);

  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    (!loopback && !['https:', 'wss:'].includes(url.protocol)) ||
    url.username ||
    url.password
  ) {
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Use a loopback/SSH-tunnel CDP endpoint, or a trusted HTTPS/WSS endpoint.',
    );
  }

  return value;
}

export async function launchBrowser(
  options: SessionOptions = {},
  headless = true,
): Promise<Browser> {
  const cdpUrl = options.cdpUrl ?? process.env['INFOMENTOR_CDP_URL'];
  const configured = options.browser ?? process.env['INFOMENTOR_BROWSER'];
  const selection = configured ? browserChoiceSchema.safeParse(configured) : undefined;

  if (selection && !selection.success)
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Browser must be chrome, chromium, msedge, firefox, or webkit.',
    );
  const executablePath = options.executablePath ?? process.env['INFOMENTOR_EXECUTABLE_PATH'];

  if (
    executablePath &&
    (!isAbsolute(executablePath) || configured === 'firefox' || configured === 'webkit')
  ) {
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Use an absolute executable path for a Chromium-based browser. Firefox and WebKit use compatible Playwright builds.',
    );
  }

  if (cdpUrl) {
    if (executablePath || configured === 'firefox' || configured === 'webkit') {
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'CDP connects to an already-running Chromium browser. Use session import for Firefox or WebKit.',
      );
    }

    validateCdpUrl(cdpUrl);

    try {
      return await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 });
    } catch {
      throw new InfoMentorError(
        'BROWSER_UNAVAILABLE',
        'Cannot connect to the remote browser. Check the browser and its SSH tunnel or TLS endpoint.',
      );
    }
  }

  if (
    !headless &&
    process.platform === 'linux' &&
    !process.env['DISPLAY'] &&
    !process.env['WAYLAND_DISPLAY']
  ) {
    throw new InfoMentorError(
      'BROWSER_UNAVAILABLE',
      'No display is available. Use login --import FILE or login --cdp-url ENDPOINT. MCP reads run headlessly.',
    );
  }

  const candidates: BrowserChoice[] = selection?.success
    ? [selection.data]
    : executablePath
      ? ['chromium']
      : ['chrome', 'msedge', 'chromium', 'firefox', 'webkit'];

  for (const name of candidates) {
    const engine = name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium;
    const launchOptions: LaunchOptions = { headless, timeout: 30_000 };

    if (executablePath) launchOptions.executablePath = executablePath;
    else if (name === 'chrome' || name === 'msedge') launchOptions.channel = name;

    try {
      return await engine.launch(launchOptions);
    } catch {
      /* Try the next installed compatible browser. */
    }
  }

  throw new InfoMentorError(
    'BROWSER_UNAVAILABLE',
    'No usable browser found. Run infomentor-mcp install-browser, choose --browser, or supply --executable-path.',
  );
}

export type PageState = 'authenticated' | 'login' | 'loading' | 'unsupported' | 'challenge';

export const CHALLENGE_REQUIRED =
  'InfoMentor requires a browser security check. Complete it in the connected browser, or run login again. No automatic retry was made.';

export async function inspectPage(page: Page): Promise<PageState> {
  let url: URL;

  try {
    url = trustedUrl(page.url());
  } catch {
    return 'unsupported';
  }

  if (url.hostname === 'www.infomentor.is' || url.hostname === 'infomentor.is')
    return 'unsupported';
  const title = await page.title().catch(() => '');

  if (
    /just a moment|security (?:check|verification)|verify (?:that )?you are human/i.test(title) ||
    (await page
      .locator(
        '#challenge-running:visible, #challenge-stage:visible, iframe[src*="challenges.cloudflare.com"]:visible, iframe[src*="recaptcha"][title*="challenge" i]:visible',
      )
      .count())
  ) {
    return 'challenge';
  }

  if (/\/authentication\/|\/oryggi\/|\/login\b/i.test(url.pathname)) return 'login';
  let authenticated = false;

  for (const frame of page.frames()) {
    try {
      trustedUrl(frame.url());
    } catch {
      continue;
    }

    try {
      if (
        await frame
          .locator('input[type="password"]:visible, #login_ascx_txtNotandanafn:visible')
          .count()
      )
        return 'login';

      // ponytail: signed-in UI markers until an Icelandic session endpoint is verified.
      const logout = frame.locator(
        'a[href*="logout" i], a[href*="utskra" i], [onclick*="logout" i], [onclick*="utskra" i]',
      );

      const text = await frame.locator('body').innerText({ timeout: 1_000 });
      authenticated ||=
        (await logout.count()) > 0 ||
        /(?:^|\n)\s*(?:Útskrá|Skrá út|Log out|Sign out|Logga ut)\s*(?:\n|$)/i.test(text);
    } catch {
      return 'loading'; // The page/frame can navigate while login is completing.
    }
  }

  return authenticated ? 'authenticated' : 'loading';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new InfoMentorError(
      'CANCELLED',
      'Operation cancelled. The existing saved session was kept.',
    );
}

export async function pause(signal?: AbortSignal): Promise<void> {
  try {
    await delay(300, undefined, signal ? { signal } : {});
  } catch {
    throwIfAborted(signal);
  }
}

/** Loads only a saved InfoMentor URL and requires positive signed-in UI evidence. */
export async function openAuthenticatedPage(
  context: BrowserContext,
  url: string,
  signal?: AbortSignal,
  existingPage?: Page,
): Promise<Page> {
  trustedUrl(url);
  throwIfAborted(signal);
  const page = existingPage ?? (await context.newPage());

  const cancel = (): void => {
    void page.close().catch(() => {});
  };

  signal?.addEventListener('abort', cancel, { once: true });

  try {
    let response;

    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      throwIfAborted(signal);
      throw new InfoMentorError(
        'NETWORK_ERROR',
        'InfoMentor did not load. Check the network and try again.',
      );
    }

    if (response?.status() === 429) {
      const retry = response.headers()['retry-after'];

      const milliseconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : retry
            ? Date.parse(retry) - Date.now()
            : NaN;

      throw new InfoMentorError(
        'RATE_LIMITED',
        'InfoMentor is limiting requests. Wait before retrying; no automatic retry was made.',
        Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 60_000,
      );
    }

    if ((await inspectPage(page)) === 'challenge')
      throw new InfoMentorError('CHALLENGE_REQUIRED', CHALLENGE_REQUIRED);

    if (response?.status() === 401) throw new InfoMentorError('LOGIN_REQUIRED', LOGIN_REQUIRED);

    if (response?.status() === 403)
      throw new InfoMentorError(
        'ACCESS_DENIED',
        'InfoMentor denied access. Check the account in a browser before retrying.',
      );

    if (!response?.ok())
      throw new InfoMentorError('NETWORK_ERROR', 'InfoMentor returned an error. Try again later.');
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const state = await inspectPage(page);

      if (state === 'authenticated') return page;

      if (state === 'login') throw new InfoMentorError('LOGIN_REQUIRED', LOGIN_REQUIRED);

      if (state === 'challenge')
        throw new InfoMentorError('CHALLENGE_REQUIRED', CHALLENGE_REQUIRED);

      if (state === 'unsupported') break;
      await pause(signal);
    }

    throw new InfoMentorError(
      'UNEXPECTED_PAGE',
      'The page could not be confirmed as signed in. Its layout or login flow may have changed.',
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function verifySession(
  browser: Browser,
  session: SavedSession,
  signal?: AbortSignal,
): Promise<SavedSession> {
  const context = await browser.newContext({ storageState: session.storageState });

  try {
    const page = await openAuthenticatedPage(context, session.url, signal);

    return await captureSession(context, page.url());
  } finally {
    await context.close();
  }
}
