import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { writePrivateFile } from '../src/index.js';

const worker = fileURLToPath(new URL('./lock-worker.ts', import.meta.url));

type Outcome = { exit: number | null; out: string; err: string };

type Run = {
  child: ChildProcess;
  outcome: Promise<Outcome>;
  printed: (line: string) => Promise<void>;
};

function start(...args: string[]): Run {
  const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const watchers: (() => void)[] = [];

  const notify = (): void => {
    for (const watcher of watchers.splice(0)) watcher();
  };

  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    notify();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  child.on('close', notify);

  const outcome = once(child, 'close').then(() => ({ exit: child.exitCode, out, err }));

  const printed = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        if (out.includes(`${line}\n`)) resolve();
        else if (child.exitCode !== null)
          reject(new Error('The worker exited before reporting progress.'));
        else watchers.push(check);
      };

      check();
    });

  return { child, outcome, printed };
}

test('separate processes serialize read-modify-write cycles and removal waits for an in-flight holder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-processes-'));
  const signals = await mkdtemp(join(tmpdir(), 'session-store-signals-'));
  const file = join(directory, 'session.json');

  try {
    await writePrivateFile(file, '0');

    const runs = [
      start('increment', file, '150'),
      start('increment', file, '150'),
      start('increment', file, '150'),
    ];

    const results = await Promise.all(runs.map((run) => run.outcome));
    expect(results.map((result) => result.exit)).toEqual([0, 0, 0]);
    expect(results.every((result) => result.err === '')).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('3');
    expect(await readdir(directory)).toEqual(['session.json']);

    const release = join(signals, 'release');
    const holder = start('hold', file, release);
    await holder.printed('held');
    const remover = start('remove', file);
    await remover.printed('started');
    await delay(300);
    expect(await readFile(file, 'utf8')).toBe('3');
    expect(remover.child.exitCode).toBeNull();
    await writeFile(release, '');
    expect((await holder.outcome).exit).toBe(0);
    expect((await remover.outcome).exit).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(signals, { recursive: true, force: true });
  }
}, 30_000);
