import { lstat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import {
  LocalKeyFileProvider,
  SessionStoreError,
  defaultKeyProvider,
  defaultSecretRecordPath,
  defaultSessionPath,
  readPrivateFile,
  sweepTemp,
  withFileLock,
  withSecretStore,
  type KeyProvider,
  type SecretRecordOptions,
  type SecretStore,
} from '@family-mcp/session-store';
import * as z from 'zod/v4';

export const ORIGIN = 'https://api.kronan.is';

/** One access token of at most 4 KiB fits comfortably; anything larger is not a token file. */
export const TOKEN_MAX_BYTES = 16_384;

/** Printable ASCII only, so the value can never smuggle header separators or line breaks. */
const tokenSchema = z
  .string()
  .min(8)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

const tokenFileSchema = z.object({ version: z.literal(1), token: tokenSchema });

/** The store record's plaintext; a null token means logged out. */
const tokenRecordSchema = z.object({ version: z.literal(1), token: tokenSchema.nullable() });

/**
 * The pre-store plaintext token file. Order-attempt records still derive their path from it, so
 * it stays the same whether or not the token was migrated.
 */
export const tokenPath = () =>
  resolve(process.env.KRONAN_TOKEN_FILE || defaultSessionPath('kronan-mcp'));

/** Fixed messages: a store failure never shows a path, key or token, and never falls back. */
function storeError(error: SessionStoreError): SafeError {
  switch (error.code) {
    case 'STORE_LOCKED':
      return new SafeError('Unlock your login keychain and try again.');
    case 'STORE_ACCESS_DENIED':
      return new SafeError(
        'Access to the Krónan store key was denied. Allow kronan-mcp to use the login keychain and try again.',
      );
    case 'STORE_TIMEOUT':
      return new SafeError('The login keychain did not answer in time. Try again.');
    case 'STORE_UNAVAILABLE':
      return new SafeError(
        'The Krónan store key is missing. Run kronan-mcp auth set to save the token again.',
      );
    case 'STORE_WRITE_UNCERTAIN':
      return new SafeError(
        'The last write to the Krónan token store did not complete, so its token is not used. Remove the Krónan secret store files and run kronan-mcp auth set again.',
      );
    case 'SECRET_NOT_FOUND':
      return new SafeError('No saved Krónan access token. Run kronan-mcp auth set first.');
    case 'BUSY':
      return new SafeError(
        'Another kronan-mcp process is using the Krónan token store. Try again.',
      );
    case 'CANCELLED':
      return new SafeError('Cancelled before the Krónan token store changed.');
    case 'TOO_LARGE':
      return new SafeError(
        'The Krónan token store holds more than one access token. Run kronan-mcp auth set again.',
      );
    default:
      return new SafeError(
        'Cannot use the Krónan token store. Its files or key are damaged, unsafe, or not readable.',
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
function tokenRecord(keys?: KeyProvider): SecretRecordOptions {
  return {
    path: defaultSecretRecordPath('kronan-mcp'),
    server: 'kronan-mcp',
    profile: 'default',
    purpose: 'token',
    schema: 1,
    maxBytes: TOKEN_MAX_BYTES,
    keys: keys ?? defaultKeyProvider({ server: 'kronan-mcp', profile: 'default' }),
  };
}

const encodeRecord = (token: string | null) => JSON.stringify({ version: 1, token });

function decodeRecord(text: string): string | null {
  try {
    return tokenRecordSchema.parse(JSON.parse(text)).token;
  } catch {
    throw new SafeError('Invalid Krónan token store record. Run kronan-mcp auth set again.');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new SafeError('Cannot inspect the Krónan token store. Check its permissions.');
  }
}

/** A marker, or even a lone record, means the store decides; the legacy file is never read. */
async function storeDecides(store: SecretStore, record: SecretRecordOptions): Promise<boolean> {
  return (await store.exists()) || (await exists(record.path));
}

/** The committed record's token (null after logout), or undefined while the store holds none. */
async function storedToken(store: SecretStore): Promise<string | null | undefined> {
  const text = await store.update(async () => undefined);

  return text === null ? undefined : decodeRecord(text);
}

function storageName(keys: KeyProvider): string {
  return keys.keySource === 'keychain-accessor'
    ? 'an encrypted file whose key is in the macOS Keychain'
    : 'an encrypted file';
}

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

/** The legacy file is a credential; remove it and any orphaned temporaries beside it. */
async function removeLegacy(path: string): Promise<boolean> {
  try {
    const found = await exists(path);
    await rm(path, { force: true });
    await sweepTemp(path);

    return found;
  } catch {
    throw new SafeError(
      'Saved in the encrypted store, but the old plaintext token file could not be removed. Remove it by hand.',
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
        throw new SafeError('Cannot resolve the Krónan token paths. Check their permissions.');
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

/**
 * The legacy file is removed and swept, and the store can be reset, so neither may alias the
 * other, the key file, or the order-attempt journal. Checked before anything is touched.
 */
async function rejectCollisions(record: SecretRecordOptions, legacy: string): Promise<void> {
  const store = await canonical(record.path);
  const token = await canonical(legacy);
  // attempts.ts derives the journal the same way; it imports this module, so it is spelled here.
  const journal = await canonical(`${legacy}.order-attempts.json`);
  const owned = [store];

  if (record.keys instanceof LocalKeyFileProvider) owned.push(await canonical(record.keys.path));

  if (owned.some((path) => overlaps(token, path) || overlaps(journal, path)))
    throw new SafeError(
      'KRONAN_TOKEN_FILE overlaps the encrypted Krónan token store or its key. Choose another path.',
    );
}

/**
 * Set, migrate and logout hold the legacy file's lock and then the store's for the whole
 * authority decision, legacy read, store commit and legacy removal. Readers take only the
 * store's lock, so the order never inverts.
 */
function changeToken<T>(
  keys: KeyProvider | undefined,
  work: (store: SecretStore, record: SecretRecordOptions, legacy: string) => Promise<T>,
): Promise<T> {
  return guarded(async () => {
    const record = tokenRecord(keys);
    const legacy = tokenPath();
    await rejectCollisions(record, legacy);

    return withFileLock(legacy, {}, () =>
      withSecretStore(record, (store) => work(store, record, legacy)),
    );
  });
}

export type SavedToken = { token: string; storage: string };

/**
 * Before the store has a marker the legacy file is authoritative, and `storage` says so. Once it
 * has one only the store is read, whatever it holds.
 */
export function loadSavedToken(keys?: KeyProvider): Promise<SavedToken> {
  return guarded(async () => {
    const record = tokenRecord(keys);

    return withSecretStore(record, async (store) => {
      if (!(await storeDecides(store, record)))
        return {
          token: await loadLegacyToken(tokenPath()),
          storage: 'Saved in a plaintext file. Run kronan-mcp auth migrate.',
        };
      const token = await storedToken(store);

      if (token === null || token === undefined)
        throw new SafeError('No saved Krónan access token. Run kronan-mcp auth set first.');

      return { token, storage: `Saved in ${storageName(record.keys)}.` };
    });
  });
}

export async function loadToken(keys?: KeyProvider): Promise<string> {
  return (await loadSavedToken(keys)).token;
}

/** Save a verified token in the store, then remove the plaintext file. True if a store was reset. */
export function saveToken(token: string, keys?: KeyProvider): Promise<boolean> {
  const plaintext = encodeRecord(tokenSchema.parse(token));

  return changeToken(keys, async (store, record, legacy) => {
    const replaced = await prepareKey(store, record, true);
    await store.update(async () => plaintext);
    await removeLegacy(legacy);

    return replaced;
  });
}

export type MigrateResult = 'migrated' | 'already' | 'already-removed-legacy';

/**
 * Move the legacy token into the store, read it back, then remove the plaintext file. A store
 * with a marker but no record (an interrupted first write or reset) takes the explicit migration.
 */
export function migrateToken(keys?: KeyProvider): Promise<MigrateResult> {
  return changeToken(keys, async (store, record, legacy) => {
    if ((await storeDecides(store, record)) && (await storedToken(store)) !== undefined)
      return (await removeLegacy(legacy)) ? 'already-removed-legacy' : 'already';
    const token = await loadLegacyToken(legacy);
    await prepareKey(store, record, false);
    await store.update(async () => encodeRecord(token));
    await removeLegacy(legacy);

    return 'migrated';
  });
}

/** Store a logged-out record when the store decides, and remove any plaintext file. */
export function logoutToken(keys?: KeyProvider): Promise<void> {
  return changeToken(keys, async (store, record, legacy) => {
    if (await storeDecides(store, record)) await store.update(async () => encodeRecord(null));
    await removeLegacy(legacy);
  });
}

/** Accept pasted or piped input with surrounding whitespace; reject anything that is not one token. */
export function normalizeToken(raw: string): string {
  const parsed = tokenSchema.safeParse(raw.trim());

  if (!parsed.success)
    throw new SafeError(
      'Invalid Krónan access token. Paste the token exactly as Krónan shows it, on one line.',
    );

  return parsed.data;
}

/** A pasted-token source file is a credential too; it must meet the same private-file rules. */
export async function readTokenSource(path: string): Promise<string> {
  try {
    return await readPrivateFile(path, { maxBytes: TOKEN_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
      throw new SafeError('The token source file does not exist.');
    }

    if (error instanceof SessionStoreError && error.code === 'TOO_LARGE')
      throw new SafeError('The token source file is too large to hold one access token.');

    throw new SafeError(
      'Cannot read the token source file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
    );
  }
}

/** The pre-store plaintext file, read with the rules it always had. */
async function loadLegacyToken(path: string): Promise<string> {
  let raw: string;

  try {
    raw = await readPrivateFile(path, { maxBytes: TOKEN_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
      throw new SafeError('No saved Krónan access token. Run kronan-mcp auth set first.');
    }

    if (error instanceof SessionStoreError && error.code === 'TOO_LARGE')
      throw new SafeError(
        'The Krónan token file is too large to be a token file. Run kronan-mcp auth set again.',
      );

    throw new SafeError(
      'Cannot read the Krónan token file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
    );
  }

  try {
    return tokenFileSchema.parse(JSON.parse(raw)).token;
  } catch {
    throw new SafeError('Invalid Krónan token file. Run kronan-mcp auth set again.');
  }
}
