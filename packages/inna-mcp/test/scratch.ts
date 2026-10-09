import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalKeyFileProvider,
  readSecretRecord,
  withSecretRecord,
  withSecretStore,
  type KeyProvider,
} from '@family-mcp/session-store';
import { RECORD_MAX_BYTES } from '../src/client.js';

export type Store = { path: string; keys: KeyProvider };

/** The variables that put the default record and its key file below `home`, on macOS through the store test seam. */
export function storeEnvironment(home: string) {
  return {
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    FAMILY_MCP_STORE_TEST_SEAM: '1',
  };
}

// A client built without the store seam must never reach the real home.
Object.assign(process.env, storeEnvironment(mkdtempSync(join(tmpdir(), 'inna-store-unused-'))));

/** The store a CLI child run with `storeEnvironment(home)` uses on Linux, for in-process clients. */
export function storeAt(home: string): Store & { key: string } {
  const key = join(home, 'data', 'family-mcp', 'keys', 'inna-mcp.default.key');

  return {
    path: join(home, 'config', 'inna-mcp', 'session.enc'),
    keys: new LocalKeyFileProvider({ path: key }),
    key,
  };
}

function recordOptions(store: Store) {
  return {
    path: store.path,
    keys: store.keys,
    server: 'inna-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    maxBytes: RECORD_MAX_BYTES,
  };
}

/** The record's decrypted plaintext, read with the binding the client must have written. */
export function readStored(store: Store): Promise<string> {
  return readSecretRecord(recordOptions(store));
}

/** Replace the record's plaintext, as the client would after a change. */
export async function updateStored(store: Store, update: (text: string) => string) {
  await withSecretRecord(recordOptions(store), async (text) => update(text ?? 'null'));
}

/** A lost key's store as an interrupted sign-in leaves it: a marker, a new key, and no record. */
export async function resetStored(store: Store) {
  await withSecretStore(recordOptions(store), async (held) => {
    await held.reset();
    await held.createKey();
  });
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
