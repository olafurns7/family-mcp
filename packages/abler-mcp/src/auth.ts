import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import lockfile from 'proper-lockfile';
import { Cookie, CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

export const ORIGIN = 'https://www.abler.io';
export const AUTH_COOKIES = new Set(['id_token', 'refreshToken']);
export const sessionPath = () =>
  resolve(
    process.env.ABLER_SESSION_FILE ||
      join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'abler-mcp', 'session.json'),
  );

/** Hold across the complete read/refresh/write operation, including import and logout. */
export async function withSessionLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(path)), basename(path));
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(canonical, {
      realpath: false,
      stale: 120000,
      update: 10000,
      retries: { retries: 30, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
    });
  } catch {
    throw new Error(
      'Cannot lock the Abler session. Another request may be busy; retry shortly and check directory permissions.',
    );
  }
  try {
    return await work();
  } finally {
    await release();
  }
}

export async function removeSession(path: string): Promise<void> {
  await withSessionLock(path, () => rm(path, { force: true }));
}

const browserCookie = z.object({
  name: z.string(),
  value: z
    .string()
    .min(1)
    .max(32768)
    .regex(/^[\x21-\x7e]+$/),
  domain: z.string(),
  path: z.string().default('/'),
  expires: z.number().min(-1).max(253402300799).optional(),
  expirationDate: z.number().min(-1).max(253402300799).optional(),
  httpOnly: z.boolean().optional(),
});

export async function importCookies(input: unknown): Promise<CookieJar> {
  const list: unknown[] = Array.isArray(input)
    ? input
    : z.object({ cookies: z.array(z.unknown()) }).parse(input).cookies;
  const jar = new CookieJar();
  for (const item of list) {
    // Ignore unrelated browser cookies, including analytics and other sites.
    if (
      !item ||
      typeof item !== 'object' ||
      !('name' in item) ||
      !AUTH_COOKIES.has(String(item.name))
    )
      continue;
    const parsed = browserCookie.safeParse(item);
    if (!parsed.success) throw new Error('Invalid Abler authentication cookie.');
    const c = parsed.data;
    if (!['abler.io', 'www.abler.io'].includes(c.domain.replace(/^\./, ''))) continue;
    if (/[;\s]/.test(c.value) || !/^\/[^;\r\n]*$/.test(c.path))
      throw new Error('Invalid Abler authentication cookie.');
    const expires = c.expires ?? c.expirationDate ?? -1;
    // Narrow imported cookies to Abler's HTTPS API host, regardless of browser flags.
    await jar.setCookie(
      new Cookie({
        key: c.name,
        value: c.value,
        path: c.path,
        secure: true,
        httpOnly: true,
        expires: expires >= 0 ? new Date(expires * 1000) : 'Infinity',
      }),
      ORIGIN,
    );
  }
  if (!(await jar.getCookies(`${ORIGIN}/oauth/token`)).some((c) => c.key === 'refreshToken')) {
    throw new Error(
      'No unexpired Abler refreshToken cookie found. Sign in again and capture/import the session.',
    );
  }
  return jar;
}

export async function loadSession(path: string): Promise<CookieJar> {
  let raw: string;
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || (process.platform !== 'win32' && info.mode & 0o077)) {
        throw new Error('Unsafe permissions');
      }
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'No saved Abler session. Run abler-mcp auth capture or abler-mcp auth import first.',
      );
    }
    throw new Error(
      'Cannot read the Abler session file. Use a regular file with owner-only permissions (chmod 600 on Unix), not a symlink.',
    );
  }
  try {
    return await importCookies(JSON.parse(raw));
  } catch {
    throw new Error('Invalid or expired Abler session file. Capture/import a fresh session.');
  }
}

export async function saveSession(path: string, jar: CookieJar): Promise<void> {
  const cookies = (await jar.serialize()).cookies
    .filter((c) => AUTH_COOKIES.has(c.key ?? ''))
    .map((c) => {
      const cookie = Cookie.fromJSON(c);
      if (!cookie) throw new Error('Cannot serialize the Abler session cookie.');
      const expires = cookie.expiryTime();
      return {
        name: c.key,
        value: c.value,
        domain: 'www.abler.io',
        path: c.path,
        expires:
          expires === -Infinity
            ? 0
            : typeof expires === 'number' && Number.isFinite(expires)
              ? expires / 1000
              : -1,
        httpOnly: true,
        secure: true,
      };
    });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, cookies }) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Attach to an existing Chromium page; the server itself never needs a browser. */
export async function captureCookies(endpoint: string): Promise<CookieJar> {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Use a loopback Chrome debugging URL, such as http://127.0.0.1:9222.');
  }
  const response = await fetch(new URL('/json/list', url), {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Cannot list Chrome debugging tabs.');
  const pages = z
    .array(
      z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() }),
    )
    .parse(await response.json());
  const page = pages.find(
    (p) => p.type === 'page' && p.url.startsWith(`${ORIGIN}/`) && p.webSocketDebuggerUrl,
  );
  if (!page?.webSocketDebuggerUrl)
    throw new Error('Open www.abler.io and sign in in that browser first.');
  const socketUrl = new URL(page.webSocketDebuggerUrl);
  if (
    socketUrl.protocol !== 'ws:' ||
    socketUrl.host !== url.host ||
    socketUrl.username ||
    socketUrl.password
  ) {
    throw new Error('Chrome returned an unexpected debugging address.');
  }
  const result = await new Promise<unknown>((accept, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => finish(new Error('Chrome session capture timed out.')), 10000);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      if (error) reject(error);
      else accept(value);
      socket.close();
    };
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Network.getCookies',
          params: { urls: [`${ORIGIN}/oauth/token`, `${ORIGIN}/graphql`] },
        }),
      ),
    );
    socket.addEventListener('message', (event) => {
      try {
        const message = z
          .object({
            id: z.number().optional(),
            error: z.unknown().optional(),
            result: z.unknown().optional(),
          })
          .parse(JSON.parse(String(event.data)));
        if (message.id === 1)
          finish(
            message.error ? new Error('Chrome rejected session capture.') : undefined,
            message.result,
          );
      } catch {
        finish(new Error('Invalid Chrome debugging response.'));
      }
    });
    socket.addEventListener('error', () =>
      finish(new Error('Cannot connect to Chrome debugging.')),
    );
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('Chrome debugging connection closed.'));
    });
  });
  return importCookies(result);
}
