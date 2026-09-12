import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

import { captureCookies, ORIGIN } from './auth.js';

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

type Exists = (path: string) => Promise<boolean>;

type PathLookup = (command: string) => Promise<string | undefined>;

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

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;

  const address = z.object({ port: z.number() }).safeParse(server.address());

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  if (!address.success) throw new Error('Cannot allocate a browser port.');

  return address.data.port;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Abler login cancelled.');
}

function browserExited(browser: Bun.Subprocess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

async function waitForDebugging(port: number, browser: Bun.Subprocess, signal: AbortSignal) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    if (browserExited(browser)) throw new Error('The browser exited before debugging started.');

    try {
      const response = await fetch(endpoint, {
        redirect: 'error',
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(1000, deadline - Date.now())),
        ]),
      });

      const ready = response.ok;
      await response.body?.cancel();

      if (ready) return;
    } catch {
      throwIfCancelled(signal);
    }

    await delay(100, undefined, { signal });
  }

  throw new Error('Timed out waiting for browser debugging to start.');
}

async function waitForCookies(
  port: number,
  browser: Bun.Subprocess,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<CookieJar> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    if (browserExited(browser))
      throw new Error('The browser closed before Abler sign-in completed.');

    try {
      const jar = await captureCookies(
        endpoint,
        AbortSignal.any([signal, AbortSignal.timeout(Math.min(10_000, deadline - Date.now()))]),
      );

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

async function closeBrowser(browser: Bun.Subprocess): Promise<void> {
  if (browserExited(browser)) {
    await browser.exited;

    return;
  }

  try {
    browser.kill('SIGTERM');
  } catch {
    await browser.exited;

    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const exited = await Promise.race([
    browser.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    }),
  ]);

  if (timer) clearTimeout(timer);

  if (exited) return;

  try {
    browser.kill('SIGKILL');
  } catch {
    await browser.exited;

    return;
  }

  await browser.exited;
}

export async function loginInBrowser(options: {
  browser?: string | undefined;
  timeoutSeconds: number;
  keepBrowser?: boolean | undefined;
}): Promise<CookieJar> {
  const { browser: override, timeoutSeconds, keepBrowser = false } = options;

  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1)
    throw new Error('Provide a positive whole number for --timeout.');

  const browserPath = await findBrowser(override);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let profile: string | undefined;
  let browser: Bun.Subprocess | undefined;
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    profile = await mkdtemp(join(tmpdir(), 'abler-login-'));
    await chmod(profile, 0o700);
    const port = await freeLoopbackPort();
    throwIfCancelled(controller.signal);

    try {
      browser = Bun.spawn(
        [
          browserPath,
          `--user-data-dir=${profile}`,
          '--remote-debugging-address=127.0.0.1',
          `--remote-debugging-port=${port}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          'https://www.abler.io/sign-on/login',
        ],
        { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      );
    } catch {
      throw new Error('Could not start the selected browser.');
    }

    await waitForDebugging(port, browser, controller.signal);
    process.stdout.write('Sign in to Abler in the browser window that opened.\n');

    return await waitForCookies(port, browser, timeoutSeconds, controller.signal);
  } catch (error) {
    throwIfCancelled(controller.signal);
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);

    if (profile && browser && keepBrowser) {
      process.stderr.write(
        'Keeping the browser open; its temporary profile contains live Abler credentials.\n',
      );
    } else if (profile) {
      try {
        if (browser) await closeBrowser(browser);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
}
