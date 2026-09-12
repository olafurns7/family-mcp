import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  link,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SessionStoreError, withFileLock } from '../src/index.js';

const hasCode =
  (code: string) =>
  (cause: unknown): boolean =>
    cause instanceof SessionStoreError && cause.code === code;

const busy = hasCode('BUSY');

const failFast = { waitMs: 0 };

test('locks exclude live owners, recover dead owners safely, and release only their own token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-lock-'));
  const file = join(directory, 'session.json');
  const lock = `${file}.lock`;

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
    stdio: 'ignore',
  });

  const childExit = once(child, 'exit');

  try {
    await once(child, 'spawn');
    assert.ok(child.pid);
    const childOwner = `${child.pid}-${randomUUID()}`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, childOwner), '', { mode: 0o600 });
    await assert.rejects(
      withFileLock(file, failFast, async () => assert.fail()),
      busy,
    );
    assert.deepEqual(await readdir(lock), [childOwner]);

    child.kill();
    await childExit;

    // Concurrent dead-owner recovery must not delete the first newly acquired owner's directory.
    const held = Promise.withResolvers<void>();
    const attemptsFinished = Promise.withResolvers<void>();
    let entered = 0;
    let attempted = 0;

    const attempts = Array.from({ length: 12 }, async () => {
      try {
        return await withFileLock(file, failFast, async () => {
          entered++;
          attempted++;

          if (attempted === 12) attemptsFinished.resolve();
          const owners = await readdir(lock);
          assert.equal(owners.length, 1);
          const [owner] = owners;
          assert.ok(owner);

          if (process.platform !== 'win32') {
            assert.equal((await stat(lock)).mode & 0o777, 0o700);
            assert.equal((await stat(join(lock, owner))).mode & 0o777, 0o600);
          }

          await held.promise;
          await assert.rejects(
            withFileLock(file, failFast, async () => assert.fail()),
            busy,
          );

          return 'collected';
        });
      } catch (error) {
        attempted++;

        if (attempted === 12) attemptsFinished.resolve();
        throw error;
      }
    });

    const settled = Promise.allSettled(attempts);
    await attemptsFinished.promise;
    assert.equal(entered, 1);
    held.resolve();
    const results = await settled;
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);

    for (const result of results) if (result.status === 'rejected') assert.ok(busy(result.reason));
    assert.deepEqual(await readdir(directory), []);

    await assert.rejects(
      withFileLock(file, failFast, async () => {
        throw new Error('Action failed');
      }),
      /Action failed/,
    );
    assert.deepEqual(await readdir(directory), []);

    await mkdir(lock, { mode: 0o700 });
    assert.equal(
      await withFileLock(file, failFast, async () => 'empty recovered'),
      'empty recovered',
    );
    assert.deepEqual(await readdir(directory), []);

    await assert.rejects(
      withFileLock(file, { signal: AbortSignal.abort() }, async () => assert.fail()),
      hasCode('CANCELLED'),
    );
    assert.deepEqual(await readdir(directory), []);

    // Work errors propagate unchanged even when the caller's signal aborted meanwhile.
    const controller = new AbortController();
    await assert.rejects(
      withFileLock(file, { signal: controller.signal }, async () => {
        controller.abort();
        throw new Error('Collection could not confirm restoration of the original child.');
      }),
      /could not confirm restoration/,
    );
    assert.deepEqual(await readdir(directory), []);

    if (process.platform !== 'win32') {
      await mkdir(join(directory, 'real'));
      await symlink('real', join(directory, 'alias'), 'dir');
      await withFileLock(join(directory, 'real', 'session.json'), {}, async () => {
        await assert.rejects(
          withFileLock(join(directory, 'alias', 'session.json'), failFast, async () =>
            assert.fail(),
          ),
          busy,
        );
      });
      await rm(join(directory, 'real'), { recursive: true, force: true });
      await rm(join(directory, 'alias'), { force: true });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childExit;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('waiters poll for a busy lock and a live PID never expires by age', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-wait-'));
  const file = join(directory, 'session.json');
  const lock = `${file}.lock`;

  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const holder = withFileLock(file, {}, async () => {
      entered.resolve();
      await release.promise;

      return 'held';
    });

    await entered.promise;
    const immediate = Date.now();
    await assert.rejects(
      withFileLock(file, failFast, async () => assert.fail()),
      busy,
    );
    expect(Date.now() - immediate).toBeLessThan(1000);

    const bounded = Date.now();
    await assert.rejects(
      withFileLock(file, { waitMs: 200 }, async () => assert.fail()),
      busy,
    );
    const boundedWait = Date.now() - bounded;
    expect(boundedWait).toBeGreaterThanOrEqual(150);
    expect(boundedWait).toBeLessThan(3000);

    const controller = new AbortController();

    const cancelled = assert.rejects(
      withFileLock(file, { signal: controller.signal, waitMs: 10_000 }, async () => assert.fail()),
      hasCode('CANCELLED'),
    );

    await delay(50);
    controller.abort();
    await cancelled;

    const started = Date.now();
    const waiter = withFileLock(file, { waitMs: 10_000 }, async () => 'waited');
    await delay(300);
    release.resolve();
    expect(await holder).toBe('held');
    expect(await waiter).toBe('waited');
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(5000);
    assert.deepEqual(await readdir(directory), []);

    // A live PID remains busy even if an owner file's mtime is arbitrarily old.
    const oldOwner = `${process.pid}-${randomUUID()}`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, oldOwner), '', { mode: 0o600 });
    const old = new Date(Date.now() - 600_000);
    await utimes(join(lock, oldOwner), old, old);
    await assert.rejects(
      withFileLock(file, failFast, async () => assert.fail()),
      busy,
    );
    assert.deepEqual(await readdir(lock), [oldOwner]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('reports in-flight lock loss without deleting the replacement owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-lock-lost-'));
  const file = join(directory, 'session.json');
  const lock = `${file}.lock`;

  try {
    const workStarted = Promise.withResolvers<void>();
    const finishWork = Promise.withResolvers<void>();

    const holder = withFileLock(file, failFast, async () => {
      workStarted.resolve();
      await finishWork.promise;
    });

    await workStarted.promise;
    const [owner] = await readdir(lock);
    assert.ok(owner);

    const replacement = `${process.pid}-${randomUUID()}`;
    await rename(lock, `${lock}.previous`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, replacement), '', { mode: 0o600 });
    finishWork.resolve();

    await assert.rejects(holder, hasCode('LOCK_LOST'));
    assert.deepEqual(await readdir(lock), [replacement]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects hard-linked session targets before running work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-hard-link-'));
  const file = join(directory, 'session.json');
  const alias = join(directory, 'alias.json');

  try {
    await writeFile(file, 'private session', { mode: 0o600 });
    await link(file, alias);
    let workRan = false;

    await assert.rejects(
      withFileLock(file, failFast, async () => {
        workRan = true;
      }),
      hasCode('UNSAFE_FILE'),
    );
    expect(workRan).toBe(false);
    assert.deepEqual((await readdir(directory)).toSorted(), ['alias.json', 'session.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
