// One TypeScript session-store operation in a separate process, driven by tests/interop.rs.
// Prints `value:<text>`, `none` or `error:<CODE>` on stdout; anything unexpected exits non-zero.
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  LocalKeyFileProvider,
  SessionStoreError,
  createSecretKey,
  readSecretRecord,
  withSecretRecord,
  withSecretStore,
} from '../../../../packages/session-store/src/index.ts';

const [mode, record, key, ...rest] = process.argv.slice(2);

if (mode === undefined || record === undefined || key === undefined)
  throw new RangeError('Usage: store.ts MODE RECORD KEY [ARGUMENT...]');

// The store stays in the test's scratch directories, with the store test seam on.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');

const options = {
  path: record,
  server: 'test-mcp',
  profile: 'default',
  purpose: 'session',
  schema: 1,
  keys: new LocalKeyFileProvider({ path: key }),
  maxBytes: 1024,
};

const argument = (at: number): string => {
  const value = rest[at];

  if (value === undefined) throw new RangeError(`${mode} needs argument ${at + 1}.`);

  return value;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

async function run(): Promise<string | null> {
  switch (mode) {
    case 'create-key':
      await createSecretKey(options);

      return null;

    case 'read':
      return await readSecretRecord(options);

    // write VALUE [WAIT_MS]
    case 'write':
      return withSecretRecord(
        { ...options, waitMs: rest[1] === undefined ? undefined : Number(rest[1]) },
        async () => argument(0),
      );

    // Read, pause, write: without mutual exclusion concurrent runs lose updates.
    case 'increment':
      return withSecretRecord(options, async (current) => {
        await delay(Number(argument(0)));

        return String(Number(current ?? '0') + 1);
      });

    // Hold the record lock until the release file appears.
    case 'hold':
      return withSecretStore(options, async () => {
        process.stdout.write('held\n');

        for (let attempt = 0; attempt < 2400 && !(await exists(argument(0))); attempt++)
          await delay(25);

        return null;
      });

    // A write whose record cannot be replaced: it stops after its pending marker.
    case 'blocked-write':
      return withSecretStore(options, async (store) => {
        const current = await store.read();
        const aside = `${record}.aside`;

        if (current !== null) await rename(record, aside);
        await mkdir(join(record, 'blocked'), { recursive: true });

        try {
          await store.write(argument(0));
        } finally {
          await rm(record, { recursive: true });

          if (current !== null) await rename(aside, record);
        }

        return current;
      });

    default:
      throw new RangeError('Unknown store.ts mode.');
  }
}

try {
  const value = await run();
  process.stdout.write(value === null ? 'none\n' : `value:${value}\n`);
} catch (error) {
  if (!(error instanceof SessionStoreError)) throw error;
  process.stdout.write(`error:${error.code}\n`);
}
