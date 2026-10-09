import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import {
  defaultKeyProvider,
  defaultSecretRecordPath,
  defaultSessionPath,
  LocalKeyFileProvider,
  readPrivateFile,
  retiredStorePaths,
  SessionStoreError,
  startupCheck,
  sweepTemp,
  withFileLock,
  withSecretStore,
  writePrivateFile,
  type KeyProvider,
  type SecretRecordOptions,
  type SecretStore,
} from '@family-mcp/session-store';
import { Cookie, CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

export const ORIGIN = 'https://www.abler.io';

export const AUTH_COOKIES = new Set(['id_token', 'refreshToken']);

/** Two cookies of at most 32 KiB each fit comfortably; anything larger is not a session file. */
export const SESSION_MAX_BYTES = 262_144;

/** The pre-store plaintext session file; its `.pending` siblings are failed-import candidates. */
export const sessionPath = () =>
  resolve(process.env.ABLER_SESSION_FILE || defaultSessionPath('abler-mcp'));

/** Hold across the complete read/refresh/write operation, including import and logout. */
export async function withSessionLock<T>(
  path: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await withFileLock(path, { signal }, async () => {
      // Temporaries orphaned by a hard crash hold credentials; the lock holder removes old ones.
      await sweepTemp(path);

      return work();
    });
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;

    if (error.code === 'LOCK_LOST') {
      throw new SafeError('Another process took over the Abler session lock. Retry the request.');
    }

    if (error.code === 'UNSAFE_FILE')
      throw new SafeError('The Abler session file has hard links, which are unsupported.');

    throw new SafeError(
      'Cannot lock the Abler session. Another request may be busy; retry shortly and check directory permissions.',
    );
  }
}

async function pendingCandidates(path: string): Promise<string[]> {
  const prefix = `${basename(path)}.`;

  return (await readdir(dirname(path)))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.pending'))
    .map((name) => join(dirname(path), name));
}

/** A verified import supersedes the candidates that earlier failed imports retained. */
export async function prunePendingCandidates(path: string): Promise<number> {
  const candidates = await pendingCandidates(path);

  for (const candidate of candidates) await rm(candidate, { force: true });

  return candidates.length;
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

    if (!parsed.success) throw new SafeError('Invalid Abler authentication cookie.');
    const c = parsed.data;

    if (/[;\s]/.test(c.value) || !/^\/[^;\r\n]*$/.test(c.path))
      throw new SafeError('Invalid Abler authentication cookie.');
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
    throw new SafeError(
      'No unexpired Abler refreshToken cookie found. Sign in again and capture/import the session.',
    );
  }

  return jar;
}

const noSession = () =>
  new SafeError(
    'No saved Abler session. Run abler-mcp auth capture or abler-mcp auth import first.',
  );

const noCandidate = () =>
  new SafeError('No retained Abler session candidate. Capture or import a fresh session.');

/** The pre-store plaintext file, read with the rules it always had; undefined when missing. */
async function readLegacy(path: string): Promise<CookieJar | undefined> {
  let raw: string;

  try {
    raw = await readPrivateFile(path, { maxBytes: SESSION_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return undefined;

    throw new SafeError(
      'Cannot read the Abler session file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
    );
  }

  try {
    return await importCookies(cookieInputSchema.parse(JSON.parse(raw)));
  } catch {
    throw new SafeError('Invalid or expired Abler session file. Capture/import a fresh session.');
  }
}

export async function loadSession(path: string): Promise<CookieJar> {
  const jar = await readLegacy(path);

  if (!jar) throw noSession();

  return jar;
}

/** The session as saved: only the authentication cookies, pinned to Abler's HTTPS host. */
const storedJarSchema = z.object({ version: z.literal(1), cookies: z.array(z.unknown()) });

type StoredJar = z.infer<typeof storedJarSchema>;

async function serializeJar(jar: CookieJar): Promise<StoredJar> {
  const cookies = (await jar.serialize()).cookies
    .filter((c) => AUTH_COOKIES.has(c.key ?? ''))
    .map((c) => {
      const cookie = Cookie.fromJSON(c);

      if (!cookie) throw new SafeError('Cannot serialize the Abler session cookie.');
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

  return { version: 1, cookies };
}

export async function saveSession(path: string, jar: CookieJar): Promise<void> {
  const stored = await serializeJar(jar);

  try {
    await writePrivateFile(path, JSON.stringify(stored) + '\n');
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;
    throw new SafeError('Cannot save the Abler session file. Check the directory permissions.');
  }
}

/**
 * The store record's plaintext: the session in use, and a new one awaiting verification. Both
 * null means logged out.
 */
const recordSchema = z.object({
  version: z.literal(1),
  current: storedJarSchema.nullable(),
  candidate: z.object({ id: z.uuid(), jar: storedJarSchema }).nullable(),
});

type SessionRecord = z.infer<typeof recordSchema>;

const EMPTY: SessionRecord = { version: 1, current: null, candidate: null };

/** Which saved session a client uses: the one in use, or the candidate it verifies. */
export type Slot = 'current' | 'candidate';

/** Store failures carry fixed messages; verification passes them on unchanged. */
class StoreFailure extends SafeError {}

/** A session Abler will never accept again; retrying its verification cannot help. */
export class ExpiredSession extends SafeError {}

/** Fixed messages: a store failure never shows a path, key or cookie, and never falls back. */
function storeError(error: SessionStoreError): StoreFailure {
  switch (error.code) {
    case 'STORE_LOCKED':
      return new StoreFailure('The Abler store key is locked. Unlock it and try again.');
    case 'STORE_ACCESS_DENIED':
      return new StoreFailure('Access to the Abler store key was denied.');
    case 'STORE_TIMEOUT':
      return new StoreFailure('The Abler store key did not answer in time. Try again.');
    case 'STORE_UNAVAILABLE':
      return new StoreFailure(
        'The Abler store key is missing. Run abler-mcp auth login, capture or import to sign in again.',
      );
    case 'STORE_BACKEND_RETIRED':
      return new StoreFailure(
        'The Abler session store was set up with the macOS Keychain, which is no longer used. Remove the Abler secret store files and run abler-mcp auth login again.',
      );
    case 'STORE_WRITE_UNCERTAIN':
      return new StoreFailure(
        'The last write to the Abler session store did not complete, so its session is not used. Remove the Abler secret store files and run abler-mcp auth login again.',
      );
    case 'SECRET_NOT_FOUND':
      return new StoreFailure(noSession().message);
    case 'BUSY':
      return new StoreFailure(
        'Another abler-mcp process is using the Abler session store. Try again.',
      );
    case 'LOCK_LOST':
      return new StoreFailure(
        'Another process took over the Abler session lock. Retry the request.',
      );
    case 'CANCELLED':
      return new StoreFailure('Cancelled before the Abler session store changed.');
    case 'TOO_LARGE':
      return new StoreFailure(
        'The Abler session is larger than the store allows. Capture or import a fresh session.',
      );
    default:
      return new StoreFailure(
        'Cannot use the Abler session store. Its files or key are damaged, unsafe, or not readable.',
      );
  }
}

/** Run store work with every store failure turned into its fixed message. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionStoreError) throw storeError(error);
    throw error;
  }
}

/** `keys` is a test seam; the default is the store's key file. */
function sessionRecord(keys?: KeyProvider, signal?: AbortSignal): SecretRecordOptions {
  return {
    path: defaultSecretRecordPath('abler-mcp'),
    server: 'abler-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    maxBytes: SESSION_MAX_BYTES * 2 + 4096,
    keys: keys ?? defaultKeyProvider({ server: 'abler-mcp', profile: 'default' }),
    retired: retiredStorePaths('abler-mcp'),
    signal,
  };
}

const encodeRecord = (record: SessionRecord) => JSON.stringify(recordSchema.parse(record));

/** The committed record, or undefined while the store holds none. */
async function storedRecord(store: SecretStore): Promise<SessionRecord | undefined> {
  const text = await store.read();

  if (text === null) return undefined;

  try {
    return recordSchema.parse(JSON.parse(text));
  } catch {
    throw new SafeError(
      'Invalid Abler session store record. Run abler-mcp auth login, capture or import again.',
    );
  }
}

async function storedJar(stored: StoredJar): Promise<CookieJar> {
  try {
    return await importCookies(stored);
  } catch {
    throw new ExpiredSession('Invalid or expired Abler session. Capture/import a fresh session.');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new SafeError('Cannot inspect the Abler session store. Check its permissions.');
  }
}

/** A marker, or even a lone record, means the store decides; the legacy files are never read. */
async function storeDecides(store: SecretStore, record: SecretRecordOptions): Promise<boolean> {
  return (await store.exists()) || (await exists(record.path));
}

const STORAGE = 'an encrypted file';

/** Create the key when it is missing; only an explicit new login may reset a lost key's store. */
async function prepareKey(
  store: SecretStore,
  record: SecretRecordOptions,
  reset: boolean,
): Promise<boolean> {
  try {
    await record.keys.getKey(record.signal);

    return false;
  } catch (error) {
    if (!(error instanceof SessionStoreError && error.code === 'STORE_UNAVAILABLE')) throw error;
    const used = await storeDecides(store, record);

    if (used) {
      if (!reset) throw error;
      await store.reset();
    }

    await store.createKey();

    return used;
  }
}

/**
 * The legacy file and its `.pending` candidates are credentials; remove them and any orphaned
 * temporaries beside them. True if any was there.
 */
async function removeLegacy(path: string): Promise<boolean> {
  try {
    const found = await exists(path);
    await rm(path, { force: true });
    const pruned = await prunePendingCandidates(path);
    await sweepTemp(path);

    return found || pruned > 0;
  } catch {
    throw new SafeError(
      'Cannot remove the old plaintext Abler session file or its failed-import candidates. Any encrypted-store change already completed; remove those files by hand.',
    );
  }
}

/** A readable legacy session as stored, or null: a broken file is replaced, as it always was. */
async function legacyCurrent(path: string): Promise<StoredJar | null> {
  const found = await readLegacy(path).catch(() => undefined);

  return found ? serializeJar(found) : null;
}

/** The newest readable `.pending` candidate an older version retained, if any. */
async function newestPending(path: string): Promise<StoredJar | undefined> {
  const dated: { candidate: string; mtime: number }[] = [];

  try {
    for (const candidate of await pendingCandidates(path))
      dated.push({ candidate, mtime: (await lstat(candidate)).mtimeMs });
  } catch {
    throw new SafeError('Cannot list the failed-import candidates. Check their permissions.');
  }

  for (const { candidate } of dated.toSorted((a, b) => b.mtime - a.mtime)) {
    const jar = await readLegacy(candidate).catch(() => undefined);

    if (jar) return serializeJar(jar);
  }

  return undefined;
}

/** Resolve symbolic links in the longest existing prefix, so aliases compare equal. */
async function canonical(path: string): Promise<string> {
  let existing = resolve(path);
  const rest: string[] = [];

  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch (error) {
      const parent = dirname(existing);

      if (
        parent === existing ||
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw new SafeError('Cannot resolve the Abler session paths. Check their permissions.');
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Same file, or one name is the other's `<name>.` namespace (lock, marker, temporaries) beside it. */
function overlaps(first: string, second: string): boolean {
  const [a, b] = [basename(first), basename(second)];

  return (
    dirname(first) === dirname(second) &&
    (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`))
  );
}

/** The path and every directory above it, short of the root. */
const lineage = (path: string): string[] =>
  dirname(path) === path ? [] : [path, ...lineage(dirname(path))];

/**
 * The legacy file, its candidates and temporaries are removed and swept recursively, and the
 * store can be reset, so neither namespace may hold, or sit inside a directory of, the other or
 * the key file. Checked before anything is touched.
 */
async function rejectCollisions(record: SecretRecordOptions, legacy: string): Promise<void> {
  const file = await canonical(legacy);
  const owned = [await canonical(record.path)];

  if (record.keys instanceof LocalKeyFileProvider) owned.push(await canonical(record.keys.path));

  if (
    owned.some(
      (path) =>
        lineage(file).some((up) => overlaps(up, path)) ||
        lineage(path).some((up) => overlaps(file, up)),
    )
  )
    throw new SafeError(
      'ABLER_SESSION_FILE overlaps the encrypted Abler session store or its key. Choose another path.',
    );
}

/**
 * Login, import, migrate, retry and logout hold the legacy file's lock for the whole change, and
 * take the store's inside it. Clients take only the store's lock, so the order never inverts.
 */
function administer<T>(
  legacy: string,
  keys: KeyProvider | undefined,
  work: (record: SecretRecordOptions) => Promise<T>,
): Promise<T> {
  return guarded(async () => {
    const record = sessionRecord(keys);
    await rejectCollisions(record, legacy);

    return withSessionLock(legacy, () => guarded(() => work(record)));
  });
}

/** Persists the rotated jar in the place it was read from, before any further request. */
export type SaveJar = () => Promise<void>;

/**
 * Hold the store lock for all of `work`, so refreshes and requests use one session. Before the
 * store has a marker the legacy file is authoritative and rotations are written back to it; once
 * it has one only the store is used, whatever it holds.
 */
export async function withSession<T>(
  legacy: string,
  slot: Slot,
  signal: AbortSignal,
  work: (jar: CookieJar, save: SaveJar, storage: string) => Promise<T>,
  keys?: KeyProvider,
): Promise<T> {
  const lock = { held: false };

  try {
    const record = sessionRecord(keys, signal);

    return await withSecretStore(record, async (store) => {
      lock.held = true;

      if (!(await guarded(() => storeDecides(store, record)))) {
        if (slot === 'candidate') throw noCandidate();
        // Temporaries orphaned by a hard crash hold credentials; old ones are removed.
        await sweepTemp(legacy).catch(() => {
          throw new SafeError('Cannot clean up beside the Abler session file. Check permissions.');
        });
        const jar = await loadSession(legacy);

        return work(
          jar,
          () => saveSession(legacy, jar),
          'Saved in a plaintext file. Run abler-mcp auth migrate.',
        );
      }

      const saved = await guarded(() => storedRecord(store));
      const { current, candidate } = saved ?? EMPTY;
      const stored = slot === 'current' ? current : candidate?.jar;

      if (!saved || !stored) throw slot === 'current' ? noSession() : noCandidate();
      let next = saved;
      const jar = await storedJar(stored);

      const save = async () => {
        const rotated = await serializeJar(jar);

        next =
          slot === 'candidate' && candidate
            ? { ...next, candidate: { id: candidate.id, jar: rotated } }
            : { ...next, current: rotated };

        try {
          await store.write(encodeRecord(next));
        } catch {
          // Abler has consumed the old refresh token, so the record must never offer it again.
          // Removing it under the held lock reads as STORE_WRITE_UNCERTAIN until the next login.
          await rm(record.path, { force: true }).catch(() => undefined);
          throw storeError(new SessionStoreError('STORE_WRITE_UNCERTAIN', 'Rotated session lost.'));
        }
      };

      return work(jar, save, `Saved in ${STORAGE}.`);
    });
  } catch (error) {
    // Errors from `work` pass through; store setup and taking the lock are mapped here.
    if (!lock.held && error instanceof SessionStoreError) throw storeError(error);
    throw error;
  }
}

/** Where the session is saved, after checking that one is. */
export function sessionStorage(legacy = sessionPath(), keys?: KeyProvider): Promise<string> {
  return withSession(
    legacy,
    'current',
    new AbortController().signal,
    async (_, __, storage) => storage,
    keys,
  );
}

/** Verifies the candidate slot, for example with a forced refresh and an authenticated read. */
export type Verify = () => Promise<object>;

async function verifyCandidate(verify: Verify, reset = false): Promise<void> {
  try {
    await verify();
  } catch (error) {
    // A refresh may already have rotated the candidate; it stays retained in the store.
    if (error instanceof StoreFailure || error instanceof ExpiredSession) throw error;

    if (reset)
      throw new SafeError(
        'Session verification failed. The old store could not be read without its key and was replaced; the new session is retained in the encrypted store. Run abler-mcp auth retry-candidate, or capture a fresh session.',
      );
    throw new SafeError(
      'Session verification failed. The previous session was kept; the new one is retained in the encrypted store. Run abler-mcp auth retry-candidate, or capture a fresh session.',
    );
  }
}

/** Make the verified candidate the session in use in one write, then remove plaintext leftovers. */
function promote(record: SecretRecordOptions, legacy: string, id: string): Promise<void> {
  return withSecretStore(record, async (store) => {
    const saved = await storedRecord(store);

    if (saved?.candidate?.id !== id)
      throw new SafeError('The Abler session candidate changed. Capture a fresh session.');
    await store.write(encodeRecord({ version: 1, current: saved.candidate.jar, candidate: null }));
    await removeLegacy(legacy);
  });
}

/**
 * Login, capture and import: store `jar` as the candidate (replacing an older one), verify it,
 * then promote it. Before the store decides, a readable legacy session moves in as the current
 * one, so a failed verification still keeps it. True if a store whose key was lost was reset.
 */
export function saveVerifiedSession(
  jar: CookieJar,
  verify: Verify,
  legacy = sessionPath(),
  keys?: KeyProvider,
): Promise<boolean> {
  return administer(legacy, keys, async (record) => {
    const candidate = { id: randomUUID(), jar: await serializeJar(jar) };

    const replaced = await withSecretStore(record, async (store) => {
      const decides = await storeDecides(store, record);
      const reset = await prepareKey(store, record, true);

      const saved = decides
        ? ((await storedRecord(store)) ?? EMPTY)
        : { ...EMPTY, current: await legacyCurrent(legacy) };

      await store.write(encodeRecord({ ...saved, candidate }));

      // The store decides from here on, so the plaintext files would never be read again.
      if (!decides) await removeLegacy(legacy);

      return reset;
    });

    await verifyCandidate(verify, replaced);
    await promote(record, legacy, candidate.id);

    return replaced;
  });
}

/** Verify and promote the candidate a failed import or a migration retained. */
export function retryCandidate(
  verify: Verify,
  legacy = sessionPath(),
  keys?: KeyProvider,
): Promise<void> {
  return administer(legacy, keys, async (record) => {
    const id = await withSecretStore(record, async (store) => {
      const saved = (await storeDecides(store, record)) ? await storedRecord(store) : undefined;

      if (!saved?.candidate) throw noCandidate();

      return saved.candidate.id;
    });

    await verifyCandidate(verify);
    await promote(record, legacy, id);
  });
}

export type MigrateResult = 'migrated' | 'candidate' | 'already' | 'already-removed-legacy';

/**
 * Move the legacy session into the store as the current one, or, without one, the newest
 * `.pending` candidate into the candidate slot. The write reads the record back before it
 * commits; only then do the plaintext files go. A store with a marker but no record (an
 * interrupted first write or reset) takes the explicit migration.
 */
export function migrateSession(legacy = sessionPath(), keys?: KeyProvider): Promise<MigrateResult> {
  return administer(legacy, keys, (record) =>
    withSecretStore(record, async (store) => {
      if ((await storeDecides(store, record)) && (await storedRecord(store)) !== undefined)
        return (await removeLegacy(legacy)) ? 'already-removed-legacy' : 'already';
      const found = await readLegacy(legacy);
      const current = found ? await serializeJar(found) : null;
      const pending = current ? undefined : await newestPending(legacy);

      if (!current && !pending) throw noSession();
      await prepareKey(store, record, false);
      await store.write(
        encodeRecord({
          version: 1,
          current,
          candidate: pending ? { id: randomUUID(), jar: pending } : null,
        }),
      );
      await removeLegacy(legacy);

      return current ? 'migrated' : 'candidate';
    }),
  );
}

/** Store a logged-out record when the store decides, and remove any plaintext files. */
export function logoutSession(legacy = sessionPath(), keys?: KeyProvider): Promise<void> {
  return administer(legacy, keys, (record) =>
    withSecretStore(record, async (store) => {
      if (await storeDecides(store, record)) await store.write(encodeRecord(EMPTY));
      await removeLegacy(legacy);
    }),
  );
}

/** Attach to an existing Chromium page; the server itself never needs a browser. */
export async function captureCookies(endpoint: string, signal?: AbortSignal): Promise<CookieJar> {
  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new SafeError('Use a loopback Chrome debugging URL, such as http://127.0.0.1:9222.');
  }

  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new SafeError('Use a loopback Chrome debugging URL, such as http://127.0.0.1:9222.');
  }

  let response: Response;

  try {
    response = await fetch(new URL('/json/list', url), {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  } catch {
    throw new SafeError('Cannot connect to Chrome debugging.');
  }

  if (!response.ok) throw new SafeError('Cannot list Chrome debugging tabs.');

  let pages;

  try {
    pages = z
      .array(
        z.object({
          type: z.string(),
          url: z.string(),
          webSocketDebuggerUrl: z.string().optional(),
        }),
      )
      .parse(await response.json());
  } catch {
    throw new SafeError('Invalid Chrome debugging response.');
  }

  const page = pages.find(
    (p) => p.type === 'page' && p.url.startsWith(`${ORIGIN}/`) && p.webSocketDebuggerUrl,
  );

  if (!page?.webSocketDebuggerUrl)
    throw new SafeError('Open www.abler.io and sign in in that browser first.');
  let socketUrl: URL;

  try {
    socketUrl = new URL(page.webSocketDebuggerUrl);
  } catch {
    throw new SafeError('Chrome returned an unexpected debugging address.');
  }

  if (
    socketUrl.protocol !== 'ws:' ||
    socketUrl.host !== url.host ||
    socketUrl.username ||
    socketUrl.password
  ) {
    throw new SafeError('Chrome returned an unexpected debugging address.');
  }

  signal?.throwIfAborted();

  const result = await new Promise<CookieInput>((accept, reject) => {
    const socket = new WebSocket(socketUrl);
    let settled = false;

    const timer = setTimeout(
      () => finish(new SafeError('Chrome session capture timed out.')),
      10000,
    );

    const finish = (error?: Error, value?: CookieInput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);

      if (error) reject(error);
      else if (value) accept(value);
      else reject(new SafeError('Chrome returned no cookies.'));
      socket.close();
    };

    const abort = () => finish(new SafeError('Chrome session capture was cancelled.'));

    signal?.addEventListener('abort', abort, { once: true });

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
            message.error ? new SafeError('Chrome rejected session capture.') : undefined,
            cookieResult,
          );
        }
      } catch {
        finish(new SafeError('Invalid Chrome debugging response.'));
      }
    });
    socket.addEventListener('error', () =>
      finish(new SafeError('Cannot connect to Chrome debugging.')),
    );
    socket.addEventListener('close', () =>
      finish(new SafeError('Chrome debugging connection closed.')),
    );

    if (signal?.aborted) abort();
  });

  return importCookies(cookieInputSchema.parse(result));
}

/**
 * The CLI's store preflight before it serves or runs an auth command: false, after one stderr
 * line, when the store is unsafe; a notice when an earlier build's store is still on disk.
 */
export function checkStoreAtStartup(): Promise<boolean> {
  return startupCheck({
    server: 'abler-mcp',
    signIn: 'abler-mcp auth login',
    store: () => sessionRecord(),
  });
}
