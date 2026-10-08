// One encrypted read-modify-write in a separate process, driven by test/secret.test.ts.
import { setTimeout as delay } from 'node:timers/promises';

import { LocalKeyFileProvider, withSecretRecord } from '../src/index.js';

const [record, key, pause] = process.argv.slice(2);

if (record === undefined || key === undefined)
  throw new RangeError('Usage: secret-worker RECORD KEY [PAUSE_MS]');

// Read, pause, write: without mutual exclusion concurrent runs lose updates.
await withSecretRecord(
  {
    path: record,
    server: 'test-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    keys: new LocalKeyFileProvider({ path: key }),
    maxBytes: 64,
  },
  async (current) => {
    await delay(Number(pause ?? '100'));

    return String(Number(current ?? '0') + 1);
  },
);
