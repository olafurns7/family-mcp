import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A scratch tree that also holds the store and its key: the record path and the Linux key file
 * follow XDG_CONFIG_HOME and XDG_DATA_HOME, so no test reaches the real home.
 */
export async function scratchHome(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  process.env.XDG_DATA_HOME = join(directory, 'data');

  return {
    directory,
    path: join(directory, 'session.json'),
    record: join(directory, 'config', 'dominos-mcp', 'session.enc'),
    key: join(directory, 'data', 'family-mcp', 'keys', 'dominos-mcp.default.key'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Every file below `directory` whose bytes contain one of `needles`. */
export async function filesContaining(directory: string, needles: string[]): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = (await readFile(join(entry.parentPath, entry.name))).toString('latin1');

    if (needles.some((needle) => text.includes(needle)))
      found.push(join(entry.parentPath, entry.name));
  }

  return found;
}
