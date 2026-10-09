import { afterAll, beforeEach } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalKeyFileProvider,
  readSecretRecord,
  type SecretRecordOptions,
} from '@family-mcp/session-store';
import { RECORD_MAX_BYTES, parseRecord, type StoredRecord } from '../src/store.js';

export type StoreHome = { home: string; record: string; key: string };

/**
 * Before each test, point the store and its key at a new scratch home: the record path and the
 * Linux key file follow XDG_CONFIG_HOME and XDG_DATA_HOME, so no test reaches the real home or
 * another test's store. CLI child processes inherit these too. Call once per test file.
 */
export function useScratchStore(): StoreHome {
  const store: StoreHome = { home: '', record: '', key: '' };
  let root: string | undefined;

  beforeEach(async () => {
    root ??= await mkdtemp(join(tmpdir(), 'infomentor-store-'));
    store.home = await mkdtemp(join(root, 'home-'));
    process.env['XDG_CONFIG_HOME'] = join(store.home, 'config');
    process.env['XDG_DATA_HOME'] = join(store.home, 'data');
    store.record = join(store.home, 'config', 'infomentor-mcp', 'session.enc');
    store.key = join(store.home, 'data', 'family-mcp', 'keys', 'infomentor-mcp.default.key');
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  return store;
}

/**
 * Point the store at another new scratch home below the current one, for a check that needs a
 * store that has never been used. Returns a function that points it back.
 */
export async function anotherHome(store: StoreHome): Promise<() => void> {
  const previous = { ...store };
  const home = await mkdtemp(join(previous.home, 'another-'));
  Object.assign(store, {
    home,
    record: join(home, 'config', 'infomentor-mcp', 'session.enc'),
    key: join(home, 'data', 'family-mcp', 'keys', 'infomentor-mcp.default.key'),
  });
  process.env['XDG_CONFIG_HOME'] = join(home, 'config');
  process.env['XDG_DATA_HOME'] = join(home, 'data');

  return () => {
    Object.assign(store, previous);
    process.env['XDG_CONFIG_HOME'] = join(previous.home, 'config');
    process.env['XDG_DATA_HOME'] = join(previous.home, 'data');
  };
}

/** The record's options, as the server uses them on Linux. */
export const recordOptions = (store: StoreHome): SecretRecordOptions => ({
  path: store.record,
  server: 'infomentor-mcp',
  profile: 'default',
  purpose: 'session',
  schema: 1,
  keys: new LocalKeyFileProvider({ path: store.key }),
  maxBytes: RECORD_MAX_BYTES,
});

/** The decrypted record, read the way the server reads it. */
export async function readStored(store: StoreHome): Promise<StoredRecord> {
  const value = parseRecord(await readSecretRecord(recordOptions(store)));

  if (!value) throw new Error('The stored record does not match its schema.');

  return value;
}

/** Every file below `directories` whose bytes contain one of `needles`. */
export async function filesContaining(needles: string[], ...directories: string[]) {
  const found: string[] = [];

  for (const directory of directories)
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = (await readFile(join(entry.parentPath, entry.name))).toString('latin1');

      if (needles.some((needle) => text.includes(needle)))
        found.push(join(entry.parentPath, entry.name));
    }

  return found;
}
