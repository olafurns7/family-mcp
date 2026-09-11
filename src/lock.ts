import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { InfoMentorError, sessionPath, throwIfAborted } from './session.js';

const busy = (): InfoMentorError =>
  new InfoMentorError(
    'OPERATION_IN_PROGRESS',
    'Another process is using this InfoMentor session. Retry after its operation finishes.',
  );

async function removeOwner(directory: string, owner?: string): Promise<void> {
  if (owner)
    try {
      await unlink(join(directory, owner));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }

  try {
    await rmdir(directory);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))
      )
    )
      throw error;
  }
}

/** Coordinates cooperating processes on one host using the same session-file path. */
export async function withSessionLock<T>(
  file: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const absolute = sessionPath(file);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const directory = `${join(await realpath(dirname(absolute)), basename(absolute))}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const temporary = `${directory}.${owner}.tmp`;
  let acquired = false;

  await mkdir(temporary, { mode: 0o700 });

  try {
    await writeFile(join(temporary, owner), '', { mode: 0o600, flag: 'wx', signal });

    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted(signal);
      let permissionError: Error | undefined;

      try {
        // Publishing a complete nonempty directory avoids partially written lock ownership.
        await rename(temporary, directory);
        acquired = true;
        break;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            ['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(String(error.code))
          )
        )
          throw error;

        // Windows can report EPERM for an existing directory. Confirm ownership below.
        if (error.code === 'EPERM') permissionError = error;
      }

      let owners: string[];

      try {
        owners = await readdir(directory);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT' &&
          (!permissionError || attempt < 2)
        )
          continue;
        throw permissionError ?? error;
      }

      // Windows cannot always replace an empty directory, so remove this released shell first.
      if (owners.length === 0) {
        await removeOwner(directory);
        continue;
      }

      const previous = owners.length === 1 ? owners[0] : undefined;
      const match = previous && /^([1-9]\d*)-[\da-f-]{36}$/.exec(previous);
      const pid = Number(match?.[1]);

      if (!previous || !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) throw busy();

      try {
        // Never expire a live PID: collections can be long, and reused PIDs fail safely closed.
        process.kill(pid, 0);
        throw busy();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw busy();
      }

      // Remove only this dead owner's unique filename. A replacement is nonempty, so even
      // competing stale cleaners cannot remove it with rmdir or overwrite it with rename.
      await removeOwner(directory, previous);
    }

    if (!acquired) throw busy();
    throwIfAborted(signal);

    return await action();
  } catch (error) {
    if (error instanceof InfoMentorError) throw error;
    throwIfAborted(signal);
    throw error;
  } finally {
    if (acquired) await removeOwner(directory, owner);
    await rm(temporary, { recursive: true, force: true });
  }
}
