import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
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
      ...(signal ? { signal } : {}),
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => onOutput?.(chunk.toString()));
  }
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    throwIfAborted(signal);
    if (code !== 0) throw new Error('Installer failed');
  } catch {
    throwIfAborted(signal);
    throw new InfoMentorError(
      'BROWSER_UNAVAILABLE',
      'Browser installation failed. Check network access and disk space. Installing Linux system dependencies requires administrator access on the host.',
    );
  }
}
