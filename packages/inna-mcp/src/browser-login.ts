import { constants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SafeError } from '@family-mcp/mcp-runtime';
import type { CookieJar } from 'tough-cookie';
import { z } from 'zod';

import { cookieExportSchema, cookieNames, ORIGIN, sessionJar } from './client.js';

type BrowserLoginResult = { jar: CookieJar; token?: string };

const macBrowsers = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const linuxBrowsers = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'brave-browser',
  'microsoft-edge',
];

const PROFILE_PREFIX = 'inna-login-';

const START_URL = 'https://r.inna.is/auth/google';

const STUDENTS_PATH = '/Components/Students/Students.html';

const ABANDONED_PROFILE_AGE_MS = 60 * 60 * 1000;

const DEBUG_READY_TIMEOUT_MS = 15_000;

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

const PROCESS_TERM_TIMEOUT_MS = 5_000;

const CDP_COMMAND_TIMEOUT_MS = 10_000;

const POLL_INTERVAL_MS = 100;

type Exists = (path: string) => Promise<boolean>;

type PathLookup = (command: string) => Promise<string | undefined>;

type BrowserDebugging = {
  connection: CdpPipe;
  owned: boolean;
};

type PendingRequest = {
  abort: () => void;
  reject: (error: Error) => void;
  resolve: (value: CdpValue | undefined) => void;
  signal: AbortSignal | undefined;
  timer: ReturnType<typeof setTimeout>;
};

type CdpMethod =
  | 'Browser.close'
  | 'Browser.getVersion'
  | 'Network.getCookies'
  | 'Target.attachToTarget'
  | 'Target.getTargets';

type CdpParams = { urls: string[] } | { targetId: string; flatten: true };

type CdpCommand = {
  id: number;
  method: CdpMethod;
  params?: CdpParams;
  sessionId?: string;
};

const jsonValueSchema = z.json();

const cdpEnvelopeSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: jsonValueSchema.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  result: jsonValueSchema.optional(),
});

type CdpValue = z.infer<typeof jsonValueSchema>;

const versionSchema = z.object({ product: z.string().min(1) });

const browserCookieSchema = z.looseObject({
  name: z.string(),
  value: z.string().optional(),
  domain: z.string(),
  path: z.string(),
});

function isStudentsPage(value: string): boolean {
  if (!URL.canParse(value)) return false;

  const url = new URL(value);

  return url.origin === ORIGIN && url.pathname === STUDENTS_PATH;
}

class CdpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class CdpPipe {
  private readonly input;
  private readonly output;
  private readonly closeWaiters = new Set<() => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private closed = false;
  private closedByPeer = false;
  private nextId = 0;
  private sessionId: string | undefined;
  private targetId: string | undefined;

  constructor(inputFd: number, outputFd: number) {
    this.input = connect({ fd: inputFd, port: 0 });
    this.output = connect({ fd: outputFd, port: 0 });

    this.output.on('data', (chunk) => this.receive(chunk.toString()));
    this.output.on('close', () => this.markClosed(true));
    this.output.on('end', () => this.markClosed(true));
    this.output.on('error', () => this.markClosed());
    this.input.on('close', () => this.markClosed());
    this.input.on('error', () => this.markClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isClosedByPeer(): boolean {
    return this.closedByPeer;
  }

  // Undefined until a tab shows the Inna student application: cookies alone do not prove sign-in.
  async captureCookies(signal: AbortSignal): Promise<BrowserLoginResult | undefined> {
    const targetResult = z
      .object({
        targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
      })
      .parse(await this.request('Target.getTargets', undefined, signal));

    const page = targetResult.targetInfos.find(
      (target) => target.type === 'page' && isStudentsPage(target.url),
    );

    if (!page) return undefined;

    if (!this.sessionId || this.targetId !== page.targetId) {
      this.sessionId = z
        .object({ sessionId: z.string() })
        .parse(
          await this.request(
            'Target.attachToTarget',
            { targetId: page.targetId, flatten: true },
            signal,
          ),
        ).sessionId;
      this.targetId = page.targetId;
    }

    let value: CdpValue;

    try {
      value = await this.request('Network.getCookies', { urls: [`${ORIGIN}/`] }, signal, this.sessionId);
    } catch (error) {
      if (
        error instanceof CdpProtocolError &&
        (error.code === -32001 ||
          /(?:session.*(?:not found|does not exist)|no session)/i.test(error.message))
      )
        this.sessionId = undefined;

      throw error;
    }

    const result = z.object({ cookies: z.array(browserCookieSchema) }).parse(value);

    const jar = await sessionJar(
      cookieExportSchema.parse(
        result.cookies.filter(
          (cookie) =>
            cookieNames.has(cookie.name) &&
            cookie.domain.replace(/^\./, '') === 'nam.inna.is' &&
            cookie.path === '/',
        ),
      ),
    );

    let tokenCookie: typeof result.cookies[number] | undefined;

    try {
      const tokenValue = await this.request(
        'Network.getCookies',
        { urls: ['https://inna.is/'] },
        signal,
        this.sessionId,
      );
      const tokenResult = z.object({ cookies: z.array(browserCookieSchema) }).parse(tokenValue);
      tokenCookie = tokenResult.cookies.find(
        (cookie) =>
          cookie.name === 'id_token' &&
          cookie.domain.replace(/^\./, '') === 'inna.is' &&
          cookie.path === '/',
      );
    } catch {
      // Token capture failed, continue without token
    }

    const loginResult: BrowserLoginResult = { jar };

    if (tokenCookie?.value) loginResult.token = tokenCookie.value;

    return loginResult;
  }

  async waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return true;

    return new Promise((resolve) => {
      const finish = (closed: boolean) => {
        clearTimeout(timer);
        this.closeWaiters.delete(onClose);
        resolve(closed);
      };

      const onClose = () => finish(true);
      this.closeWaiters.add(onClose);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  request(
    method: CdpMethod,
    params?: CdpParams,
    signal?: AbortSignal,
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<CdpValue> {
    if (this.closed) return Promise.reject(new SafeError('Chrome debugging connection closed.'));

    if (signal?.aborted)
      return Promise.reject(new SafeError('Chrome session capture was cancelled.'));

    const id = ++this.nextId;
    const command: CdpCommand = { id, method };

    if (params) command.params = params;

    if (sessionId) command.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const abort = () => this.finish(id, new SafeError('Chrome session capture was cancelled.'));

      const timer = setTimeout(
        () => this.finish(id, new SafeError('Chrome debugging request timed out.')),
        timeoutMs,
      );

      this.pending.set(id, {
        abort,
        reject,
        resolve: (value) => {
          if (value === undefined) reject(new SafeError('Invalid Chrome debugging response.'));
          else resolve(value);
        },
        signal,
        timer,
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.input.write(`${JSON.stringify(command)}\0`, (error) => {
        if (error) this.finish(id, new SafeError('Cannot communicate with Chrome debugging.'));
      });
    });
  }

  closeBrowser(): void {
    this.input.write(`${JSON.stringify({ id: ++this.nextId, method: 'Browser.close' })}\0`);
  }

  close(): void {
    this.input.destroy();
    this.output.destroy();
    this.markClosed();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;

    let end = this.buffer.indexOf('\0');

    while (end >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);

      let parsed;

      try {
        parsed = cdpEnvelopeSchema.safeParse(JSON.parse(raw));
      } catch {
        this.rejectPending(new SafeError('Invalid Chrome debugging response.'));
        this.close();

        return;
      }

      if (!parsed.success) {
        this.rejectPending(new SafeError('Invalid Chrome debugging response.'));
        this.close();

        return;
      }

      const { id, error, result, method, params } = parsed.data;

      if (id === undefined && method === 'Target.detachedFromTarget' && params !== undefined) {
        const detached = z.object({ sessionId: z.string() }).safeParse(params);

        if (detached.success && detached.data.sessionId === this.sessionId)
          this.sessionId = undefined;
      }

      if (id !== undefined)
        this.finish(
          id,
          error === undefined ? undefined : new CdpProtocolError(error.code, error.message),
          result,
        );

      end = this.buffer.indexOf('\0');
    }
  }

  private finish(id: number, error?: Error, value?: CdpValue): void {
    const pending = this.pending.get(id);

    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abort);

    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private rejectPending(error: Error): void {
    for (const id of this.pending.keys()) this.finish(id, error);
  }

  private markClosed(byPeer = false): void {
    if (byPeer) this.closedByPeer = true;

    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new SafeError('Chrome debugging connection closed.'));

    for (const resolve of this.closeWaiters) resolve();
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

async function findOnPath(command: string, exists: Exists): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory || '.', command);

    if (await exists(candidate)) return candidate;
  }

  return undefined;
}

export async function findBrowser(
  override = process.env.INNA_BROWSER,
  platform = process.platform,
  exists: Exists = isExecutable,
  pathLookup: PathLookup = (command) => findOnPath(command, exists),
): Promise<string> {
  if (override) {
    if (await exists(override)) return override;
  } else if (platform === 'darwin') {
    for (const path of macBrowsers) if (await exists(path)) return path;
  } else if (platform === 'linux') {
    for (const command of linuxBrowsers) {
      const path = await pathLookup(command);

      if (path) return path;
    }
  }

  throw new SafeError(
    'Google sign-in requires Google Chrome or Chromium, and none was found. Install one, or give its executable with --browser or INNA_BROWSER. Electronic ID (`inna-mcp auth login`) needs no browser.',
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SafeError('Inna login cancelled.');
}

function browserExited(browser: Bun.Subprocess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function processGroupIsRunning(pid: number): boolean {
  if (process.platform === 'win32') return processIsRunning(pid);

  try {
    process.kill(-pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function browserProcessesAreGone(browser: Bun.Subprocess): boolean {
  return (
    browserExited(browser) && (process.platform === 'win32' || !processGroupIsRunning(browser.pid))
  );
}

async function profileHasLiveBrowser(profile: string): Promise<boolean> {
  try {
    const owner = (await readlink(join(profile, 'SingletonLock'))).split('-').at(-1);

    if (!owner || !/^\d+$/.test(owner)) return false;

    const pid = Number(owner);

    if (!Number.isSafeInteger(pid) || pid < 1) return false;

    // ponytail: PID reuse can preserve a stale profile; inspect process command lines if that matters.
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function sweepAbandonedProfiles(): Promise<void> {
  const cutoff = Date.now() - ABANDONED_PROFILE_AGE_MS;
  const currentUid = process.getuid?.();

  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.name.startsWith(PROFILE_PREFIX) || !entry.isDirectory()) continue;

    const profile = join(tmpdir(), entry.name);
    let metadata;

    try {
      metadata = await lstat(profile);
    } catch {
      continue;
    }

    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.mtimeMs > cutoff ||
      (currentUid !== undefined && metadata.uid !== currentUid) ||
      (await profileHasLiveBrowser(profile))
    )
      continue;

    await rm(profile, { recursive: true, force: true });
  }
}

async function waitForPipeDebugging(connection: CdpPipe, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + DEBUG_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    if (connection.isClosed) throw new SafeError('The browser exited before debugging started.');

    try {
      const version = versionSchema.safeParse(
        await connection.request('Browser.getVersion', undefined, signal, undefined, 1000),
      );

      if (version.success) return;
      throw new SafeError('Invalid Chrome debugging response.');
    } catch (error) {
      throwIfCancelled(signal);

      if (error instanceof SafeError && error.message === 'Invalid Chrome debugging response.')
        throw error;
    }

    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }

  throw new SafeError('Timed out waiting for browser debugging to start.');
}

async function waitForCookies(
  debugging: BrowserDebugging,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<BrowserLoginResult> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    if (debugging.connection.isClosed)
      throw new SafeError(
        'The browser was closed before Inna sign-in finished. Nothing was saved.',
      );

    try {
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
      ]);

      const result = await debugging.connection.captureCookies(attemptSignal);

      if (!result) continue;
      const cookies = await result.jar.getCookies(`${ORIGIN}/`);

      if (
        cookies.some((cookie) => cookie.key === 'SESSION') &&
        cookies.some((cookie) => cookie.key === 'XSRF-TOKEN')
      )
        return result;
    } catch {
      throwIfCancelled(signal);
    }

    const remaining = deadline - Date.now();

    if (remaining > 0) await delay(Math.min(2000, remaining), undefined, { signal });
  }

  throw new SafeError(
    'Inna sign-in was not finished in time, and nothing was saved. Run the command again, or use electronic ID (`inna-mcp auth login`) or `inna-mcp auth import`.',
  );
}

function closeDebugging(debugging: BrowserDebugging | undefined): void {
  debugging?.connection.close();
}

function sendBrowserClose(debugging: BrowserDebugging): void {
  debugging.connection.closeBrowser();
}

async function debuggingIsGone(
  browser: Bun.Subprocess,
  debugging: BrowserDebugging | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (browserProcessesAreGone(browser)) {
      if (!debugging?.owned) return true;

      if (debugging.connection.isClosedByPeer) return true;
    }

    if (Date.now() >= deadline) return false;

    await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
  }
}

async function waitForBrowserExit(browser: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (!browserProcessesAreGone(browser) && Date.now() < deadline)
    await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));

  return browserProcessesAreGone(browser);
}

function signalBrowserTree(browser: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  let groupSignalled = false;

  if (process.platform !== 'win32') {
    try {
      process.kill(-browser.pid, signal);
      groupSignalled = true;
    } catch {
      // The process group may already have exited.
    }
  }

  if (!groupSignalled && !browserExited(browser)) {
    try {
      browser.kill(signal);
    } catch {
      // The spawned process may have exited between the check and signal.
    }
  }
}

async function terminateSpawnedBrowser(browser: Bun.Subprocess): Promise<boolean> {
  if (await waitForBrowserExit(browser, 0)) return true;

  signalBrowserTree(browser, 'SIGTERM');

  if (await waitForBrowserExit(browser, PROCESS_TERM_TIMEOUT_MS)) return true;

  signalBrowserTree(browser, 'SIGKILL');

  return waitForBrowserExit(browser, PROCESS_TERM_TIMEOUT_MS);
}

async function closeBrowser(
  browser: Bun.Subprocess,
  debugging: BrowserDebugging | undefined,
): Promise<boolean> {
  try {
    if (debugging?.owned) {
      sendBrowserClose(debugging);

      if (await debuggingIsGone(browser, debugging, BROWSER_CLOSE_TIMEOUT_MS)) return true;
    }

    if (!(await terminateSpawnedBrowser(browser))) return false;

    return await debuggingIsGone(browser, debugging, BROWSER_CLOSE_TIMEOUT_MS);
  } finally {
    closeDebugging(debugging);
  }
}

function spawnBrowser(browserPath: string, profile: string): Bun.Subprocess {
  const args = [
    browserPath,
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    START_URL,
  ];

  try {
    return Bun.spawn(args, {
      stdio: ['ignore', 'ignore', 'ignore', 'socket-fd', 'socket-fd'],
      detached: process.platform !== 'win32',
    });
  } catch {
    throw new SafeError('Could not start the selected browser.');
  }
}

function pipeConnection(browser: Bun.Subprocess): CdpPipe {
  const inputFd = browser.stdio[3];
  const outputFd = browser.stdio[4];

  if (inputFd === null || inputFd === undefined || outputFd === null || outputFd === undefined)
    throw new SafeError('This Bun runtime cannot create a private Chrome debugging pipe.');

  return new CdpPipe(inputFd, outputFd);
}

export function requireDisplay(platform = process.platform, env = process.env): void {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    throw new SafeError(
      'Google sign-in opens a browser window and needs a desktop session, which this machine does not have. Electronic ID (`inna-mcp auth login`) works without one.',
    );
}

export async function loginInBrowser(
  options: { browser?: string | undefined; timeoutSeconds: number },
  platform = process.platform,
  env = process.env,
): Promise<BrowserLoginResult> {
  const { browser: override, timeoutSeconds } = options;

  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)
    throw new SafeError('Provide a positive whole number for --timeout.');

  requireDisplay(platform, env);

  const controller = new AbortController();
  const cancel = () => controller.abort();
  let profile: string | undefined;
  let browser: Bun.Subprocess | undefined;
  let debugging: BrowserDebugging | undefined;
  let result: BrowserLoginResult | undefined;
  let loginError: Error | undefined;
  let cleanupError: Error | undefined;
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    await sweepAbandonedProfiles();
    throwIfCancelled(controller.signal);
    const browserPath = await findBrowser(override);
    throwIfCancelled(controller.signal);
    profile = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    await chmod(profile, 0o700);

    try {
      process.stderr.write(
        'A browser window is opening. Sign in to Inna with your Google account there; this window closes by itself when you are done.\n',
      );
      browser = spawnBrowser(browserPath, profile);
      const connection = pipeConnection(browser);
      debugging = { connection, owned: false };
      await waitForPipeDebugging(connection, controller.signal);
      debugging.owned = true;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new SafeError(
        'Could not establish a private Chrome debugging pipe. Select Google Chrome or Chromium with `--browser`, or use electronic ID (`inna-mcp auth login`) or `inna-mcp auth import`.',
      );
    }

    result = await waitForCookies(debugging, timeoutSeconds, controller.signal);
  } catch (error) {
    loginError = controller.signal.aborted
      ? new SafeError('Inna login cancelled.')
      : error instanceof Error
        ? error
        : new Error(String(error));
  }

  try {
    if (profile && browser) {
      if (!(await closeBrowser(browser, debugging)))
        cleanupError = new SafeError(
          'A browser process may still be running; its temporary profile was removed.',
        );
    } else closeDebugging(debugging);
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    if (profile) await rm(profile, { recursive: true, force: true });
  } catch {
    cleanupError = new SafeError('Could not remove the temporary browser profile.');
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }

  if (cleanupError) throw cleanupError;

  if (controller.signal.aborted) throw new SafeError('Inna login cancelled.');

  if (loginError) throw loginError;

  if (!result) throw new SafeError('Inna sign-in did not capture a complete session.');

  return result;
}
