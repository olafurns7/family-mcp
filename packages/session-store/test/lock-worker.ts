// One locked operation in a separate process, driven by test/processes.test.ts.
// Progress is reported on stdout; failures exit non-zero with the message on stderr.
import { rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import {
  SessionStoreError,
  readPrivateFile,
  withFileLock,
  writePrivateFile,
} from '../src/index.js';

const [mode, file, argument] = process.argv.slice(2);

if (mode === undefined || file === undefined)
  throw new RangeError('Usage: lock-worker MODE FILE [ARGUMENT]');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

async function counter(path: string): Promise<number> {
  try {
    return Number(await readPrivateFile(path, { maxBytes: 64 }));
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return 0;
    throw error;
  }
}

switch (mode) {
  case 'increment': {
    // Read, pause, write: without mutual exclusion concurrent runs lose updates.
    await withFileLock(file, {}, async () => {
      const value = await counter(file);
      await delay(Number(argument ?? '100'));
      await writePrivateFile(file, String(value + 1));
    });

    break;
  }

  case 'hold': {
    if (argument === undefined) throw new RangeError('hold needs a release-file path.');
    await withFileLock(file, {}, async () => {
      process.stdout.write('held\n');

      for (let attempt = 0; attempt < 400 && !(await exists(argument)); attempt++) await delay(25);
    });

    break;
  }

  case 'remove': {
    process.stdout.write('started\n');
    await withFileLock(file, {}, () => rm(file, { force: true }));

    break;
  }

  default:
    throw new RangeError('Unknown lock-worker mode.');
}
