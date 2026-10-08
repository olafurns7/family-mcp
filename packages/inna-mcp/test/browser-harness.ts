import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

const root = resolve(import.meta.dir, '..');

export const START_MESSAGE =
  'A browser window is opening. Sign in to Inna with your Google account there; this window closes by itself when you are done.\n';

export const TIMEOUT_MESSAGE =
  'Inna sign-in was not finished in time, and nothing was saved. Run the command again, or use electronic ID (`inna-mcp auth login`) or `inna-mcp auth import`.\n';

export const browserStateSchema = z.object({
  pid: z.number(),
  profile: z.string(),
  profileMode: z.number(),
  transport: z.literal('pipe'),
  args: z.array(z.string()),
});

export const savedSessionSchema = z.object({
  version: z.number(),
  jar: z.string(),
  account: z.object({ userId: z.number(), studentId: z.string(), schoolId: z.string() }),
  token: z.string().optional(),
  tokenRefreshedAt: z.number().optional(),
});

const savedJarSchema = z.object({
  cookies: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      secure: z.boolean().optional(),
    }),
  ),
});

export async function savedCookies(path: string) {
  const saved = savedSessionSchema.parse(JSON.parse(await readFile(path, 'utf8')));

  return savedJarSchema.parse(JSON.parse(saved.jar)).cookies;
}

export async function makeTestDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const temporaryDirectory = join(directory, 'tmp');
  await mkdir(temporaryDirectory);

  return { directory, temporaryDirectory };
}

export async function makeFakeBrowser(directory: string): Promise<string> {
  const path = join(directory, 'fake-chrome');
  const helper = pathToFileURL(join(root, 'test/fake-browser.ts')).href;

  await writeFile(path, `#!${process.execPath}\nimport ${JSON.stringify(helper)};\n`, {
    mode: 0o700,
  });
  await chmod(path, 0o700);

  return path;
}

export async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await stat(path);

      return;
    } catch {
      await Bun.sleep(50);
    }
  }

  throw new Error(`Expected file was not created: ${path}`);
}

export async function waitForBrowserState(path: string) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const parsed = browserStateSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));

      if (parsed.success) return parsed.data;
    } catch {
      // The fake browser writes this marker during startup.
    }

    await Bun.sleep(50);
  }

  throw new Error('The fake browser did not start in time.');
}

async function readPipe(pipe: Bun.Subprocess['stdout']): Promise<string> {
  if (pipe instanceof ReadableStream) return new Response(pipe).text();

  throw new Error('Expected a child-process output pipe.');
}

export async function collectProcess(child: Bun.Subprocess) {
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    readPipe(child.stdout),
    readPipe(child.stderr),
  ]);

  return { exit, stdout, stderr };
}

export function browserEnvironment(
  directory: string,
  temporaryDirectory: string,
  sessionPath: string,
  overrides: Record<string, string> = {},
) {
  return {
    ...process.env,
    INNA_SESSION_FILE: sessionPath,
    // A test that forgets --browser must fail instead of opening the machine's real browser.
    INNA_BROWSER: join(directory, 'no-browser-selected'),
    INNA_FAKE_BROWSER_STATE: join(directory, 'browser.json'),
    INNA_FAKE_BROWSER_EXIT: join(directory, 'browser.closed'),
    INNA_FAKE_BROWSER_SIGNAL: join(directory, 'browser.signal'),
    INNA_FAKE_LAUNCHER: '0',
    INNA_TEST_ORIGIN: '',
    // The Linux display check must not depend on the machine running the tests.
    DISPLAY: ':0',
    TMPDIR: temporaryDirectory,
    ...overrides,
  };
}

export function spawnCli(
  args: string[],
  env: ReturnType<typeof browserEnvironment>,
  preload?: string,
): Bun.Subprocess {
  const command = [process.execPath];

  if (preload) command.push('--preload', preload);
  command.push(join(root, 'src/cli.ts'), ...args);

  return Bun.spawn(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
}

export function spawnLogin(
  browser: string,
  env: ReturnType<typeof browserEnvironment>,
  timeoutSeconds: number,
  preload?: string,
  extra: string[] = [],
): Bun.Subprocess {
  return spawnCli(
    [
      'auth',
      'login',
      '--google',
      '--timeout',
      String(timeoutSeconds),
      '--browser',
      browser,
      ...extra,
    ],
    env,
    preload,
  );
}

// Sends the CLI's nam.inna.is requests to a local synthetic server; anything else fails offline.
export async function makePreload(directory: string): Promise<string> {
  const path = join(directory, 'upstream.js');

  const source = `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  if (url.origin !== 'https://nam.inna.is' || !process.env.INNA_TEST_ORIGIN)
    throw new Error('Tests must not contact live services.');
  return originalFetch(new URL(url.pathname + url.search, process.env.INNA_TEST_ORIGIN), init);
};`;

  await writeFile(path, source);

  return path;
}

export function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

export async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }

  const deadline = Date.now() + 5000;

  while (pidIsRunning(pid) && Date.now() < deadline) await Bun.sleep(25);
}

export async function stopChild(child: Bun.Subprocess | undefined, browserPid?: number) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await child.exited;
  }

  if (browserPid !== undefined && pidIsRunning(browserPid)) await killPid(browserPid);
}
