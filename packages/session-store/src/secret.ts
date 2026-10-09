import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';

import { SessionStoreError, systemErrorCode, throwIfAborted } from './errors.js';
import { readPrivateFile, sweepTemp, writePrivateFile } from './files.js';
import { checkedKey, type KeyProvider } from './keys.js';
import { withFileLock } from './lock.js';

export type SecretRecordOptions = {
  /** Canonical record path. Its lock is `<path>.lock` and its non-secret marker `<path>.marker`. */
  path: string;
  server: string;
  profile: string;
  /** What the record holds, such as `session`; a record never opens under another purpose. */
  purpose: string;
  /** Version of the plaintext's own format, a positive integer. */
  schema: number;
  keys: KeyProvider;
  /** Largest accepted plaintext in UTF-8 bytes. */
  maxBytes: number;
  /** Aborts waiting for the lock or before `update` runs; a started write always completes. */
  signal?: AbortSignal | undefined;
  /** Longest wait for a busy lock. Default 30 s. */
  waitMs?: number | undefined;
};

/** Returns the next plaintext to store, or undefined to leave the record unchanged. */
export type SecretUpdate = (current: string | null) => Promise<string | undefined>;

/** A store whose record lock is already held, from `withSecretStore`. Nothing locks again. */
export type SecretStore = {
  /** True once a marker exists: the store then decides, also while it holds no record. */
  exists(): Promise<boolean>;
  /** The committed plaintext, or null while the store holds no record. */
  read(): Promise<string | null>;
  /**
   * Commit `next` as the next generation: pending marker, record, authenticated read-back, marker
   * commit. Any failure ends the handle; one after a file changed is STORE_WRITE_UNCERTAIN.
   */
  write(next: string): Promise<void>;
  /** `withSecretRecord`'s transaction. */
  update(update: SecretUpdate): Promise<string | null>;
  /** `createSecretKey`'s setup. */
  createKey(): Promise<void>;
  /** `resetSecretStore`'s recovery. */
  reset(): Promise<void>;
};

type Marker = {
  backend: string;
  keySource: string;
  keyId: string;
  profile: string;
  migrated: boolean;
  generation: number;
  pending?: { generation: number; nonce: string } | undefined;
};

type SealedRecord = { nonce: string; text: string };

type OpenedRecord = { generation: number; nonce: string; plaintext: Buffer };

const NONCE_BYTES = 12;

const TAG_BYTES = 16;

const HEADER_MAX_BYTES = 512;

const MARKER_MAX_BYTES = 1024;

// Headers and markers are canonical JSON over restricted names, so a strict pattern parses them.
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

const INTEGER = '(0|[1-9]\\d{0,14})';

// The largest value INTEGER parses; schemas and generations stay within it.
const MAX_INTEGER = 999_999_999_999_999;

const NONCE = '([A-Za-z0-9_-]{16})';

const NAME_PATTERN = new RegExp(`^${NAME}$`);

const HEADER_PATTERN = new RegExp(
  `^\\{"v":1,"server":"(${NAME})","profile":"(${NAME})","purpose":"(${NAME})","schema":${INTEGER},"generation":${INTEGER},"keyId":"(${NAME})","nonce":"${NONCE}"\\}$`,
);

const MARKER_PATTERN = new RegExp(
  `^\\{"backend":"(${NAME})","keySource":"(${NAME})","keyId":"(${NAME})","profile":"(${NAME})","migrated":(true|false),"generation":${INTEGER}(?:,"pending":\\{"generation":${INTEGER},"nonce":"${NONCE}"\\})?\\}\\n$`,
);

const BASE64URL_PATTERN = /^[\w-]+$/;

/**
 * Hold the record's lock for all of `work`, so a caller can decide, read, set up and write in one
 * critical section. A caller that also holds another lock always takes that one first. The handle
 * stops working when `work` settles or after a failed write.
 */
export async function withSecretStore<T>(
  options: SecretRecordOptions,
  work: (store: SecretStore) => Promise<T>,
): Promise<T> {
  checkOptions(options);

  return withFileLock(
    options.path,
    { signal: options.signal, waitMs: options.waitMs },
    async () => {
      let ended: SessionStoreError | undefined;
      // The key and the marker as of the last read or write in this hold.
      let state: { key: Uint8Array; marker: Marker | null } | undefined;

      const usable = () => {
        if (ended !== undefined) throw ended;
      };

      const open = async () => {
        usable();
        await sweepTemp(options.path);
        const key = state?.key ?? checkedKey(await options.keys.getKey(options.signal));
        const { current, marker } = await load(options, key);
        state = { key, marker };

        return { current: current?.toString('utf8') ?? null, key, marker };
      };

      const write = async (next: string): Promise<void> => {
        usable();

        try {
          const { key, marker } = state ?? (await open());
          checkGenerationLeft(marker);
          state = { key, marker: await store(options, key, marker, next) };
        } catch (error) {
          // Errors before any file changed keep their code; later ones are already uncertain.
          ended = error instanceof SessionStoreError ? error : uncertain(error);
          throw error;
        }
      };

      // Setup and recovery change the key or the files, so the next read or write loads again.
      const changing = async (change: () => Promise<void>): Promise<void> => {
        usable();
        state = undefined;
        await change();
      };

      try {
        return await work({
          exists: async () => {
            usable();

            return secretStoreExists(options.path);
          },
          read: async () => (await open()).current,
          write,
          update: async (update) => {
            const { current, marker } = await open();
            checkGenerationLeft(marker);
            throwIfAborted(options.signal);
            const next = await update(current);

            if (next === undefined) return current;
            await write(next);

            return next;
          },
          createKey: () => changing(() => createKey(options)),
          reset: () => changing(() => reset(options)),
        });
      } finally {
        ended = new SessionStoreError('STORE_ERROR', 'This secret store hold has ended.');
      }
    },
  );
}

/**
 * Run `update` on the decrypted record while holding the record's lock, and store its result as
 * the next generation. Returns the stored plaintext, or null when the store holds no record.
 */
export function withSecretRecord(
  options: SecretRecordOptions,
  update: SecretUpdate,
): Promise<string | null> {
  return withSecretStore(options, (held) => held.update(update));
}

/** Read the record; a store that conclusively holds none throws SECRET_NOT_FOUND. */
export async function readSecretRecord(options: SecretRecordOptions): Promise<string> {
  const current = await withSecretRecord(options, async () => undefined);

  if (current === null)
    throw new SessionStoreError('SECRET_NOT_FOUND', 'No secret is stored for this profile.');

  return current;
}

/**
 * Explicit setup: create the key while there is no record, and either no marker or a
 * generation-0 marker without a pending write (a reset or never-written store) whose key is
 * conclusively missing.
 */
export function createSecretKey(options: SecretRecordOptions): Promise<void> {
  return withSecretStore(options, (held) => held.createKey());
}

/**
 * Explicit re-setup after a lost key: only while `getKey` still reports STORE_UNAVAILABLE under
 * the record lock, commit a fresh generation-0 marker first and then remove the record, which
 * nothing can decrypt anymore. The marker stays, so the store keeps deciding after a crash at any
 * later point. The caller then runs `createSecretKey` and writes. Any other key outcome leaves
 * both files untouched.
 */
export function resetSecretStore(options: SecretRecordOptions): Promise<void> {
  return withSecretStore(options, (held) => held.reset());
}

/** A marker exists, so the store decides even while it holds no record. */
export function secretStoreExists(path: string): Promise<boolean> {
  return exists(markerPath(path));
}

/** Server, profile and key names: 1-64 letters, digits, dots, dashes or underscores. */
export function checkNames(...names: string[]): void {
  for (const name of names)
    if (!NAME_PATTERN.test(name))
      throw new RangeError(
        'Store names must be 1-64 letters, digits, dots, dashes or underscores.',
      );
}

function checkOptions(options: SecretRecordOptions): void {
  const { keys } = options;

  checkNames(
    options.server,
    options.profile,
    options.purpose,
    keys.backend,
    keys.keySource,
    keys.keyId,
  );

  if (!Number.isSafeInteger(options.schema) || options.schema < 1 || options.schema > MAX_INTEGER)
    throw new RangeError('schema must be a positive integer of at most 15 digits.');

  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new RangeError('maxBytes must be a non-negative integer.');
}

function checkGenerationLeft(marker: Marker | null): void {
  if ((marker?.generation ?? 0) >= MAX_INTEGER)
    throw new SessionStoreError('STORE_ERROR', 'The secret store has no generation left.');
}

async function createKey(options: SecretRecordOptions): Promise<void> {
  const marker = await readMarker(options);

  if (
    (await exists(options.path)) ||
    (marker !== null &&
      (marker.generation !== 0 || marker.pending !== undefined || !(await keyMissing(options))))
  )
    throw new SessionStoreError(
      'STORE_ERROR',
      'The secret store is already set up; its key is never replaced.',
    );
  await options.keys.createKey(options.signal);
}

async function reset(options: SecretRecordOptions): Promise<void> {
  if (!(await keyMissing(options)))
    throw new SessionStoreError(
      'STORE_ERROR',
      'The store key is available; a readable secret store is never reset.',
    );
  const { keys } = options;

  // The fresh marker commits before the record goes, so no crash leaves a store without one.
  await writePrivateFile(
    markerPath(options.path),
    encodeMarker({
      backend: keys.backend,
      keySource: keys.keySource,
      keyId: keys.keyId,
      profile: options.profile,
      migrated: false,
      generation: 0,
    }),
  );

  try {
    await rm(options.path, { force: true });
  } catch (cause) {
    throw new SessionStoreError('IO', 'Cannot remove the secret record. Check its permissions.', {
      cause,
    });
  }

  await sweepTemp(options.path);
}

/** True only for STORE_UNAVAILABLE; a readable key is false and every other failure propagates. */
async function keyMissing(options: SecretRecordOptions): Promise<boolean> {
  try {
    checkedKey(await options.keys.getKey(options.signal));

    return false;
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'STORE_UNAVAILABLE') return true;
    throw error;
  }
}

async function load(
  options: SecretRecordOptions,
  key: Uint8Array,
): Promise<{ current: Buffer | null; marker: Marker | null }> {
  const marker = await readMarker(options);
  const record = await readRecord(options, key);

  if (marker === null) {
    // The first write records a pending marker before its record, so a lone record is suspect.
    if (record !== null) throw uncertain();

    return { current: null, marker: null };
  }

  // Only committed writes mark a store migrated, and every committed generation is at least 1.
  if (marker.migrated !== marker.generation > 0) throw uncertain();
  const { pending } = marker;

  if (pending !== undefined) {
    if (pending.generation !== marker.generation + 1) throw uncertain();

    // A record at the announced generation and nonce is the interrupted write: commit it.
    if (record?.generation === pending.generation && record.nonce === pending.nonce) {
      const committed = {
        ...marker,
        migrated: true,
        generation: record.generation,
        pending: undefined,
      };

      await writePrivateFile(markerPath(options.path), encodeMarker(committed));

      return { current: record.plaintext, marker: committed };
    }

    // The lock never expires a live holder, so a record still at the committed generation (or
    // still absent before a first write) means that write never committed and cannot land later.
    if (record === null ? marker.generation === 0 : record.generation === marker.generation) {
      const kept = { ...marker, pending: undefined };
      await writePrivateFile(markerPath(options.path), encodeMarker(kept));

      return { current: record?.plaintext ?? null, marker: kept };
    }

    throw uncertain();
  }

  if (record === null) {
    // Only a first write that never committed leaves a generation-0 marker without a record.
    if (marker.generation === 0) return { current: null, marker };
    throw uncertain();
  }

  if (record.generation !== marker.generation) throw uncertain();

  return { current: record.plaintext, marker };
}

async function store(
  options: SecretRecordOptions,
  key: Uint8Array,
  marker: Marker | null,
  next: string,
): Promise<Marker> {
  const plaintext = Buffer.from(next, 'utf8');

  if (plaintext.length > options.maxBytes)
    throw new SessionStoreError('TOO_LARGE', 'The secret is larger than allowed.');
  const generation = (marker?.generation ?? 0) + 1;
  const sealed = seal(options, key, generation, plaintext);
  const path = markerPath(options.path);

  const committed: Marker = {
    backend: options.keys.backend,
    keySource: options.keys.keySource,
    keyId: options.keys.keyId,
    profile: options.profile,
    migrated: true,
    generation,
  };

  // Until the pending marker is renamed into place nothing has changed.
  await writePrivateFile(
    path,
    encodeMarker({
      ...committed,
      migrated: marker?.migrated ?? false,
      generation: generation - 1,
      pending: { generation, nonce: sealed.nonce },
    }),
  );

  try {
    await writePrivateFile(options.path, sealed.text);
    const written = await readRecord(options, key);

    if (
      written?.generation !== generation ||
      written.nonce !== sealed.nonce ||
      !written.plaintext.equals(plaintext)
    )
      throw uncertain();
    await writePrivateFile(path, encodeMarker(committed));
  } catch (error) {
    throw error instanceof SessionStoreError && error.code === 'STORE_WRITE_UNCERTAIN'
      ? error
      : uncertain(error);
  }

  return committed;
}

function seal(
  options: SecretRecordOptions,
  key: Uint8Array,
  generation: number,
  plaintext: Buffer,
): SealedRecord {
  const nonce = randomBytes(NONCE_BYTES);

  // Key order is fixed: these exact bytes are the authenticated data.
  const header = JSON.stringify({
    v: 1,
    server: options.server,
    profile: options.profile,
    purpose: options.purpose,
    schema: options.schema,
    generation,
    keyId: options.keys.keyId,
    nonce: nonce.toString('base64url'),
  });

  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(header, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  return { nonce: nonce.toString('base64url'), text: `${header}\n${body.toString('base64url')}\n` };
}

/** Authenticate a record and check every binding before any plaintext leaves this function. */
function openRecord(options: SecretRecordOptions, key: Uint8Array, text: string): OpenedRecord {
  const lines = text.split('\n');
  const [header, body, end] = lines;

  if (lines.length !== 3 || header === undefined || body === undefined || end !== '')
    throw unauthenticated();
  const match = HEADER_PATTERN.exec(header);

  if (match === null) throw unauthenticated();
  const [, server, profile, purpose, schema, generation, keyId, nonce] = match;

  if (
    server !== options.server ||
    profile !== options.profile ||
    purpose !== options.purpose ||
    Number(schema) !== options.schema ||
    keyId !== options.keys.keyId ||
    nonce === undefined ||
    Number(generation) < 1
  )
    throw unauthenticated();
  const sealed = Buffer.from(body, 'base64url');

  if (
    !BASE64URL_PATTERN.test(body) ||
    sealed.toString('base64url') !== body ||
    sealed.length < TAG_BYTES ||
    sealed.length > options.maxBytes + TAG_BYTES
  )
    throw unauthenticated();

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'), {
      authTagLength: TAG_BYTES,
    });

    decipher.setAAD(Buffer.from(header, 'utf8'));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return { generation: Number(generation), nonce, plaintext };
  } catch (error) {
    throw unauthenticated(error);
  }
}

async function readRecord(
  options: SecretRecordOptions,
  key: Uint8Array,
): Promise<OpenedRecord | null> {
  // Header, separator, unpadded base64url of ciphertext and tag, final newline.
  const maxBytes = HEADER_MAX_BYTES + Math.ceil(((options.maxBytes + TAG_BYTES) * 4) / 3) + 2;
  let text: string;

  try {
    text = await readPrivateFile(options.path, { maxBytes });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return null;
    throw error;
  }

  return openRecord(options, key, text);
}

async function readMarker(options: SecretRecordOptions): Promise<Marker | null> {
  let text: string;

  try {
    text = await readPrivateFile(markerPath(options.path), { maxBytes: MARKER_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return null;
    throw error;
  }

  const match = MARKER_PATTERN.exec(text);

  if (match === null)
    throw new SessionStoreError('STORE_ERROR', 'The secret store marker is malformed.');
  const [, backend, keySource, keyId, profile, migrated, generation, pending, nonce] = match;
  const { keys } = options;

  if (
    backend !== keys.backend ||
    keySource !== keys.keySource ||
    keyId !== keys.keyId ||
    profile !== options.profile
  )
    throw new SessionStoreError(
      'STORE_ERROR',
      'The secret store marker does not match the configured key or profile.',
    );

  return {
    backend,
    keySource,
    keyId,
    profile,
    migrated: migrated === 'true',
    generation: Number(generation),
    pending:
      pending === undefined || nonce === undefined
        ? undefined
        : { generation: Number(pending), nonce },
  };
}

function encodeMarker(marker: Marker): string {
  const { backend, keySource, keyId, profile, migrated, generation, pending } = marker;

  return `${JSON.stringify({ backend, keySource, keyId, profile, migrated, generation, pending })}\n`;
}

function markerPath(path: string): string {
  return `${path}.marker`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return false;
    throw new SessionStoreError('IO', 'Cannot inspect the secret store. Check its permissions.', {
      cause: error,
    });
  }
}

function unauthenticated(cause?: unknown): SessionStoreError {
  return new SessionStoreError(
    'STORE_ERROR',
    'The stored secret could not be authenticated with the configured key.',
    { cause },
  );
}

function uncertain(cause?: unknown): SessionStoreError {
  return new SessionStoreError(
    'STORE_WRITE_UNCERTAIN',
    'The last write to the secret store did not complete consistently; its secret is not used.',
    { cause },
  );
}
