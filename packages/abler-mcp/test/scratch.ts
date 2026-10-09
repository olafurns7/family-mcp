import { afterAll, beforeEach } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    root ??= await mkdtemp(join(tmpdir(), 'abler-store-'));
    store.home = await mkdtemp(join(root, 'home-'));
    process.env.XDG_CONFIG_HOME = join(store.home, 'config');
    process.env.XDG_DATA_HOME = join(store.home, 'data');
    store.record = join(store.home, 'config', 'abler-mcp', 'session.enc');
    store.key = join(store.home, 'data', 'family-mcp', 'keys', 'abler-mcp.default.key');
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  return store;
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
