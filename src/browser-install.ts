import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { InfoMentorError, throwIfAborted } from './session.js';

export const installBrowserSchema = z
  .object({
    browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    withDeps: z.boolean().default(false),
  })
  .strict();

export type InstallBrowserOptions = z.input<typeof installBrowserSchema>;

/** Uses this package's Playwright version; installer output never reaches MCP stdout. */
export async function installBrowser(
  options: InstallBrowserOptions = {},
  signal?: AbortSignal,
  onOutput?: (text: string) => void,
): Promise<void> {
  throwIfAborted(signal);
  const { browser, withDeps } = installBrowserSchema.parse(options);
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('playwright/package.json');

  const manifest = z
    .object({ bin: z.object({ playwright: z.string() }) })
    .parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  const child = spawn(
    process.execPath,
    [
      resolve(dirname(manifestPath), manifest.bin.playwright),
      'install',
      ...(withDeps ? ['--with-deps'] : []),
      browser,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
      // A private process group lets cancellation reach Playwright's shell/download children.
      detached: process.platform !== 'win32',
    },
  );

  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => onOutput?.(chunk.toString()));
  }

  const finished = new Promise<number | null>((resolveExit) => {
    // Spawn failures also emit close; wait for inherited output streams to close, too.
    child.once('error', () => {});
    child.once('close', resolveExit);
  });

  let stopping: Promise<void> | undefined;

  const cancel = (): void => {
    if (child.pid === undefined) return;
    stopping = stopInstaller(child.pid);
    void stopping.catch(() => {}); // Observed below after the child and its streams close.
  };

  signal?.addEventListener('abort', cancel, { once: true });

  if (signal?.aborted) cancel();

  try {
    const code = await finished;
    await stopping;

    throwIfAborted(signal);

    if (code !== 0) throw new Error('Installer failed');
  } catch {
    throwIfAborted(signal);
    throw new InfoMentorError(
      'BROWSER_UNAVAILABLE',
      'Browser installation failed. Check network access and disk space. Installing Linux system dependencies requires administrator access on the host.',
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function stopInstaller(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolveExit, reject) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', (code) =>
        code === 0 ? resolveExit() : reject(new Error('Could not stop the installer process tree')),
      );
    });

    return;
  }

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }

    if (signal === 'SIGTERM') await delay(1_000);
  }
}
