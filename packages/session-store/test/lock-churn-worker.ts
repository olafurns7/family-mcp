// Keeps handing the lock at FILE to a dead owner PID until killed, driven by test/lock.test.ts.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [file, deadPid] = process.argv.slice(2);

if (file === undefined || deadPid === undefined)
  throw new RangeError('Usage: lock-churn-worker FILE DEAD_PID');

const lock = `${file}.lock`;

process.stdout.write('churning\n');

for (;;) {
  const owner = `${deadPid}-${randomUUID()}`;
  const temporary = `${lock}-churn.${owner}`;
  await mkdir(temporary, { mode: 0o700 });
  await writeFile(join(temporary, owner), '', { mode: 0o600 });

  try {
    await rename(temporary, lock);
  } catch {
    await rm(temporary, { recursive: true, force: true });
  }
}
