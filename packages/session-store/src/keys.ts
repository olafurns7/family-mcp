import { randomBytes } from 'node:crypto';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SessionStoreError, systemErrorCode } from './errors.js';
import { ensurePrivateDir, readPrivateBytes, syncDirectory } from './files.js';

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
};

/**
 * A raw 32-byte key in an owner-only file, read with the same checks as `readPrivateFile`: a
 * regular, single-link file owned by this user with no group or other permission bits.
 */
export class LocalKeyFileProvider implements KeyProvider {
  readonly backend = 'encrypted-file';
  readonly keySource = 'local-file';
  readonly keyId: string;
  /** The key file; never put it in an error message. */
  readonly path: string;

  constructor(options: LocalKeyFileOptions) {
    this.path = options.path;
    this.keyId = options.keyId ?? 'local';
  }

  async getKey(): Promise<Uint8Array> {
    try {
      return checkedKey(await readPrivateBytes(this.path, { maxBytes: KEY_BYTES }));
    } catch (error) {
      if (!(error instanceof SessionStoreError)) throw error;

      if (error.code === 'NOT_FOUND') throw keyUnavailable(error);

      if (error.code === 'TOO_LARGE') throw malformedKey();
      throw error;
    }
  }

  async createKey(): Promise<void> {
    await ensurePrivateDir(dirname(this.path), { enforceMode: true });
    let handle: FileHandle;

    try {
      handle = await open(this.path, 'wx', 0o600);
    } catch (error) {
      if (systemErrorCode(error) === 'EEXIST') throw keyExists(error);
      throw new SessionStoreError('IO', 'Cannot create the store key. Check the key directory.', {
        cause: error,
      });
    }

    try {
      await handle.writeFile(randomBytes(KEY_BYTES));
      await handle.sync();
    } catch (error) {
      // Nothing was encrypted with a partial key yet, so it is not left behind as malformed.
      await rm(this.path, { force: true });
      throw new SessionStoreError('IO', 'Cannot write the store key. Check the disk.', {
        cause: error,
      });
    } finally {
      await handle.close();
    }

    await syncDirectory(dirname(this.path));
  }
}
