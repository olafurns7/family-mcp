import { constants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

import { importCookies, ORIGIN } from './auth.js';

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

const PROFILE_PREFIX = 'abler-login-';

const ABANDONED_PROFILE_AGE_MS = 60 * 60 * 1000;

const DEBUG_READY_TIMEOUT_MS = 15_000;

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

const PROCESS_TERM_TIMEOUT_MS = 5_000;

const CDP_COMMAND_TIMEOUT_MS = 10_000;

const POLL_INTERVAL_MS = 100;

const PIPE_FAILURE_MESSAGE =
  'Could not establish a private Chrome debugging pipe. Use `abler-mcp auth capture` or `abler-mcp auth import`, or select a Chromium browser with `--browser`.';

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

  async captureCookies(signal: AbortSignal): Promise<CookieJar> {
    if (!this.sessionId) {
      const targetResult = z
        .object({
          targetInfos: z.array(
            z.object({ targetId: z.string(), type: z.string(), url: z.string() }),
          ),
        })
        .parse(await this.request('Target.getTargets', undefined, signal));

      const page = targetResult.targetInfos.find(
        (target) => target.type === 'page' && target.url.startsWith(`${ORIGIN}/`),
      );

      if (!page) throw new Error('Open www.abler.io and sign in in that browser first.');

      this.sessionId = z
        .object({ sessionId: z.string() })
        .parse(
          await this.request(
            'Target.attachToTarget',
            { targetId: page.targetId, flatten: true },
            signal,
          ),
        ).sessionId;
    }

    let value: CdpValue;

    try {
      value = await this.request(
        'Network.getCookies',
        { urls: [`${ORIGIN}/oauth/token`, `${ORIGIN}/graphql`] },
        signal,
        this.sessionId,
      );
    } catch (error) {
      if (
        error instanceof CdpProtocolError &&
        (error.code === -32001 ||
          /(?:session.*(?:not found|does not exist)|no session)/i.test(error.message))
      )
        this.sessionId = undefined;

      throw error;
    }

    const result = z.object({ cookies: z.array(jsonValueSchema) }).parse(value);

    return importCookies(result.cookies);
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
    if (this.closed) return Promise.reject(new Error('Chrome debugging connection closed.'));

    if (signal?.aborted) return Promise.reject(new Error('Chrome session capture was cancelled.'));

    const id = ++this.nextId;
    const command: CdpCommand = { id, method };

    if (params) command.params = params;

    if (sessionId) command.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const abort = () => this.finish(id, new Error('Chrome session capture was cancelled.'));

      const timer = setTimeout(
        () => this.finish(id, new Error('Chrome debugging request timed out.')),
        timeoutMs,
      );

      this.pending.set(id, {
        abort,
        reject,
        resolve: (value) => {
          if (value === undefined) reject(new Error('Invalid Chrome debugging response.'));
          else resolve(value);
        },
        signal,
        timer,
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.input.write(`${JSON.stringify(command)}\0`, (error) => {
        if (error) this.finish(id, new Error('Cannot communicate with Chrome debugging.'));
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
        this.rejectPending(new Error('Invalid Chrome debugging response.'));
        this.close();

        return;
      }

      if (!parsed.success) {
        this.rejectPending(new Error('Invalid Chrome debugging response.'));
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
    this.rejectPending(new Error('Chrome debugging connection closed.'));

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
  override = process.env.ABLER_BROWSER,
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

  throw new Error(
    `No Chromium-family browser found. Searched ABLER_BROWSER, macOS ${macBrowsers.join(', ')}, and Linux PATH for ${linuxBrowsers.join(', ')}. Use 'abler-mcp auth capture <URL>' or 'abler-mcp auth import <file>'.`,
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Abler login cancelled.');
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

    if (connection.isClosed) throw new Error('The browser exited before debugging started.');

    try {
      const version = versionSchema.safeParse(
        await connection.request('Browser.getVersion', undefined, signal, undefined, 1000),
      );

      if (version.success) return;
      throw new Error('Invalid Chrome debugging response.');
    } catch (error) {
      throwIfCancelled(signal);

      if (error instanceof Error && error.message === 'Invalid Chrome debugging response.')
        throw error;
    }

    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }

  throw new Error('Timed out waiting for browser debugging to start.');
}

async function waitForCookies(
  debugging: BrowserDebugging,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<CookieJar> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    if (debugging.connection.isClosed)
      throw new Error('The browser closed before Abler sign-in completed.');

    try {
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
      ]);

      const jar = await debugging.connection.captureCookies(attemptSignal);

      const [refreshCookies, accessCookies] = await Promise.all([
        jar.getCookies(`${ORIGIN}/oauth/token`),
        jar.getCookies(`${ORIGIN}/graphql`),
      ]);

      if (
        refreshCookies.some((cookie) => cookie.key === 'refreshToken') &&
        accessCookies.some((cookie) => cookie.key === 'id_token')
      )
        return jar;
    } catch {
      throwIfCancelled(signal);
    }

    const remaining = deadline - Date.now();

    if (remaining > 0) await delay(Math.min(2000, remaining), undefined, { signal });
  }

  throw new Error(
    `Abler login timed out after ${timeoutSeconds} second${timeoutSeconds === 1 ? '' : 's'}.`,
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
    'https://www.abler.io/sign-on/login',
  ];

  try {
    return Bun.spawn(args, {
      stdio: ['ignore', 'ignore', 'ignore', 'socket-fd', 'socket-fd'],
      detached: process.platform !== 'win32',
    });
  } catch {
    throw new Error('Could not start the selected browser.');
  }
}

function pipeConnection(browser: Bun.Subprocess): CdpPipe {
  const inputFd = browser.stdio[3];
  const outputFd = browser.stdio[4];

  if (inputFd === null || inputFd === undefined || outputFd === null || outputFd === undefined)
    throw new Error('This Bun runtime cannot create a private Chrome debugging pipe.');

  return new CdpPipe(inputFd, outputFd);
}

export async function loginInBrowser(options: {
  browser?: string | undefined;
  timeoutSeconds: number;
  keepBrowser?: boolean | undefined;
}): Promise<CookieJar> {
  const { browser: override, timeoutSeconds, keepBrowser = false } = options;

  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)
    throw new Error('Provide a positive whole number for --timeout.');

  const controller = new AbortController();
  const cancel = () => controller.abort();
  let profile: string | undefined;
  let browser: Bun.Subprocess | undefined;
  let debugging: BrowserDebugging | undefined;
  let result: CookieJar | undefined;
  let loginError: Error | undefined;
  let cleanupError: Error | undefined;
  let keepProfile = false;
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
      browser = spawnBrowser(browserPath, profile);
      const connection = pipeConnection(browser);
      debugging = { connection, owned: false };
      await waitForPipeDebugging(connection, controller.signal);
      debugging.owned = true;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(PIPE_FAILURE_MESSAGE, { cause: error });
    }

    process.stdout.write('Sign in to Abler in the browser window that opened.\n');
    result = await waitForCookies(debugging, timeoutSeconds, controller.signal);
  } catch (error) {
    loginError = controller.signal.aborted
      ? new Error('Abler login cancelled.')
      : error instanceof Error
        ? error
        : new Error(String(error));
  }

  try {
    if (profile && browser && keepBrowser && debugging?.owned) {
      browser.unref();
      closeDebugging(debugging);
      process.stderr.write(
        'Keeping the browser open; its temporary profile contains live Abler credentials and no debugging endpoint is left open.\n',
      );
      keepProfile = true;
    } else if (profile && browser) {
      if (!(await closeBrowser(browser, debugging)))
        cleanupError = new Error(
          'A browser process may still be running; its temporary profile was removed.',
        );
    } else closeDebugging(debugging);
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    if (profile && !keepProfile) await rm(profile, { recursive: true, force: true });
  } catch {
    cleanupError = new Error('Could not remove the temporary browser profile.');
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }

  if (cleanupError) throw cleanupError;

  if (controller.signal.aborted) throw new Error('Abler login cancelled.');

  if (loginError) throw loginError;

  if (!result) throw new Error('Abler login did not capture a complete session.');

  return result;
}
