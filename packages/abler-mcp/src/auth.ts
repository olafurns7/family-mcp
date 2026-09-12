import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  SessionStoreError,
  defaultSessionPath,
  readPrivateFile,
  sweepTemp,
  withFileLock,
  writePrivateFile,
} from '@family-mcp/session-store';
import { Cookie, CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

export const ORIGIN = 'https://www.abler.io';

export const AUTH_COOKIES = new Set(['id_token', 'refreshToken']);

/** Two cookies of at most 32 KiB each fit comfortably; anything larger is not a session file. */
export const SESSION_MAX_BYTES = 262_144;

export const sessionPath = () =>
  resolve(process.env.ABLER_SESSION_FILE || defaultSessionPath('abler-mcp'));

/** Hold across the complete read/refresh/write operation, including import and logout. */
export async function withSessionLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock(path, {}, async () => {
      // Temporaries orphaned by a hard crash hold credentials; the lock holder removes old ones.
      await sweepTemp(path);

      return work();
    });
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;

    if (error.code === 'LOCK_LOST') {
      throw new Error('Another process took over the Abler session lock. Retry the request.');
    }

    if (error.code === 'UNSAFE_FILE')
      throw new Error('The Abler session file has hard links, which are unsupported.');

    throw new Error(
      'Cannot lock the Abler session. Another request may be busy; retry shortly and check directory permissions.',
    );
  }
}

export async function removeSession(path: string): Promise<void> {
  await withSessionLock(path, () => rm(path, { force: true }));
}

/** A verified import supersedes the candidates that earlier failed imports retained. */
export async function prunePendingCandidates(path: string): Promise<number> {
  const prefix = `${basename(path)}.`;
  let removed = 0;

  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix) || !name.endsWith('.pending')) continue;
    await rm(join(dirname(path), name), { force: true });
    removed++;
  }

  return removed;
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

const cookieIdentity = z.object({ name: z.string(), domain: z.string() });

export const cookieInputSchema = z.union([
  z.array(z.unknown()),
  z.object({ cookies: z.array(z.unknown()) }),
]);

type CookieInput = z.input<typeof cookieInputSchema>;

export async function importCookies(input: CookieInput): Promise<CookieJar> {
  const parsedInput = cookieInputSchema.parse(input);
  const list = Array.isArray(parsedInput) ? parsedInput : parsedInput.cookies;

  const jar = new CookieJar();

  for (const item of list) {
    // Ignore unrelated browser cookies, including analytics and other sites.
    const identity = cookieIdentity.safeParse(item);

    if (!identity.success || !AUTH_COOKIES.has(identity.data.name)) continue;

    if (!['abler.io', 'www.abler.io'].includes(identity.data.domain.replace(/^\./, ''))) continue;

    const parsed = browserCookie.safeParse(item);

    if (!parsed.success) throw new Error('Invalid Abler authentication cookie.');
    const c = parsed.data;

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
    raw = await readPrivateFile(path, { maxBytes: SESSION_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
      throw new Error(
        'No saved Abler session. Run abler-mcp auth capture or abler-mcp auth import first.',
      );
    }

    throw new Error(
      'Cannot read the Abler session file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
    );
  }

  try {
    return await importCookies(cookieInputSchema.parse(JSON.parse(raw)));
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
      const expires = cookie.expiryTime() ?? -Infinity;

      return {
        name: c.key,
        value: c.value,
        domain: 'www.abler.io',
        path: c.path,
        expires: expires === -Infinity ? 0 : Number.isFinite(expires) ? expires / 1000 : -1,
        httpOnly: true,
        secure: true,
      };
    });

  try {
    await writePrivateFile(path, JSON.stringify({ version: 1, cookies }) + '\n');
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;
    throw new Error('Cannot save the Abler session file. Check the directory permissions.');
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

  const result = await new Promise<CookieInput>((accept, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => finish(new Error('Chrome session capture timed out.')), 10000);

    const finish = (error?: Error, value?: CookieInput) => {
      clearTimeout(timer);

      if (error) reject(error);
      else if (value) accept(value);
      else reject(new Error('Chrome returned no cookies.'));
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

        if (message.id === 1) {
          const cookieResult = cookieInputSchema.parse(message.result);
          finish(
            message.error ? new Error('Chrome rejected session capture.') : undefined,
            cookieResult,
          );
        }
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

  return importCookies(cookieInputSchema.parse(result));
}
