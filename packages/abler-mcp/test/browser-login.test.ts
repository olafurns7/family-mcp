import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
});

const cookie = {
  name: 'refreshToken',
  value: 'previous-refresh',
  domain: 'www.abler.io',
  path: '/',
  expires: Date.now() / 1000 + 3600,
};

async function makeFakeBrowser(directory: string): Promise<string> {
  const path = join(directory, 'fake-chrome');
  const helper = pathToFileURL(resolve('test/cdp-mock.ts')).href;

  await writeFile(
    path,
    `#!${process.execPath}
import { stat, writeFile } from 'node:fs/promises';
import { createCdpMock } from ${JSON.stringify(helper)};

const port = Number(process.argv.find((arg) => arg.startsWith('--remote-debugging-port='))?.split('=')[1]);
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const stateFile = process.env.ABLER_FAKE_BROWSER_STATE;
const exitFile = process.env.ABLER_FAKE_BROWSER_EXIT;
if (!port || !profile || !stateFile || !exitFile) throw new Error('Fake browser arguments are missing.');

const mock = createCdpMock({
  port,
  emptyPolls: Number(process.env.ABLER_FAKE_EMPTY_POLLS),
  includeIdToken: process.env.ABLER_FAKE_ID_TOKEN === '1',
});
await writeFile(stateFile, JSON.stringify({
  pid: process.pid,
  profile,
  profileMode: (await stat(profile)).mode & 0o777,
}));
process.on('SIGTERM', async () => {
  await mock.server.stop(true);
  await writeFile(exitFile, 'closed');
  process.exit(0);
});
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);

  return path;
}

async function waitForBrowserState(path: string) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const parsed = browserStateSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));

      if (parsed.success) return parsed.data;
    } catch {
      // The browser writes this marker during startup.
    }

    await Bun.sleep(50);
  }

  throw new Error('The fake browser did not start in time.');
}

async function readPipe(pipe: Bun.Subprocess['stdout']): Promise<string> {
  if (pipe instanceof ReadableStream) return new Response(pipe).text();

  throw new Error('Expected a child-process output pipe.');
}

function browserEnvironment(directory: string, sessionPath: string, emptyPolls: number) {
  return {
    ...process.env,
    ABLER_SESSION_FILE: sessionPath,
    ABLER_FAKE_BROWSER_STATE: join(directory, 'browser.json'),
    ABLER_FAKE_BROWSER_EXIT: join(directory, 'browser.closed'),
    ABLER_FAKE_EMPTY_POLLS: String(emptyPolls),
    ABLER_FAKE_ID_TOKEN: '1',
  };
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
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

test('auth login captures, verifies, saves, and removes its temporary browser profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-login-test-'));
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const preload = join(directory, 'upstream.js');
  const browser = await makeFakeBrowser(directory);
  const original = await importCookies([cookie]);
  await saveSession(sessionPath, original);
  const upstreamRequests: string[] = [];

  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      upstreamRequests.push(path);

      if (path === '/oauth/token') {
        assert.ok(request.headers.get('cookie')?.includes('refreshToken=private-refresh'));
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

      if (path === '/graphql') {
        assert.ok(request.headers.get('cookie')?.includes('id_token=verified-access'));

        return Response.json({ data: { me: { id: 'parent', displayName: 'Parent' } } });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  await writeFile(
    preload,
    `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  if (url.origin !== 'https://www.abler.io') return originalFetch(input, init);
  return originalFetch(new URL(url.pathname + url.search, process.env.ABLER_TEST_ORIGIN), init);
};
`,
  );

  let child: Bun.Subprocess | undefined;

  try {
    child = Bun.spawn(
      [
        process.execPath,
        '--preload',
        preload,
        'src/cli.ts',
        'auth',
        'login',
        '--timeout',
        '20',
        '--browser',
        browser,
      ],
      {
        cwd: resolve('.'),
        env: {
          ...browserEnvironment(directory, sessionPath, 1),
          ABLER_TEST_ORIGIN: `http://127.0.0.1:${upstream.port}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      readPipe(child.stdout),
      readPipe(child.stderr),
    ]);

    const state = await waitForBrowserState(join(directory, 'browser.json'));
    const saved = savedSessionSchema.parse(JSON.parse(await readFile(sessionPath, 'utf8')));
    const savedCookies = new Map(saved.cookies.map(({ name, value }) => [name, value]));
    const jar = await loadSession(sessionPath);

    expect(exit).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Sign in to Abler in the browser window that opened.');
    expect(stdout).toContain(`Abler session saved and verified: ${sessionPath}`);
    expect(stdout).not.toContain('private-refresh');
    expect(stdout).not.toContain('verified-refresh');
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    expect([...savedCookies.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual([
      'id_token',
      'refreshToken',
    ]);
    expect(savedCookies.get('refreshToken')).toBe('verified-refresh');
    expect(savedCookies.get('id_token')).toBe('verified-access');
    expect(await jar.getCookieString('https://www.abler.io')).toContain(
      'refreshToken=verified-refresh',
    );
    expect(upstreamRequests).toEqual(['/oauth/token', '/graphql']);
    expect(state.profileMode).toBe(0o700);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
    expect(await readdir(sessions)).toEqual(['session.json']);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login timeout closes the browser and keeps the previous session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-login-timeout-'));
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const original = await importCookies([cookie]);
  await saveSession(sessionPath, original);
  const originalFile = await readFile(sessionPath, 'utf8');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;

  try {
    child = Bun.spawn(
      [process.execPath, 'src/cli.ts', 'auth', 'login', '--timeout', '1', '--browser', browser],
      {
        cwd: resolve('.'),
        env: browserEnvironment(directory, sessionPath, 1000),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      readPipe(child.stdout),
      readPipe(child.stderr),
    ]);

    const state = await waitForBrowserState(join(directory, 'browser.json'));

    expect(exit).toBe(1);
    expect(stderr).toContain('Abler login timed out after 1 second.');
    expect(stdout).toContain('Sign in to Abler in the browser window that opened.');
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
    expect(await readdir(sessions)).toEqual(['session.json']);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login Ctrl-C closes the browser and removes the profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-login-cancel-'));
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const original = await importCookies([cookie]);
  await saveSession(sessionPath, original);
  const originalFile = await readFile(sessionPath, 'utf8');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;

  try {
    child = Bun.spawn(
      [process.execPath, 'src/cli.ts', 'auth', 'login', '--timeout', '30', '--browser', browser],
      {
        cwd: resolve('.'),
        env: browserEnvironment(directory, sessionPath, 1000),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const state = await waitForBrowserState(join(directory, 'browser.json'));
    await Bun.sleep(250);
    assert.ok(child.pid);
    process.kill(child.pid, 'SIGINT');

    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      readPipe(child.stdout),
      readPipe(child.stderr),
    ]);

    expect(exit).toBe(1);
    expect(stderr).toContain('Abler login cancelled.');
    expect(stdout).not.toContain('Abler session saved and verified');
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }

    await rm(directory, { recursive: true, force: true });
  }
});
