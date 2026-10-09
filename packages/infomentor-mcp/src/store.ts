import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  LocalKeyFileProvider,
  SessionStoreError,
  defaultKeyProvider,
  defaultSecretRecordPath,
  readPrivateFile,
  sweepTemp,
  withSecretStore,
  type KeyProvider,
  type SecretRecordOptions,
  type SecretStore,
} from '@family-mcp/session-store';
import { z } from 'zod';
import {
  PASSWORD_MAX,
  USERNAME_MAX,
  credentialsSchema,
  readCredentials,
  type Credentials,
} from './credentials.js';
import { withSessionLock } from './lock.js';
import {
  InfoMentorError,
  SESSION_MAX_BYTES,
  loginRequiredError,
  readSession,
  savedSessionSchema,
  writeSession,
  type SavedSession,
} from './session.js';

/**
 * The record's plaintext: the session in use (null after logout) and the sign-in that renews it,
 * kept from a successful login or migration until logout.
 */
const recordSchema = z.object({
  version: z.literal(1),
  session: savedSessionSchema.nullable(),
  credentials: credentialsSchema.nullable(),
});

export type StoredRecord = z.infer<typeof recordSchema>;

const LOGGED_OUT: StoredRecord = { version: 1, session: null, credentials: null };

/**
 * Every storable record fits: a session is stored only when its JSON is at most
 * SESSION_MAX_BYTES (the old file's bound), and JSON writes a credential UTF-16 unit in at most 6
 * bytes (`\u0001`).
 */
export const RECORD_MAX_BYTES =
  '{"version":1,"session":,"credentials":{"username":"","password":""}}'.length +
  SESSION_MAX_BYTES +
  6 * (USERNAME_MAX + PASSWORD_MAX);

export function encodeRecord(value: StoredRecord): string {
  const checked = recordSchema.parse(value);

  if (
    checked.session !== null &&
    Buffer.byteLength(JSON.stringify(checked.session)) > SESSION_MAX_BYTES
  )
    throw new InfoMentorError(
      'INVALID_SESSION',
      'The InfoMentor session is larger than the store allows. Run infomentor-mcp login again.',
    );

  return JSON.stringify(checked);
}

const PLAINTEXT = 'Saved in a plaintext file. Run infomentor-mcp auth migrate.';

/** After a sign-in read from a file; `file` is the path the user gave. */
export const deleteCredentialsAdvice = (file: string): string =>
  `Your InfoMentor sign-in is stored in the encrypted store. You can delete ${file} now.`;

/** Fixed messages: a store failure never shows a path, key or secret, and never falls back. */
function storeError(error: SessionStoreError): InfoMentorError {
  switch (error.code) {
    case 'STORE_LOCKED':
      return new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Unlock your login keychain and try again.',
      );
    case 'STORE_ACCESS_DENIED':
      return new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Access to the InfoMentor store key was denied. Allow infomentor-mcp to use the login keychain and try again.',
      );
    case 'STORE_TIMEOUT':
      return new InfoMentorError(
        'INVALID_CONFIGURATION',
        'The login keychain did not answer in time. Try again.',
      );
    case 'STORE_UNAVAILABLE':
      return new InfoMentorError(
        'INVALID_SESSION',
        'The InfoMentor store key is missing. Run infomentor-mcp login to sign in again.',
      );
    case 'STORE_WRITE_UNCERTAIN':
      return new InfoMentorError(
        'INVALID_SESSION',
        'The last write to the InfoMentor session store did not complete, so its session is not used. Remove the InfoMentor secret store files and run infomentor-mcp login again.',
      );
    case 'BUSY':
      return new InfoMentorError(
        'OPERATION_IN_PROGRESS',
        'Another process is using the InfoMentor session store and did not finish within the wait limit. Retry after its operation finishes.',
      );
    case 'LOCK_LOST':
      return new InfoMentorError(
        'OPERATION_IN_PROGRESS',
        'Another process took over the InfoMentor session store lock during this operation. Retry it.',
      );
    case 'CANCELLED':
      return new InfoMentorError(
        'CANCELLED',
        'Operation cancelled. The existing saved session was kept.',
      );
    case 'TOO_LARGE':
      return new InfoMentorError(
        'INVALID_SESSION',
        'The InfoMentor session is larger than the store allows. Run infomentor-mcp login again.',
      );
    default:
      return new InfoMentorError(
        'INVALID_SESSION',
        'Cannot use the InfoMentor session store. Its files or key are damaged, unsafe, or not readable.',
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

/** `keys` is a test seam; the default is the macOS Keychain or a Linux key file. */
function sessionRecord(keys?: KeyProvider, signal?: AbortSignal): SecretRecordOptions {
  return {
    path: defaultSecretRecordPath('infomentor-mcp'),
    server: 'infomentor-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    maxBytes: RECORD_MAX_BYTES,
    keys: keys ?? defaultKeyProvider({ server: 'infomentor-mcp', profile: 'default' }),
    signal,
  };
}

export const parseRecord = (text: string): StoredRecord | undefined => {
  try {
    return recordSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** The committed record, or undefined while the store holds none. */
async function storedRecord(store: SecretStore): Promise<StoredRecord | undefined> {
  const text = await store.read();

  if (text === null) return undefined;

  const value = parseRecord(text);

  if (!value)
    throw new InfoMentorError(
      'INVALID_SESSION',
      'Invalid InfoMentor session store record. Run infomentor-mcp login to sign in again.',
    );

  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Cannot inspect the InfoMentor session store. Check its permissions.',
    );
  }
}

/** A marker, or even a lone record, means the store decides; the legacy file is never read. */
async function storeDecides(store: SecretStore, record: SecretRecordOptions): Promise<boolean> {
  return (await store.exists()) || (await exists(record.path));
}

function storageName(keys: KeyProvider): string {
  return keys.keySource === 'keychain-accessor'
    ? 'an encrypted file whose key is in the macOS Keychain'
    : 'an encrypted file';
}

/** Create the key when it is missing; only an explicit login or import may reset a lost key's store. */
async function prepareKey(
  store: SecretStore,
  record: SecretRecordOptions,
  reset: boolean,
): Promise<void> {
  try {
    await record.keys.getKey(record.signal);
  } catch (error) {
    if (!(error instanceof SessionStoreError && error.code === 'STORE_UNAVAILABLE')) throw error;

    if (await storeDecides(store, record)) {
      if (!reset) throw error;
      await store.reset();
    }

    await store.createKey();
  }
}

/**
 * The legacy file is a credential; remove it and any orphaned temporaries beside it, and on
 * logout the collection cursors too. True if the file was there.
 */
async function removeLegacy(path: string, collections = false): Promise<boolean> {
  try {
    const found = await exists(path);
    await rm(path, { force: true });

    // Snapshots hold fingerprints and identifiers of the account; they leave with the session.
    if (collections) await rm(`${path}.collections`, { recursive: true, force: true });
    await sweepTemp(path);

    return found;
  } catch {
    if (collections)
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Cannot remove the plaintext InfoMentor session file or its collection cursors. Any encrypted-store change already completed; remove them by hand.',
      );
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Cannot remove the plaintext InfoMentor session file. Any encrypted-store change already completed; remove it by hand.',
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
        throw new InfoMentorError(
          'INVALID_CONFIGURATION',
          'Cannot resolve the InfoMentor session paths. Check their permissions.',
        );
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
 * The legacy file is removed and swept, logout removes the collection cursors, and the store
 * sweeps its own namespace and can be reset, so neither the legacy file nor its collections may
 * share the record's or key file's namespace (marker, lock, temporaries) or lie inside or around
 * either. Checked before anything is touched.
 */
async function rejectCollisions(record: SecretRecordOptions, legacy: string): Promise<void> {
  const used = [await canonical(legacy), await canonical(`${legacy}.collections`)];
  const owned = [await canonical(record.path)];

  if (record.keys instanceof LocalKeyFileProvider) owned.push(await canonical(record.keys.path));

  if (owned.some((path) => used.some((other) => collides(path, other))))
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'The InfoMentor session file path overlaps the encrypted InfoMentor session store or its key. Choose another INFOMENTOR_SESSION_PATH or --session.',
    );
}

/**
 * Login, import, migrate and logout hold the legacy file's lock and then the store's for the
 * whole authority decision, legacy read, store commit and legacy removal. Clients take only the
 * store's lock, so the order never inverts.
 */
export function changeSession<T>(
  legacy: string,
  keys: KeyProvider | undefined,
  signal: AbortSignal | undefined,
  work: (store: SecretStore, record: SecretRecordOptions) => Promise<T>,
): Promise<T> {
  return guarded(async () => {
    const record = sessionRecord(keys, signal);
    await rejectCollisions(record, legacy);

    return withSessionLock(legacy, signal, () =>
      guarded(() => withSecretStore(record, (store) => work(store, record))),
    );
  });
}

export type HeldSession = {
  session: SavedSession;
  /** The stored sign-in for renewal; null before migration or when none was stored. */
  credentials: Credentials | null;
  /** Where the session lives and whether a sign-in is stored; never a path or a value. */
  storage: string;
  /** Persist a changed session where it was read from, keeping the stored sign-in. */
  save: (next: SavedSession) => Promise<void>;
};

/**
 * Hold the store lock for all of `work`, so a renewal, the request and the cookies it rotates use
 * one session. Before the store has a marker the legacy file is authoritative and changes are
 * written back to it; once it has one only the store is used, whatever it holds.
 */
export function withSession<T>(
  legacy: string,
  signal: AbortSignal,
  keys: KeyProvider | undefined,
  work: (held: HeldSession) => Promise<T>,
): Promise<T> {
  return guarded(async () => {
    const record = sessionRecord(keys, signal);
    await rejectCollisions(record, legacy);

    return withSecretStore(record, async (store) => {
      if (!(await storeDecides(store, record))) {
        // Temporaries orphaned by a hard crash hold cookies; old ones are removed.
        await sweepTemp(legacy).catch(() => {
          throw new InfoMentorError(
            'INVALID_CONFIGURATION',
            'Cannot clean up beside the InfoMentor session file. Check its directory permissions.',
          );
        });

        return work({
          session: await readSession(legacy),
          credentials: null,
          storage: PLAINTEXT,
          save: (next) => writeSession(next, legacy, signal),
        });
      }

      const stored = await storedRecord(store);
      const session = stored?.session;

      if (!stored || !session) throw loginRequiredError();

      return work({
        session,
        credentials: stored.credentials,
        storage: `Saved in ${storageName(record.keys)}. ${
          stored.credentials
            ? 'Your InfoMentor sign-in is stored there for automatic renewal.'
            : 'No InfoMentor sign-in is stored for automatic renewal.'
        }`,
        save: (next) => store.write(encodeRecord({ ...stored, session: next })),
      });
    });
  });
}

/** The saved session an explicit login or import must not silently replace. */
export type Previous = {
  /**
   * null when nothing identifies an account (none, logged out, or an older browser snapshot);
   * undefined when it cannot be read safely.
   */
  session: SavedSession | null | undefined;
  record?: StoredRecord | undefined;
};

const legacySchema = z.union([
  z.object({ version: z.literal(1) }).passthrough(),
  savedSessionSchema,
]);

/**
 * Prepare the key and read what is saved before any request, so an unusable store refuses
 * before a credential is submitted. A lost key's store is reset here: an explicit login or
 * import is the only recovery.
 */
export async function prepareChange(
  store: SecretStore,
  record: SecretRecordOptions,
  legacy: string,
): Promise<Previous> {
  await prepareKey(store, record, true);

  if (await storeDecides(store, record)) {
    const text = await store.read();

    if (text === null) return { session: null };
    const value = parseRecord(text);

    return value ? { session: value.session, record: value } : { session: undefined };
  }

  try {
    const value = legacySchema.safeParse(
      JSON.parse(await readPrivateFile(legacy, { maxBytes: SESSION_MAX_BYTES })),
    );

    if (!value.success) return { session: undefined };

    return { session: value.data.version === 1 ? null : value.data };
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return { session: null };

    return { session: undefined };
  }
}

/** Commit the new session with its sign-in in one write, then remove the plaintext file. */
export async function commitChange(
  store: SecretStore,
  legacy: string,
  value: StoredRecord,
  onCommitted?: () => void,
): Promise<void> {
  await store.write(encodeRecord(value));
  onCommitted?.();
  await removeLegacy(legacy);
}

export type MigrateResult = 'migrated' | 'already' | 'already-removed-legacy';

/**
 * Move the legacy session, and the sign-in from `credentialsFile` when given, into the store,
 * read it back, then remove the plaintext session file. Collection cursors stay where they are.
 * A store with a marker but no record (an interrupted first write or reset) takes the explicit
 * migration.
 */
export function migrate(
  legacy: string,
  credentialsFile?: string,
  keys?: KeyProvider,
): Promise<MigrateResult> {
  return changeSession(legacy, keys, undefined, async (store, record) => {
    if ((await storeDecides(store, record)) && (await storedRecord(store)) !== undefined)
      return (await removeLegacy(legacy)) ? 'already-removed-legacy' : 'already';
    const credentials = credentialsFile ? await readCredentials(resolve(credentialsFile)) : null;
    const session = await readSession(legacy);
    await prepareKey(store, record, false);
    // The write reads the record back before it commits; only then does the plaintext go.
    await commitChange(store, legacy, { version: 1, session, credentials });

    return 'migrated';
  });
}

/** Store a logged-out record when the store decides, and remove the plaintext files and cursors. */
export function logout(legacy: string, keys?: KeyProvider): Promise<void> {
  return changeSession(legacy, keys, undefined, async (store, record) => {
    if (await storeDecides(store, record)) await store.write(encodeRecord(LOGGED_OUT));
    await removeLegacy(legacy, true);
  });
}
