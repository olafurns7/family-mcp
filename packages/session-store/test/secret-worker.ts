// Encrypted read-modify-write in a separate process, driven by test/secret.test.ts.
import { setTimeout as delay } from 'node:timers/promises';

import { LocalKeyFileProvider, withSecretRecord, withSecretStore } from '../src/index.js';

const [record, key, pause, mode = 'record'] = process.argv.slice(2);

if (record === undefined || key === undefined)
  throw new RangeError('Usage: secret-worker RECORD KEY [PAUSE_MS] [record|store]');

const options = {
  path: record,
  server: 'test-mcp',
  profile: 'default',
  purpose: 'session',
  schema: 1,
  keys: new LocalKeyFileProvider({ path: key }),
  maxBytes: 64,
};

// Read, pause, write: without mutual exclusion concurrent runs lose updates.
if (mode === 'record')
  await withSecretRecord(options, async (current) => {
    await delay(Number(pause ?? '100'));

    return String(Number(current ?? '0') + 1);
  });
// Two writes in one hold with a pause between them; `written` lets a test kill it there.
else
  await withSecretStore(options, async (store) => {
    const current = Number((await store.read()) ?? '0');
    await store.write(String(current + 1));
    process.stdout.write('written\n');
    await delay(Number(pause ?? '100'));
    await store.write(String(current + 2));
  });
