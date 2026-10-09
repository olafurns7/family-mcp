import { lstat, realpath, rm } from 'node:fs/promises';
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
import * as z from 'zod/v4';

import { API, HttpError, requestJson, requestText, type Request } from './http.js';

const TOKEN_MAX = 32768;

const USERNAME_MAX = 256;

const token = z
  .string()
  .min(1)
  .max(TOKEN_MAX)
  .regex(/^[\x21-\x7e]+$/);

const username = z.string().min(1).max(USERNAME_MAX);

const tokenResponse = z.object({
  access_token: token,
  refresh_token: token,
  expires_in: z.number().int().positive(),
  token_type: z.string().regex(/^bearer$/i),
  username,
});

const session = z.object({
  version: z.literal(1),
  accessToken: token,
  refreshToken: token,
  username,
  expiresAt: z.number().finite(),
});

export type Session = z.infer<typeof session>;

/**
 * Every schema-valid session fits the record, so a refreshed one is always storable. JSON writes a
 * printable-ASCII token character in at most 2 bytes, a username UTF-16 unit in at most 6
 * (`\u0001`), and a finite number in at most 24 (`-1.7976931348623157e+308`).
 */
export const SESSION_MAX_BYTES =
  '{"version":1,"accessToken":"","refreshToken":"","username":"","expiresAt":}'.length +
  2 * 2 * TOKEN_MAX +
  6 * USERNAME_MAX +
  24;

/**
 * The pre-store plaintext session file. Quotes and checkouts still live in `<path>.checkouts`, so
 * it stays the same whether or not the session was migrated.
 */
export const sessionPath = () =>
  resolve(process.env.DOMINOS_SESSION_FILE || defaultSessionPath('dominos-mcp'));

/** Fixed messages: a store failure never shows a path, key or token, and never falls back. */
function storeError(error: SessionStoreError): SafeError {
  switch (error.code) {
    case 'STORE_UNAVAILABLE':
      return new SafeError(
        'The Domino’s store key is missing. Run dominos-mcp auth login to sign in again.',
      );
    case 'STORE_BACKEND_RETIRED':
      return new SafeError(
        'The Domino’s session store is a leftover of an earlier test build that kept its key in the macOS Keychain. Remove session.enc and session.enc.marker from ~/Library/Application Support/family-mcp/dominos-mcp, then run dominos-mcp auth login again.',
      );
    case 'STORE_WRITE_UNCERTAIN':
      return new SafeError(
        'The last write to the Domino’s session store did not complete, so its session is not used. Remove session.enc and session.enc.marker from the Domino’s store folder (~/Library/Application Support/family-mcp/dominos-mcp on macOS, ~/.config/dominos-mcp on Linux by default), then run dominos-mcp auth login again.',
      );
    case 'SECRET_NOT_FOUND':
      return new SafeError('No saved Domino’s session. Run dominos-mcp auth login first.');
    case 'BUSY':
      return new SafeError(
        'Another dominos-mcp process is using the Domino’s session store. Try again.',
      );
    case 'CANCELLED':
      return new SafeError('Cancelled before the Domino’s session store changed.');
    case 'TOO_LARGE':
      return new SafeError(
        'The Domino’s session is larger than the store allows. Run dominos-mcp auth login again.',
      );
    case 'UNSAFE_FILE':
      return new SafeError(
        'Cannot use the Domino’s session store. Run dominos-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first.',
      );
    default:
      return new SafeError(
        'Cannot use the Domino’s session store. Its files or key are damaged, unsafe, or not readable.',
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
    path: defaultSecretRecordPath('dominos-mcp'),
    server: 'dominos-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    maxBytes: SESSION_MAX_BYTES,
    keys: keys ?? defaultKeyProvider({ server: 'dominos-mcp', profile: 'default' }),
    retired: retiredStorePaths('dominos-mcp'),
    signal,
  };
}

const encodeRecord = (value: Session | null) =>
  JSON.stringify(value === null ? null : session.parse(value));

/** The committed record's session (null after logout), or undefined while the store holds none. */
async function storedSession(store: SecretStore): Promise<Session | null | undefined> {
  const text = await store.read();

  if (text === null) return undefined;

  try {
    return session.nullable().parse(JSON.parse(text));
  } catch {
    throw new SafeError(
      'Invalid Domino’s session store record. Run dominos-mcp auth login to sign in again.',
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new SafeError('Cannot inspect the Domino’s session store. Check its permissions.');
  }
}

/** A marker, or even a lone record, means the store decides; the legacy file is never read. */
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
    await store.checkKey();

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

/** The legacy file is a credential; remove it and any orphaned temporaries beside it. */
async function removeLegacy(path: string): Promise<boolean> {
  try {
    const found = await exists(path);
    await rm(path, { force: true });
    await sweepTemp(path);

    return found;
  } catch {
    throw new SafeError(
      'Saved in the encrypted store, but the old plaintext session file could not be removed. Remove it by hand.',
    );
  }
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
        throw new SafeError('Cannot resolve the Domino’s session paths. Check their permissions.');
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

/** `path` and every directory above it. */
function lineage(path: string): string[] {
  const paths = [path];

  for (let parent = dirname(path); parent !== paths.at(-1); parent = dirname(parent))
    paths.push(parent);

  return paths;
}

/** Either path, or a directory above it, is the other or lies in the other's `<name>.` namespace. */
function collides(first: string, second: string): boolean {
  return (
    lineage(first).some((path) => overlaps(path, second)) ||
    lineage(second).some((path) => overlaps(path, first))
  );
}

/**
 * The legacy file is removed and swept, the checkouts directory holds payment state, and the store
 * sweeps its own namespace and can be reset, so neither the legacy file nor the checkouts directory
 * may share the record's or key file's namespace (marker, lock, temporaries) or lie inside or around
 * either. Checked before anything is touched.
 */
async function rejectCollisions(record: SecretRecordOptions, legacy: string): Promise<void> {
  const used = [await canonical(legacy), await canonical(`${legacy}.checkouts`)];
  const owned = [await canonical(record.path)];

  if (record.keys instanceof LocalKeyFileProvider) owned.push(await canonical(record.keys.path));

  if (owned.some((path) => used.some((other) => collides(path, other))))
    throw new SafeError(
      'DOMINOS_SESSION_FILE overlaps the encrypted Domino’s session store or its key. Choose another path.',
    );
}

/**
 * Login, migrate and logout hold the legacy file's lock and then the store's for the whole
 * authority decision, legacy read, store commit and legacy removal. Clients take only the
 * store's lock, so the order never inverts.
 */
function changeSession<T>(
  legacy: string,
  keys: KeyProvider | undefined,
  work: (store: SecretStore, record: SecretRecordOptions) => Promise<T>,
): Promise<T> {
  return guarded(async () => {
    const record = sessionRecord(keys);
    await rejectCollisions(record, legacy);

    return withFileLock(legacy, {}, () => withSecretStore(record, (store) => work(store, record)));
  });
}

/** Persists a rotated session in the place it was read from. */
export type SaveSession = (next: Session) => Promise<void>;

/**
 * Hold the store lock for all of `work`, so a refresh, the request and a refresh after a 401 use
 * one session. Before the store has a marker the legacy file is authoritative and refreshes are
 * written back to it; once it has one only the store is used, whatever it holds.
 */
export async function withSession<T>(
  legacy: string,
  signal: AbortSignal,
  work: (current: Session, save: SaveSession, storage: string) => Promise<T>,
  keys?: KeyProvider,
): Promise<T> {
  const lock = { held: false };

  try {
    const record = sessionRecord(keys, signal);

    return await withSecretStore(record, async (store) => {
      lock.held = true;

      if (!(await guarded(() => storeDecides(store, record))))
        return work(
          await loadSession(legacy),
          (next) => saveLegacy(legacy, next),
          'Saved in a plaintext file. Run dominos-mcp auth migrate.',
        );
      const current = await guarded(() => storedSession(store));

      if (current === null || current === undefined)
        throw new SafeError('No saved Domino’s session. Run dominos-mcp auth login first.');

      return work(current, (next) => saveRefreshed(store, record, next), `Saved in ${STORAGE}.`);
    });
  } catch (error) {
    // Errors from `work` pass through; store setup and taking the lock are mapped here.
    if (!lock.held && error instanceof SessionStoreError) throw storeError(error);
    throw error;
  }
}

/**
 * Domino's has already consumed the old refresh token, so if its replacement cannot be stored the
 * old record must never refresh again. Removing the record under the held lock leaves the marker
 * without one, which the store reads as STORE_WRITE_UNCERTAIN until the next login. Nothing retries.
 */
async function saveRefreshed(
  store: SecretStore,
  record: SecretRecordOptions,
  next: Session,
): Promise<void> {
  try {
    await store.write(encodeRecord(next));
  } catch {
    // If this removal fails too, the old record stays, and Domino’s rejects its spent token.
    await rm(record.path, { force: true }).catch(() => undefined);
    throw storeError(new SessionStoreError('STORE_WRITE_UNCERTAIN', 'Refreshed session lost.'));
  }
}

/** Where the session is saved, after checking that one is. */
export function sessionStorage(path = sessionPath(), keys?: KeyProvider): Promise<string> {
  return withSession(path, new AbortController().signal, async (_, __, storage) => storage, keys);
}

export function phoneNumber(value: string): string {
  const digits = value.replace(/[\s+-]/g, '');
  const normalized = digits.length === 7 ? `354${digits}` : digits;

  if (!/^354\d{7}$/.test(normalized))
    throw new SafeError('Use a seven-digit Icelandic phone number, optionally prefixed with +354.');

  return normalized;
}

/** The pre-store plaintext file, read with the rules it always had. */
export async function loadSession(path: string): Promise<Session> {
  try {
    // The file ends with a newline.
    const text = await readPrivateFile(path, { maxBytes: SESSION_MAX_BYTES + 1 });

    return session.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND')
      throw new SafeError('No saved Domino’s session. Run dominos-mcp auth login first.');

    throw new SafeError(
      'Cannot read the Domino’s session. Use a private regular file owned by you, or sign in again.',
    );
  }
}

export async function saveSession(path: string, value: Session): Promise<void> {
  await writePrivateFile(path, JSON.stringify(session.parse(value)) + '\n');
}

async function saveLegacy(path: string, value: Session): Promise<void> {
  try {
    await saveSession(path, value);
  } catch (error) {
    if (error instanceof SessionStoreError)
      throw new SafeError(
        'Cannot save the refreshed Domino’s session file. Check its permissions, or sign in again.',
      );
    throw error;
  }
}

/** Quote and checkout state is locked per file; such a lock is always taken before the session's. */
export async function locked<T>(
  path: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await withFileLock(path, { signal }, async () => {
      await sweepTemp(path);

      return work();
    });
  } catch (error) {
    if (error instanceof SessionStoreError)
      throw new SafeError(
        'Cannot safely access the local Domino’s session. Check file permissions or retry when the other request finishes.',
      );

    throw error;
  }
}

export async function exchangeToken(
  request: Request,
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<Session> {
  try {
    const value = await requestJson(
      request,
      `${API}token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      signal,
      tokenResponse,
    );

    return {
      version: 1,
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      username: value.username,
      expiresAt: Date.now() + value.expires_in * 1000,
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 429)
      throw new SafeError(
        'Domino’s is rate limiting sign-in. Wait before requesting another code.',
      );

    if (error instanceof HttpError)
      throw new SafeError('Domino’s rejected the sign-in code or refresh token. Sign in again.');

    throw error;
  }
}

export async function requestCode(phone: string, request: Request = fetch): Promise<void> {
  await requestText(
    request,
    `${API}login/sendPin?phoneNumber=${phoneNumber(phone)}`,
    { method: 'POST' },
    new AbortController().signal,
  );
}

/**
 * Exchange the SMS code and save the verified session in the store, then remove any plaintext
 * file. The key is prepared and the store read first, so an unusable store
 * refuses before the code is used. True if a store whose key was lost was reset.
 */
export async function login(
  phone: string,
  pin: string,
  path = sessionPath(),
  request: Request = fetch,
  keys?: KeyProvider,
): Promise<boolean> {
  if (!/^\d{6}$/.test(pin)) throw new SafeError('The SMS code must contain six digits.');
  const signal = new AbortController().signal;

  return changeSession(path, keys, async (store, record) => {
    const replaced = await prepareKey(store, record, true);

    // An uncertain or unreadable store refuses here, before the SMS code is spent.
    if (await storeDecides(store, record)) await store.read();

    const value = await exchangeToken(
      request,
      new URLSearchParams({
        grant_type: 'password',
        username: phoneNumber(phone),
        password: pin,
        authentication_type: 'sms',
      }),
      signal,
    );

    await requestJson(
      request,
      `${API}user/newuser`,
      {
        headers: { Authorization: `bearer ${value.accessToken}` },
      },
      signal,
      z.object({ id: z.union([z.string(), z.number()]) }),
    );
    await store.write(encodeRecord(value));
    await removeLegacy(path);

    return replaced;
  });
}

export type MigrateResult = 'migrated' | 'already' | 'already-removed-legacy';

/**
 * Move the legacy session into the store, read it back, then remove the plaintext file. A store
 * with a marker but no record (an interrupted first write or reset) takes the explicit migration.
 */
export function migrate(path = sessionPath(), keys?: KeyProvider): Promise<MigrateResult> {
  return changeSession(path, keys, async (store, record) => {
    if ((await storeDecides(store, record)) && (await storedSession(store)) !== undefined)
      return (await removeLegacy(path)) ? 'already-removed-legacy' : 'already';
    const value = await loadSession(path);
    await prepareKey(store, record, false);
    // The write reads the record back before it commits; only then does the plaintext go.
    await store.write(encodeRecord(value));
    await removeLegacy(path);

    return 'migrated';
  });
}

/** Store a logged-out record when the store decides, and remove any plaintext file. */
export function logout(path = sessionPath(), keys?: KeyProvider): Promise<void> {
  return changeSession(path, keys, async (store, record) => {
    if (await storeDecides(store, record)) await store.write(encodeRecord(null));
    await removeLegacy(path);
  });
}

/**
 * The CLI's store preflight before it serves or runs an auth command: false, after one stderr
 * line, when the store is unsafe; a notice when an earlier build's store is still on disk.
 */
export function checkStoreAtStartup(): Promise<boolean> {
  return startupCheck({
    server: 'dominos-mcp',
    signIn: 'dominos-mcp auth login',
    store: () => sessionRecord(),
  });
}
