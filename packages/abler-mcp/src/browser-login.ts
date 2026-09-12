import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

import { captureCookies, importCookies, ORIGIN } from './auth.js';

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

const LOOPBACK = '127.0.0.1';

const PROFILE_PREFIX = 'abler-login-';

const ABANDONED_PROFILE_AGE_MS = 60 * 60 * 1000;

const DEBUG_READY_TIMEOUT_MS = 15_000;

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

const PROCESS_TERM_TIMEOUT_MS = 5_000;

const CDP_COMMAND_TIMEOUT_MS = 10_000;

const POLL_INTERVAL_MS = 100;

type Exists = (path: string) => Promise<boolean>;

type PathLookup = (command: string) => Promise<string | undefined>;

type DebugEndpoint = {
  activePortFile: string;
  httpUrl: string;
  webSocketUrl: string;
};

type PortDebugging = {
  kind: 'port';
  endpoint: DebugEndpoint;
  socket: WebSocket;
};

type PipeDebugging = {
  kind: 'pipe';
  connection: CdpPipe;
};

type BrowserDebugging = PortDebugging | PipeDebugging;

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
  error: jsonValueSchema.optional(),
  result: jsonValueSchema.optional(),
});

type CdpValue = z.infer<typeof jsonValueSchema>;

const versionSchema = z.object({ product: z.string().min(1) });

class CdpPipe {
  private readonly input;
  private readonly output;
  private readonly closeWaiters = new Set<() => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private closed = false;
  private nextId = 0;
  private sessionId: string | undefined;

  constructor(inputFd: number, outputFd: number) {
    this.input = connect({ fd: inputFd, port: 0 });
    this.output = connect({ fd: outputFd, port: 0 });

    this.output.on('data', (chunk) => this.receive(chunk.toString()));
    this.output.on('close', () => this.markClosed());
    this.output.on('end', () => this.markClosed());
    this.output.on('error', () => this.markClosed());
    this.input.on('close', () => this.markClosed());
    this.input.on('error', () => this.markClosed());
  }

  get isClosed(): boolean {
    return this.closed;
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

    const result = z
      .object({ cookies: z.array(jsonValueSchema) })
      .parse(
        await this.request(
          'Network.getCookies',
          { urls: [`${ORIGIN}/oauth/token`, `${ORIGIN}/graphql`] },
          signal,
          this.sessionId,
        ),
      );

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

      const { id, error, result } = parsed.data;

      if (id !== undefined)
        this.finish(
          id,
          error === undefined ? undefined : new Error('Chrome rejected a debugging command.'),
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

  private markClosed(): void {
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

function hasBunPipeSupport(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);

  return major > 1 || (major === 1 && minor >= 4);
}

async function readDebugEndpoint(profile: string): Promise<DebugEndpoint | undefined> {
  const activePortFile = join(profile, 'DevToolsActivePort');
  let metadata;

  try {
    metadata = await lstat(activePortFile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }

  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Invalid Chrome debugging endpoint.');

  const contents = await readFile(activePortFile, 'utf8');
  const [portText, webSocketPath, extra] = contents.trimEnd().split(/\r?\n/);

  if (portText === undefined || webSocketPath === undefined || extra !== undefined)
    return undefined;

  if (!/^\d{1,5}$/.test(portText) || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(webSocketPath))
    throw new Error('Invalid Chrome debugging endpoint.');

  const port = Number(portText);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid Chrome debugging endpoint.');

  return {
    activePortFile,
    httpUrl: `http://${LOOPBACK}:${port}`,
    webSocketUrl: `ws://${LOOPBACK}:${port}${webSocketPath}`,
  };
}

async function endpointResponds(endpoint: DebugEndpoint): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.httpUrl}/json/version`, {
      redirect: 'error',
      signal: AbortSignal.timeout(250),
    });

    await response.body?.cancel();

    return true;
  } catch {
    return false;
  }
}

async function portBrowserIsGone(endpoint: DebugEndpoint, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let fileExists = true;

    try {
      await lstat(endpoint.activePortFile);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fileExists = false;
    }

    if (!fileExists && !(await endpointResponds(endpoint))) return true;
    await delay(POLL_INTERVAL_MS);
  }

  return false;
}

async function profileHasLiveBrowser(profile: string): Promise<boolean> {
  try {
    const endpoint = await readDebugEndpoint(profile);

    if (endpoint && (await endpointResponds(endpoint))) return true;
  } catch {
    // Pipe-based Chromium profiles use SingletonLock instead of DevToolsActivePort.
  }

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

async function waitForSocketOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Abler login cancelled.');

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(
      () => finish(new Error('Chrome debugging connection timed out.')),
      1000,
    );

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', error);
      socket.removeEventListener('close', close);
    };

    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (failure) reject(failure);
      else resolve();
    };

    const open = () => finish();
    const error = () => finish(new Error('Cannot connect to Chrome debugging.'));
    const close = () => finish(new Error('Chrome debugging connection closed.'));
    const abort = () => finish(new Error('Abler login cancelled.'));

    socket.addEventListener('open', open);
    socket.addEventListener('error', error);
    socket.addEventListener('close', close);
    signal.addEventListener('abort', abort, { once: true });

    if (socket.readyState === WebSocket.OPEN) finish();
  });
}

async function webSocketRequest(
  socket: WebSocket,
  id: number,
  method: 'Browser.close' | 'Browser.getVersion',
  signal: AbortSignal,
  timeoutMs = 1000,
): Promise<CdpValue> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(
      () => finish(new Error('Chrome debugging request timed out.')),
      timeoutMs,
    );

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.removeEventListener('message', message);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', closed);
    };

    const finish = (failure?: Error, value?: CdpValue) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (failure) reject(failure);
      else if (value === undefined) reject(new Error('Invalid Chrome debugging response.'));
      else resolve(value);
    };

    const message = (event: MessageEvent) => {
      let response;

      try {
        response = cdpEnvelopeSchema.parse(JSON.parse(String(event.data)));
      } catch {
        finish(new Error('Invalid Chrome debugging response.'));

        return;
      }

      if (response.id !== id) return;

      if (response.result === undefined) {
        finish(new Error('Invalid Chrome debugging response.'));

        return;
      }

      finish(
        response.error === undefined
          ? undefined
          : new Error('Chrome rejected a debugging command.'),
        response.result,
      );
    };

    const failed = () => finish(new Error('Chrome debugging connection failed.'));
    const closed = () => finish(new Error('Chrome debugging connection closed.'));
    const abort = () => finish(new Error('Abler login cancelled.'));

    socket.addEventListener('message', message);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', closed);
    signal.addEventListener('abort', abort, { once: true });

    if (socket.readyState !== WebSocket.OPEN) {
      finish(new Error('Chrome debugging connection closed.'));

      return;
    }

    try {
      socket.send(JSON.stringify({ id, method }));
    } catch {
      finish(new Error('Cannot communicate with Chrome debugging.'));
    }
  });
}

async function waitForPortDebugging(
  profile: string,
  browser: Bun.Subprocess,
  signal: AbortSignal,
  retain: (debugging: PortDebugging) => void,
): Promise<PortDebugging> {
  const deadline = Date.now() + DEBUG_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    const endpoint = await readDebugEndpoint(profile);

    if (endpoint) {
      const socket = new WebSocket(endpoint.webSocketUrl);
      const debugging = { kind: 'port' as const, endpoint, socket };
      let invalidResponse = false;
      retain(debugging);

      try {
        await waitForSocketOpen(socket, signal);

        const version = versionSchema.safeParse(
          await webSocketRequest(socket, 1, 'Browser.getVersion', signal),
        );

        if (!version.success) {
          invalidResponse = true;
          throw new Error('Invalid Chrome debugging response.');
        }

        return debugging;
      } catch (error) {
        if (invalidResponse) throw error;

        throwIfCancelled(signal);

        if (socket.readyState === WebSocket.OPEN) throw error;

        await closeSocket(socket);
      }
    }

    if (browser.exitCode !== null && browser.exitCode !== 0)
      throw new Error('The browser exited before debugging started.');

    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }

  throw new Error('Timed out waiting for browser debugging to start.');
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

    if (
      (debugging.kind === 'pipe' && debugging.connection.isClosed) ||
      (debugging.kind === 'port' && !(await endpointResponds(debugging.endpoint)))
    )
      throw new Error('The browser closed before Abler sign-in completed.');

    try {
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
      ]);

      const jar =
        debugging.kind === 'pipe'
          ? await debugging.connection.captureCookies(attemptSignal)
          : await captureCookies(debugging.endpoint.httpUrl, attemptSignal);

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

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('close', finish);
      resolve();
    };

    const timer = setTimeout(finish, 250);

    socket.addEventListener('close', finish);

    try {
      socket.close();
    } catch {
      finish();
    }
  });
}

async function closeDebugging(debugging: BrowserDebugging | undefined): Promise<void> {
  if (!debugging) return;

  if (debugging.kind === 'pipe') debugging.connection.close();
  else await closeSocket(debugging.socket);
}

async function sendBrowserClose(debugging: BrowserDebugging): Promise<void> {
  if (debugging.kind === 'pipe') {
    debugging.connection.closeBrowser();

    return;
  }

  try {
    await webSocketRequest(debugging.socket, 2, 'Browser.close', new AbortController().signal);
  } catch {
    // Chromium may close the owned CDP channel before replying to Browser.close.
  }
}

async function debuggingIsGone(
  browser: Bun.Subprocess,
  debugging: BrowserDebugging | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!debugging) return waitForProcessExit(browser, timeoutMs);

  if (debugging.kind === 'port') return portBrowserIsGone(debugging.endpoint, timeoutMs);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (debugging.connection.isClosed && browserExited(browser)) return true;
    await delay(POLL_INTERVAL_MS);
  }

  return debugging.connection.isClosed && browserExited(browser);
}

async function waitForProcessExit(browser: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  if (browserExited(browser)) {
    await browser.exited;

    return true;
  }

  const timeout = new AbortController();

  try {
    return await Promise.race([
      browser.exited.then(
        () => true,
        () => false,
      ),
      delay(timeoutMs, false, { signal: timeout.signal }),
    ]);
  } finally {
    timeout.abort();
  }
}

async function terminateSpawnedBrowser(browser: Bun.Subprocess): Promise<boolean> {
  if (await waitForProcessExit(browser, 0)) return true;

  try {
    browser.kill('SIGTERM');
  } catch {
    return waitForProcessExit(browser, PROCESS_TERM_TIMEOUT_MS);
  }

  if (await waitForProcessExit(browser, PROCESS_TERM_TIMEOUT_MS)) return true;

  try {
    browser.kill('SIGKILL');
  } catch {
    return waitForProcessExit(browser, PROCESS_TERM_TIMEOUT_MS);
  }

  return waitForProcessExit(browser, PROCESS_TERM_TIMEOUT_MS);
}

async function closeBrowser(
  browser: Bun.Subprocess,
  debugging: BrowserDebugging | undefined,
): Promise<boolean> {
  try {
    if (debugging) {
      await sendBrowserClose(debugging);

      if (await debuggingIsGone(browser, debugging, BROWSER_CLOSE_TIMEOUT_MS)) {
        if (await terminateSpawnedBrowser(browser)) return true;
      }
    }

    if (!(await terminateSpawnedBrowser(browser))) return false;

    return debuggingIsGone(browser, debugging, BROWSER_CLOSE_TIMEOUT_MS);
  } finally {
    await closeDebugging(debugging);
  }
}

function spawnBrowser(browserPath: string, profile: string, usePipe: boolean): Bun.Subprocess {
  const args = [
    browserPath,
    `--user-data-dir=${profile}`,
    `--remote-debugging-address=${LOOPBACK}`,
    ...(usePipe ? ['--remote-debugging-pipe'] : ['--remote-debugging-port=0']),
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'https://www.abler.io/sign-on/login',
  ];

  try {
    return Bun.spawn(args, {
      stdio: usePipe
        ? ['ignore', 'ignore', 'ignore', 'socket-fd', 'socket-fd']
        : ['ignore', 'ignore', 'ignore'],
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

    let usePipe = !keepBrowser && hasBunPipeSupport(Bun.version);

    try {
      browser = spawnBrowser(browserPath, profile, usePipe);
    } catch (error) {
      if (!usePipe) throw error;

      usePipe = false;
      browser = spawnBrowser(browserPath, profile, false);
    }

    if (usePipe) {
      const connection = pipeConnection(browser);
      debugging = { kind: 'pipe', connection };
      await waitForPipeDebugging(connection, controller.signal);
    } else
      debugging = await waitForPortDebugging(profile, browser, controller.signal, (candidate) => {
        debugging = candidate;
      });

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
    if (profile && browser && keepBrowser) {
      browser.unref();
      await closeDebugging(debugging);
      process.stderr.write(
        'Keeping the browser open; its temporary profile contains live Abler credentials.\n',
      );
      keepProfile = true;
    } else if (profile && browser) {
      if (!(await closeBrowser(browser, debugging)))
        cleanupError = new Error(
          'A browser process may still be running; its temporary profile was removed.',
        );
    } else await closeDebugging(debugging);
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
