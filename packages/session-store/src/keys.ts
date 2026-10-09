import { randomBytes, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { excludeFromBackups } from './backup.js';
import { SessionStoreError, systemErrorCode } from './errors.js';
import { readPrivateBytes, sweepTemp, syncDirectory } from './files.js';
import { checkStorePaths, lstatOrMissing, storeDirectories, temporariesOf } from './storage.js';

export const KEY_BYTES = 32;

/** Where a record's 256-bit data key lives. Runtime code only calls `getKey`. */
export type KeyProvider = {
  /** Persisted in the marker; a different backend later is a mismatch, never a fallback. */
  readonly backend: string;
  readonly keySource: string;
  readonly keyId: string;
  /** Returns the existing key. Never creates one: a missing key is STORE_UNAVAILABLE. */
  getKey(signal?: AbortSignal): Promise<Uint8Array>;
  /** Explicit setup only; refuses to replace an existing key. Use `createSecretKey`. */
  createKey(signal?: AbortSignal): Promise<void>;
};

export function keyUnavailable(cause?: unknown): SessionStoreError {
  return new SessionStoreError(
    'STORE_UNAVAILABLE',
    'The store key is not available. Restore the key or set up the store again.',
    { cause },
  );
}

export function keyExists(cause?: unknown): SessionStoreError {
  return new SessionStoreError('STORE_ERROR', 'A store key already exists; it is never replaced.', {
    cause,
  });
}

export function malformedKey(): SessionStoreError {
  return new SessionStoreError('STORE_ERROR', 'The store key is malformed; it must be 32 bytes.');
}

export function checkedKey(key: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) throw malformedKey();

  return key;
}

/** In-memory key for tests. */
export class FakeKeyProvider implements KeyProvider {
  readonly backend = 'test';
  readonly keySource = 'memory';
  #key: Uint8Array | undefined;

  constructor(
    key?: Uint8Array,
    readonly keyId = 'test',
  ) {
    this.#key = key;
  }

  async getKey(): Promise<Uint8Array> {
    if (this.#key === undefined) throw keyUnavailable();

    return checkedKey(this.#key);
  }

  async createKey(): Promise<void> {
    if (this.#key !== undefined) throw keyExists();
    this.#key = randomBytes(KEY_BYTES);
  }
}

export type LocalKeyFileOptions = {
  /** The key file, kept in a different directory from the records it protects. */
  path: string;
  /** Recorded in the marker. Default `local`. */
  keyId?: string | undefined;
  /** Test seam: runs after each publication step, so a test can stop the process there. */
  onPublish?: ((step: 'written' | 'linked') => Promise<void> | void) | undefined;
};

/**
 * A raw 32-byte key in an owner-only file, read with the same checks as `readPrivateFile`: a
 * regular, single-link file owned by this user with no group or other permission bits, in store
 * directories that pass `checkStorePaths`.
 */
export class LocalKeyFileProvider implements KeyProvider {
  readonly backend = 'encrypted-file';
  readonly keySource = 'local-file';
  readonly keyId: string;
  /** The key file; never put it in an error message. */
  readonly path: string;
  readonly #onPublish: LocalKeyFileOptions['onPublish'];

  constructor(options: LocalKeyFileOptions) {
    this.path = options.path;
    this.keyId = options.keyId ?? 'local';
    this.#onPublish = options.onPublish;
  }

  async getKey(): Promise<Uint8Array> {
    try {
      await checkStorePaths({ directories: storeDirectories(this.path) });
      await recoverKeyLink(this.path);

      return checkedKey(await readPrivateBytes(this.path, { maxBytes: KEY_BYTES }));
    } catch (error) {
      if (!(error instanceof SessionStoreError)) throw error;

      if (error.code === 'NOT_FOUND') throw keyUnavailable(error);

      if (error.code === 'TOO_LARGE') throw malformedKey();
      throw error;
    }
  }

  /**
   * Write the key to an exclusive temporary, flush it, then `link` it to the key's name, which
   * never replaces an existing key, and remove the temporary. A crash leaves either no key or the
   * whole key, at worst with the temporary as a second name that `getKey` removes.
   */
  async createKey(): Promise<void> {
    const directories = storeDirectories(this.path);
    await checkStorePaths({ directories, create: directories });
    // Excluded and confirmed before the first key byte exists.
    await excludeFromBackups([dirname(this.path)]);
    // A temporary that never became the key holds no key anyone uses; only old ones go.
    await sweepTemp(this.path);
    const temporary = `${this.path}.${randomUUID()}.tmp`;

    try {
      await writeKey(temporary);
      await this.#onPublish?.('written');

      try {
        await link(temporary, this.path);
      } catch (error) {
        if (systemErrorCode(error) === 'EEXIST') throw keyExists(error);
        throw new SessionStoreError('IO', 'Cannot create the store key. Check the key directory.', {
          cause: error,
        });
      }

      await this.#onPublish?.('linked');
    } finally {
      // A temporary left as a second name of the key is removed by the next getKey.
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    await syncDirectory(dirname(this.path));
  }
}

async function writeKey(temporary: string): Promise<void> {
  let handle: FileHandle;

  try {
    handle = await open(temporary, 'wx', 0o600);
  } catch (error) {
    throw new SessionStoreError('IO', 'Cannot create the store key. Check the key directory.', {
      cause: error,
    });
  }

  try {
    await handle.writeFile(randomBytes(KEY_BYTES));
    await handle.sync();
  } catch (error) {
    throw new SessionStoreError('IO', 'Cannot write the store key. Check the disk.', {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

/**
 * The store's own temporary that is a second name of `key` (same device and inode, owned by this
 * user): what a crash between `link` and the temporary's removal leaves. Undefined otherwise.
 */
export async function keyTemporary(key: string, info: Stats): Promise<string | undefined> {
  const uid = process.getuid?.();

  for (const temporary of await temporariesOf(key)) {
    const candidate = await lstatOrMissing(temporary);

    if (
      candidate?.isFile() &&
      candidate.dev === info.dev &&
      candidate.ino === info.ino &&
      (uid === undefined || candidate.uid === uid)
    )
      return temporary;
  }

  return undefined;
}

/**
 * Remove that temporary, so the key has one name again; any other extra link stays refused by the
 * read that follows, which also catches a recovery another process finished first.
 */
async function recoverKeyLink(key: string): Promise<void> {
  const info = await lstatOrMissing(key);

  if (!info?.isFile() || info.nlink !== 2) return;
  const temporary = await keyTemporary(key, info);

  if (temporary === undefined) return;

  try {
    await unlink(temporary);
  } catch (error) {
    if (systemErrorCode(error) !== 'ENOENT')
      throw new SessionStoreError(
        'IO',
        'Cannot remove a temporary file. Check the directory permissions.',
        {
          cause: error,
        },
      );
  }
}
