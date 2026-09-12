import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as z from 'zod/v4';

import { importCookies, loadSession, saveSession } from '../src/auth.js';
import { findBrowser } from '../src/browser-login.js';

const savedSessionSchema = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string() })),
});

const browserStateSchema = z.object({
  pid: z.number(),
  profile: z.string(),
  profileMode: z.number(),
  transport: z.literal('pipe'),
});

const cookie = {
  name: 'refreshToken',
  value: 'previous-refresh',
  domain: 'www.abler.io',
  path: '/',
  expires: Date.now() / 1000 + 3600,
};

async function makeTestDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const temporaryDirectory = join(directory, 'tmp');
  await mkdir(temporaryDirectory);

  return { directory, temporaryDirectory };
}

async function makeFakeBrowser(directory: string): Promise<string> {
  const path = join(directory, 'fake-chrome');
  const helper = pathToFileURL(resolve('test/fake-browser.ts')).href;

  await writeFile(path, `#!${process.execPath}\nimport ${JSON.stringify(helper)};\n`, {
    mode: 0o700,
  });
  await chmod(path, 0o700);

  return path;
}

async function makeInvalidBrowser(directory: string): Promise<string> {
  const path = join(directory, 'invalid-chrome');
  await writeFile(path, 'not an executable browser', { mode: 0o700 });
  await chmod(path, 0o700);

  return path;
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
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

async function waitForBrowserState(path: string) {
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

async function collectProcess(child: Bun.Subprocess) {
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    readPipe(child.stdout),
    readPipe(child.stderr),
  ]);

  return { exit, stdout, stderr };
}

function browserEnvironment(
  directory: string,
  temporaryDirectory: string,
  sessionPath: string,
  emptyPolls: number,
  overrides: Record<string, string> = {},
) {
  return {
    ...process.env,
    ABLER_SESSION_FILE: sessionPath,
    ABLER_FAKE_BROWSER_STATE: join(directory, 'browser.json'),
    ABLER_FAKE_BROWSER_EXIT: join(directory, 'browser.closed'),
    ABLER_FAKE_BROWSER_SIGNAL: join(directory, 'browser.signal'),
    ABLER_FAKE_EMPTY_POLLS: String(emptyPolls),
    ABLER_FAKE_ID_TOKEN: '1',
    ABLER_FAKE_LAUNCHER: '0',
    ABLER_TEST_ORIGIN: '',
    TMPDIR: temporaryDirectory,
    ...overrides,
  };
}

function spawnLogin(
  browser: string,
  env: ReturnType<typeof browserEnvironment>,
  timeoutSeconds: number,
  preload?: string,
  keepBrowser = false,
): Bun.Subprocess {
  const command = [process.execPath];

  if (preload) command.push('--preload', preload);
  command.push('src/cli.ts', 'auth', 'login', '--timeout', String(timeoutSeconds));

  if (keepBrowser) command.push('--keep-browser');
  command.push('--browser', browser);

  return Bun.spawn(command, {
    cwd: resolve('.'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function makePreload(directory: string): Promise<string> {
  const path = join(directory, 'upstream.js');

  const source = `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  if (url.origin !== 'https://www.abler.io') return originalFetch(input, init);
  return originalFetch(new URL(url.pathname + url.search, process.env.ABLER_TEST_ORIGIN), init);
};`;

  await writeFile(path, source);

  return path;
}

function createUpstream(options: {
  valid: boolean;
  browserStateFile?: string;
  browserExitFile?: string;
  assertBrowserClosed?: boolean;
}) {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);

      if (path === '/oauth/token') {
        if (options.assertBrowserClosed) {
          if (!options.browserStateFile || !options.browserExitFile)
            throw new Error('The browser cleanup assertion is missing its state paths.');

          const state = browserStateSchema.parse(
            JSON.parse(await readFile(options.browserStateFile, 'utf8')),
          );

          expect(await readFile(options.browserExitFile, 'utf8')).toBe('closed');
          await assert.rejects(stat(state.profile), { code: 'ENOENT' });
        }

        if (
          !options.valid ||
          !request.headers.get('cookie')?.includes('refreshToken=private-refresh')
        )
          return Response.json({ error: 'verification failed' }, { status: 401 });

        const response = Response.json({ access_token: 'verified-access' });
        response.headers.append(
          'Set-Cookie',
          'id_token=verified-access; Path=/; Max-Age=600; HttpOnly',
        );
        response.headers.append(
          'Set-Cookie',
          'refreshToken=verified-refresh; Path=/; Max-Age=3600; HttpOnly',
        );

        return response;
      }

      if (path === '/graphql')
        return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });

      return new Response('Not found', { status: 404 });
    },
  });

  return { server, requests };
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }

  const deadline = Date.now() + 5000;

  while (pidIsRunning(pid) && Date.now() < deadline) await Bun.sleep(25);
}

async function savePreviousSession(path: string): Promise<string> {
  await saveSession(path, await importCookies([cookie]));

  return readFile(path, 'utf8');
}

test('browser discovery honors the override and reports all searched choices', async () => {
  const checked: string[] = [];

  const browser = await findBrowser(
    '/fake/Chrome',
    'linux',
    async (path) => {
      checked.push(path);

      return true;
    },
    async () => {
      assert.fail('The PATH lookup should not run when an override is set.');
    },
  );

  expect(browser).toBe('/fake/Chrome');
  expect(checked).toEqual(['/fake/Chrome']);

  const searched: string[] = [];
  await assert.rejects(
    findBrowser(
      undefined,
      'linux',
      async () => false,
      async (command) => {
        searched.push(command);

        return undefined;
      },
    ),
    (error: Error) => {
      expect(error.message).toContain('google-chrome, google-chrome-stable, chromium');
      expect(error.message).toContain("auth capture <URL>' or 'abler-mcp auth import <file>");

      return true;
    },
  );
  expect(searched).toEqual([
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'brave-browser',
    'microsoft-edge',
  ]);
});

test('auth login uses its private CDP pipe', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-private-');
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);

  const upstream = createUpstream({
    valid: true,
    browserStateFile: stateFile,
    browserExitFile: exitFile,
    assertBrowserClosed: true,
  });

  let child: Bun.Subprocess | undefined;

  try {
    child = spawnLogin(
      browser,
      {
        ...browserEnvironment(directory, temporaryDirectory, sessionPath, 1),
        ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.server.port}`,
      },
      20,
      preload,
    );
    const state = await waitForBrowserState(stateFile);
    const { exit, stdout, stderr } = await collectProcess(child);
    const saved = savedSessionSchema.parse(JSON.parse(await readFile(sessionPath, 'utf8')));
    const savedCookies = new Map(saved.cookies.map(({ name, value }) => [name, value]));
    const savedMode = (await stat(sessionPath)).mode & 0o777;
    const jar = await loadSession(sessionPath);

    expect(stderr).toBe('');
    expect(exit).toBe(0);
    expect(stdout).toContain('Sign in to Abler in the browser window that opened.');
    expect(stdout).toContain(`Abler session saved and verified: ${sessionPath}`);
    expect(stdout).not.toMatch(/private-refresh|private-access|verified-refresh|verified-access/);
    expect(saved.cookies.map(({ name }) => name).toSorted()).toEqual(['id_token', 'refreshToken']);
    expect(savedMode).toBe(0o600);
    expect(savedCookies.get('refreshToken')).toBe('verified-refresh');
    expect(savedCookies.get('id_token')).toBe('verified-access');
    expect(await jar.getCookieString('https://www.abler.io')).toContain(
      'refreshToken=verified-refresh',
    );
    expect(upstream.requests).toEqual(['/oauth/token', '/graphql']);
    expect(state.profileMode).toBe(0o700);
    expect(state.transport).toBe('pipe');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(exitFile, 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
    expect(await readdir(sessions)).toEqual(['session.json']);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login closes a launcher-spawned browser child before removing its profile', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-launcher-');
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);

  const upstream = createUpstream({
    valid: true,
    browserStateFile: stateFile,
    browserExitFile: exitFile,
    assertBrowserClosed: true,
  });

  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      {
        ...browserEnvironment(directory, temporaryDirectory, sessionPath, 0, {
          ABLER_FAKE_LAUNCHER: '1',
        }),
        ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.server.port}`,
      },
      20,
      preload,
    );
    state = await waitForBrowserState(stateFile);
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(0);
    expect(stderr).toBe('');
    expect(state.profileMode).toBe(0o700);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(exitFile, 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login timeout closes a launcher-spawned browser child', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory(
    'abler-login-launcher-timeout-',
  );

  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, 999, {
        ABLER_FAKE_LAUNCHER: '1',
      }),
      1,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('Abler login timed out after 1 second.');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --keep-browser exits while the browser and profile remain open', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-keep-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const preload = await makePreload(directory);
  const upstream = createUpstream({ valid: true });
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      {
        ...browserEnvironment(directory, temporaryDirectory, sessionPath, 0),
        ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.server.port}`,
      },
      20,
      preload,
      true,
    );
    state = await waitForBrowserState(stateFile);
    await waitForFile(sessionPath);
    const exit = await Promise.race([child.exited, Bun.sleep(2000).then(() => undefined)]);

    expect(exit).toBe(0);
    expect(state.transport).toBe('pipe');
    expect(pidIsRunning(state.pid)).toBe(true);
    expect((await stat(state.profile)).isDirectory()).toBe(true);
    const [stdout, stderr] = await Promise.all([readPipe(child.stdout), readPipe(child.stderr)]);
    expect(stdout).toContain('Abler session saved and verified:');
    expect(stderr).toContain(
      'Keeping the browser open; its temporary profile contains live Abler credentials and no debugging endpoint is left open.',
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login keeps signal handlers through delayed SIGTERM and SIGKILL cleanup', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-signals-');
  const sessionPath = join(directory, 'session.json');
  const originalFile = await savePreviousSession(sessionPath);
  const browser = await makeFakeBrowser(directory);
  const preload = await makePreload(directory);
  const upstream = createUpstream({ valid: true });
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      {
        ...browserEnvironment(directory, temporaryDirectory, sessionPath, 0, {
          ABLER_FAKE_IGNORE_BROWSER_CLOSE: '1',
          ABLER_FAKE_DELAY_SIGTERM: '1',
        }),
        ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.server.port}`,
      },
      20,
      preload,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    assert.ok(child.pid);
    process.kill(child.pid, 'SIGINT');
    await waitForFile(join(directory, 'browser.signal'));
    process.kill(child.pid, 'SIGINT');
    await Bun.sleep(100);

    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, 'SIGINT');
    await Bun.sleep(150);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    const { exit, stderr, stdout } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('Abler login cancelled.');
    expect(stdout).not.toContain('Abler session saved and verified');
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
    expect(await readFile(join(directory, 'browser.signal'), 'utf8')).toBe('SIGTERM');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login rejects partial cookies and keeps the previous session', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-partial-');
  const sessionPath = join(directory, 'session.json');
  const originalFile = await savePreviousSession(sessionPath);
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, 0, {
        ABLER_FAKE_ID_TOKEN: '0',
      }),
      1,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('Abler login timed out after 1 second.');
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login retains the captured candidate when verification fails', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-verify-');
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const originalFile = await savePreviousSession(sessionPath);
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);

  const upstream = createUpstream({
    valid: false,
    browserStateFile: stateFile,
    browserExitFile: exitFile,
    assertBrowserClosed: true,
  });

  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      {
        ...browserEnvironment(directory, temporaryDirectory, sessionPath, 0),
        ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.server.port}`,
      },
      20,
      preload,
    );
    state = await waitForBrowserState(stateFile);
    const { exit, stderr } = await collectProcess(child);
    const files = await readdir(sessions);
    const pending = files.find((name) => name.endsWith('.pending'));

    expect(exit).toBe(1);
    expect(stderr).toContain('Session verification failed.');
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);

    if (!pending) throw new Error('The failed verification candidate was not retained.');

    const candidate = savedSessionSchema.parse(
      JSON.parse(await readFile(join(sessions, pending), 'utf8')),
    );

    expect(candidate.cookies.map(({ name, value }) => [name, value])).toContainEqual([
      'refreshToken',
      'private-refresh',
    ]);
    expect(candidate.cookies.map(({ name, value }) => [name, value])).toContainEqual([
      'id_token',
      'private-access',
    ]);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(exitFile, 'utf8')).toBe('closed');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login removes the profile when browser readiness fails', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-readiness-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, 0, {
        ABLER_FAKE_BAD_READINESS: '1',
      }),
      20,
      undefined,
      true,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('Could not establish a private Chrome debugging pipe.');
    expect(await readFile(join(directory, 'browser.signal'), 'utf8')).toBe('SIGTERM');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(false);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login removes the profile when the browser exits before readiness', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-early-exit-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, 0, {
        ABLER_FAKE_EXIT_BEFORE_READY: '1',
      }),
      20,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('Could not establish a private Chrome debugging pipe.');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login reports pipe setup failure and removes its profile', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-spawn-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeInvalidBrowser(directory);

  try {
    const { exit, stderr } = await collectProcess(
      spawnLogin(browser, browserEnvironment(directory, temporaryDirectory, sessionPath, 0), 20),
    );

    expect(exit).toBe(1);
    expect(stderr).toContain(
      'Could not establish a private Chrome debugging pipe. Use `abler-mcp auth capture` or `abler-mcp auth import`, or select a Chromium browser with `--browser`.',
    );
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login sweeps abandoned profiles but preserves recent and live profiles', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-sweep-');
  const abandoned = await mkdtemp(join(temporaryDirectory, 'abler-login-abandoned-'));
  const recent = await mkdtemp(join(temporaryDirectory, 'abler-login-recent-'));
  const active = await mkdtemp(join(temporaryDirectory, 'abler-login-active-'));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(abandoned, old, old);
  await symlink(`test-host-${process.pid}`, join(active, 'SingletonLock'));
  await utimes(active, old, old);
  const missingBrowser = join(directory, 'missing-browser');
  const sessionPath = join(directory, 'session.json');

  try {
    const { exit, stderr } = await collectProcess(
      spawnLogin(
        missingBrowser,
        browserEnvironment(directory, temporaryDirectory, sessionPath, 0),
        20,
      ),
    );

    expect(exit).toBe(1);
    expect(stderr).toContain('No Chromium-family browser found.');
    await assert.rejects(stat(abandoned), { code: 'ENOENT' });
    expect((await stat(recent)).isDirectory()).toBe(true);
    expect((await stat(active)).isDirectory()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login errors when an ignored launcher child may still be running', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-orphan-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, 0, {
        ABLER_FAKE_LAUNCHER: '1',
        ABLER_FAKE_IGNORE_BROWSER_CLOSE: '1',
      }),
      20,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stdout, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain(
      'A browser process may still be running; its temporary profile was removed.',
    );
    expect(stdout).not.toContain('Abler session saved and verified');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login rediscovers an Abler tab after its pipe session detaches', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('abler-login-detached-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);

  const upstream = createUpstream({
    valid: true,
    browserStateFile: stateFile,
    browserExitFile: exitFile,
    assertBrowserClosed: true,
  });

  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      {
        ...browserEnvironment(directory, temporaryDirectory, sessionPath, 1, {
          ABLER_FAKE_DETACH_ON_EMPTY_POLL: '1',
        }),
        ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.server.port}`,
      },
      10,
      preload,
    );
    state = await waitForBrowserState(stateFile);
    const { exit, stderr } = await collectProcess(child);
    const saved = savedSessionSchema.parse(JSON.parse(await readFile(sessionPath, 'utf8')));

    expect(exit).toBe(0);
    expect(stderr).toBe('');
    expect(saved.cookies.map(({ name }) => name).toSorted()).toEqual(['id_token', 'refreshToken']);
    expect(upstream.requests).toEqual(['/oauth/token', '/graphql']);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    if (state && pidIsRunning(state.pid)) await killPid(state.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('README marks auth login as 0.5.0+ and documents cleanup order and timeouts', async () => {
  const readme = (await readFile(resolve('README.md'), 'utf8')).replaceAll(/\s+/g, ' ');

  expect(readme).toContain('0.5.0+');
  expect(readme).toContain('0.4.0');
  expect(readme).toContain('15 seconds');
  expect(readme).toContain('--timeout');
  expect(readme).toContain(
    'login confirms the browser is closed before session verification and saving',
  );
  expect(readme).toContain(
    'If closure cannot be confirmed, login exits with an error and still removes the temporary profile',
  );
  expect(readme).toContain('Verification adds network time');
  expect(readme).toContain('abandoned `abler-login-*` profiles older than one hour');
  expect(readme).toContain('`--remote-debugging-pipe`');
  expect(readme).toContain('no debugging endpoint afterwards');
});
