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
import { join } from 'node:path';

import type { z } from 'zod';

import { findBrowser, loginInBrowser, requireDisplay } from '../src/browser-login.js';
import {
  browserEnvironment,
  browserStateSchema,
  collectProcess,
  makeFakeBrowser,
  makePreload,
  makeTestDirectory,
  pidIsRunning,
  savedCookies,
  savedSessionSchema,
  storeHome,
  spawnCli,
  spawnLogin,
  START_MESSAGE,
  stopChild,
  TIMEOUT_MESSAGE,
  waitForBrowserState,
  waitForFile,
} from './browser-harness.js';
import { filesContaining, readStored, storeAt } from './scratch.js';

const USER_PATH = '/api/UserData/GetLoggedInUser';

const user = {
  userId: 1,
  studentId: '2',
  schoolId: '3',
  studentName: 'Synthetic student',
  name: 'Synthetic guardian',
  schoolLong: 'Synthetic school',
  defaultTermId: '4',
  isGuardian: true,
  logInType: '2',
  olderThan18: false,
  registerAbsenceGuardian: '1',
  registerAbsenceUnder18: '0',
  registerAbsenceOver18: '1',
  registerAbsence: '1',
  student18RegisterAbsence: '1',
  registerLeave: '1',
  student18RegisterLeave: '1',
  registerIllnessTomorrow: '1',
};

const previous = JSON.stringify({ synthetic: 'previous session file' });

async function makeInvalidBrowser(directory: string): Promise<string> {
  const path = join(directory, 'invalid-chrome');
  await writeFile(path, 'not an executable browser', { mode: 0o700 });
  await chmod(path, 0o700);

  return path;
}

async function savePreviousSession(path: string): Promise<string> {
  await writeFile(path, previous, { mode: 0o600 });

  return previous;
}

// Records what the verification request carried and whether the browser was already gone.
function createUpstream(options: { valid: boolean; stateFile: string; exitFile: string }) {
  const requests: {
    path: string;
    cookie: string | null;
    xsrf: string | null;
    browserClosed: boolean;
    profileRemoved: boolean;
  }[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;

      const state = browserStateSchema.parse(JSON.parse(await readFile(options.stateFile, 'utf8')));

      requests.push({
        path,
        cookie: request.headers.get('cookie'),
        xsrf: request.headers.get('x-xsrf-token'),
        browserClosed: await readFile(options.exitFile, 'utf8').then(
          (text) => text === 'closed',
          () => false,
        ),
        profileRemoved: await stat(state.profile).then(
          () => false,
          () => true,
        ),
      });

      if (path !== USER_PATH) return new Response('Not found', { status: 404 });

      if (!options.valid) return new Response(null, { status: 401 });

      return Response.json(user);
    },
  });

  return { server, requests, origin: `http://127.0.0.1:${server.port}` };
}

test('browser discovery honors the override and names the browser and both options', async () => {
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
    // An explicit empty override keeps a developer's own INNA_BROWSER out of this test.
    findBrowser(
      '',
      'linux',
      async () => false,
      async (command) => {
        searched.push(command);

        return undefined;
      },
    ),
    (error: Error) => {
      expect(error.message).toContain('requires Google Chrome or Chromium');
      expect(error.message).toContain('--browser or INNA_BROWSER');
      expect(error.message).toContain('`inna-mcp auth login`');

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

test('a missing display on Linux fails before anything is launched', async () => {
  const { directory } = await makeTestDirectory('inna-login-display-');
  const marker = join(directory, 'launched');
  const browser = join(directory, 'marker-browser');
  await writeFile(browser, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });

  try {
    expect(() => requireDisplay('linux', {})).toThrow(/desktop session/);
    expect(() => requireDisplay('linux', {})).toThrow(/`inna-mcp auth login`\) works without one/);
    expect(() => requireDisplay('linux', { DISPLAY: '', WAYLAND_DISPLAY: '' })).toThrow();
    expect(requireDisplay('linux', { DISPLAY: ':0' })).toBeUndefined();
    expect(requireDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBeUndefined();
    expect(requireDisplay('darwin', {})).toBeUndefined();

    await assert.rejects(
      loginInBrowser({ browser, timeoutSeconds: 5 }, 'linux', {}),
      /needs a desktop session/,
    );
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google captures over a private pipe, closes the browser, then verifies and saves', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-private-');
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);
  const upstream = createUpstream({ valid: true, stateFile, exitFile });
  let child: Bun.Subprocess | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_EMPTY_POLLS: '1',
        INNA_TEST_ORIGIN: upstream.origin,
      }),
      20,
      preload,
    );
    const state = await waitForBrowserState(stateFile);
    const { exit, stdout, stderr } = await collectProcess(child);

    expect(stderr).toBe(START_MESSAGE);
    expect(stdout).toBe('Signed in. Saved in an encrypted file.\n');
    expect(exit).toBe(0);
    expect(stdout + stderr).not.toMatch(/synthetic-|decoy-/);

    expect(state.args.filter((argument) => argument.includes('remote-debugging'))).toEqual([
      '--remote-debugging-pipe',
    ]);
    expect(state.args.at(-1)).toBe('https://r.inna.is/auth/google');
    expect(state.args).toContain(`--user-data-dir=${state.profile}`);
    expect(state.profile.startsWith(join(temporaryDirectory, 'inna-login-'))).toBe(true);
    expect(state.profileMode).toBe(0o700);
    expect(state.transport).toBe('pipe');

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests).toMatchObject([
      { path: USER_PATH, xsrf: 'synthetic-xsrf', browserClosed: true, profileRemoved: true },
    ]);
    expect(upstream.requests[0]?.cookie).toContain('SESSION=synthetic-session');
    expect(upstream.requests[0]?.cookie).not.toContain('decoy');

    const cookies = await savedCookies(directory);

    expect(cookies.map(({ key, value }) => `${key}=${value}`).toSorted()).toEqual([
      'JSESSIONID=synthetic-jsession',
      'SESSION=synthetic-session',
      'XSRF-TOKEN=synthetic-xsrf',
    ]);

    for (const cookie of cookies)
      expect(cookie).toMatchObject({ domain: 'nam.inna.is', path: '/', secure: true });
    const store = storeAt(storeHome(directory));
    const saved = await readStored(store);
    expect(saved).not.toContain('decoy');
    expect(savedSessionSchema.parse(JSON.parse(saved))).toMatchObject({
      version: 2,
      account: { userId: 1, studentId: '2', schoolId: '3' },
    });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    // The session exists only encrypted: no plaintext file, and no cookie value on disk.
    await assert.rejects(stat(sessionPath), { code: 'ENOENT' });
    expect(
      await filesContaining(
        ['synthetic-session', 'synthetic-jsession', 'synthetic-xsrf'],
        sessions,
        storeHome(directory),
        temporaryDirectory,
      ),
    ).toEqual([]);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readdir(temporaryDirectory)).toEqual([]);
    expect(await readFile(exitFile, 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google waits through the Google pages until the student application is shown', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-wait-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const preload = await makePreload(directory);

  const upstream = createUpstream({
    valid: true,
    stateFile,
    exitFile: join(directory, 'browser.closed'),
  });

  let child: Bun.Subprocess | undefined;

  try {
    // The school cookies exist from the first poll; the first page poll still shows Google.
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_SIGNIN_POLLS: '1',
        INNA_TEST_ORIGIN: upstream.origin,
      }),
      20,
      preload,
    );
    const { exit, stderr } = await collectProcess(child);

    expect(stderr).toBe(START_MESSAGE);
    expect(exit).toBe(0);
    expect(upstream.requests.map((request) => request.browserClosed)).toEqual([true]);
    expect((await savedCookies(directory)).map(({ key }) => key).toSorted()).toEqual([
      'JSESSIONID',
      'SESSION',
      'XSRF-TOKEN',
    ]);
  } finally {
    await stopChild(child);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google keeps waiting without both the student page and its cookies, then times out', async () => {
  const waiting = {
    'cookies while the page is still at Google': { INNA_FAKE_SIGNIN_POLLS: '999' },
    'the student path on another host': {
      INNA_FAKE_PAGE_URL: 'https://r.inna.is/Components/Students/Students.html',
    },
    'the student path on a look-alike host': {
      INNA_FAKE_PAGE_URL: 'https://nam.inna.is.example/Components/Students/Students.html',
    },
    'the student path over plain HTTP': {
      INNA_FAKE_PAGE_URL: 'http://nam.inna.is/Components/Students/Students.html',
    },
    'another path on the school host': {
      INNA_FAKE_PAGE_URL: 'https://nam.inna.is/Components/Login/Login.html',
    },
    'the student page named only in a query': {
      INNA_FAKE_PAGE_URL: 'https://nam.inna.is/login?next=/Components/Students/Students.html',
    },
    'the student page without the XSRF cookie': { INNA_FAKE_XSRF: '0' },
    'the student page before the school cookies exist': { INNA_FAKE_EMPTY_POLLS: '999' },
  } satisfies Record<string, Record<string, string>>;

  async function expectTimeout(name: string, overrides: Record<string, string>) {
    const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-waiting-');
    const sessionPath = join(directory, 'session.json');
    const originalFile = await savePreviousSession(sessionPath);
    const browser = await makeFakeBrowser(directory);
    const preload = await makePreload(directory);

    const upstream = createUpstream({
      valid: true,
      stateFile: join(directory, 'browser.json'),
      exitFile: join(directory, 'browser.closed'),
    });

    let child: Bun.Subprocess | undefined;
    let state: z.infer<typeof browserStateSchema> | undefined;

    try {
      child = spawnLogin(
        browser,
        browserEnvironment(directory, temporaryDirectory, sessionPath, {
          ...overrides,
          INNA_TEST_ORIGIN: upstream.origin,
        }),
        1,
        preload,
      );
      state = await waitForBrowserState(join(directory, 'browser.json'));
      const { exit, stdout, stderr } = await collectProcess(child);

      expect({ name, stderr }).toEqual({ name, stderr: START_MESSAGE + TIMEOUT_MESSAGE });
      expect(stdout).toBe('');
      expect(exit).toBe(1);
      expect(upstream.requests).toEqual([]);
      expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
      await assert.rejects(stat(state.profile), { code: 'ENOENT' });
      expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
      expect(pidIsRunning(state.pid)).toBe(false);
    } finally {
      await stopChild(child, state?.pid);
      await upstream.server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }

  await Promise.all(
    Object.entries(waiting).map(([name, overrides]) => expectTimeout(name, overrides)),
  );
});

test('auth login --google closes a launcher-spawned browser child before removing its profile', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-launcher-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);
  const upstream = createUpstream({ valid: true, stateFile, exitFile });
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_LAUNCHER: '1',
        INNA_TEST_ORIGIN: upstream.origin,
      }),
      20,
      preload,
    );
    state = await waitForBrowserState(stateFile);
    const { exit, stderr } = await collectProcess(child);

    expect(stderr).toBe(START_MESSAGE);
    expect(exit).toBe(0);
    expect(state.profileMode).toBe(0o700);
    expect(upstream.requests).toMatchObject([{ browserClosed: true, profileRemoved: true }]);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(exitFile, 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child, state?.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google timeout closes a launcher-spawned browser child', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-launcher-timeout-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_SIGNIN_POLLS: '999',
        INNA_FAKE_LAUNCHER: '1',
      }),
      1,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toBe(START_MESSAGE + TIMEOUT_MESSAGE);
    await assert.rejects(stat(sessionPath), { code: 'ENOENT' });
    await assert.rejects(stat(storeAt(storeHome(directory)).path), { code: 'ENOENT' });
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child, state?.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google cancelled while waiting closes the browser and saves nothing', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-cancel-');
  const sessionPath = join(directory, 'session.json');
  const originalFile = await savePreviousSession(sessionPath);
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_SIGNIN_POLLS: '999',
      }),
      60,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    assert.ok(child.pid);
    process.kill(child.pid, 'SIGINT');
    const { exit, stdout, stderr } = await collectProcess(child);

    expect(stderr).toBe(`${START_MESSAGE}Inna login cancelled.\n`);
    expect(stdout).toBe('');
    expect(exit).toBe(1);
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readdir(temporaryDirectory)).toEqual([]);
    expect(await readFile(join(directory, 'browser.closed'), 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child, state?.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google keeps signal handlers through delayed SIGTERM and SIGKILL cleanup', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-signals-');
  const sessionPath = join(directory, 'session.json');
  const originalFile = await savePreviousSession(sessionPath);
  const browser = await makeFakeBrowser(directory);
  const preload = await makePreload(directory);

  const upstream = createUpstream({
    valid: true,
    stateFile: join(directory, 'browser.json'),
    exitFile: join(directory, 'browser.closed'),
  });

  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_IGNORE_BROWSER_CLOSE: '1',
        INNA_FAKE_DELAY_SIGTERM: '1',
        INNA_TEST_ORIGIN: upstream.origin,
      }),
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
    expect(stderr).toContain('Inna login cancelled.');
    expect(stdout).toBe('');
    expect(upstream.requests).toEqual([]);
    expect(await readFile(sessionPath, 'utf8')).toBe(originalFile);
    expect(await readFile(join(directory, 'browser.signal'), 'utf8')).toBe('SIGTERM');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child, state?.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google keeps the previous session when verification refuses the capture', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-verify-');
  const sessions = join(directory, 'sessions');
  await mkdir(sessions);
  const sessionPath = join(sessions, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);
  const upstream = createUpstream({ valid: false, stateFile, exitFile });
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_TEST_ORIGIN: upstream.origin,
      }),
      20,
      preload,
    );
    state = await waitForBrowserState(stateFile);
    const { exit, stdout, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('sign-in is required');
    expect(stdout).toBe('');
    expect(upstream.requests).toMatchObject([{ browserClosed: true, profileRemoved: true }]);
    await assert.rejects(stat(sessionPath), { code: 'ENOENT' });
    await assert.rejects(stat(storeAt(storeHome(directory)).path), { code: 'ENOENT' });
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(await readFile(exitFile, 'utf8')).toBe('closed');
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child, state?.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google removes the profile when browser readiness fails', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-readiness-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_BAD_READINESS: '1',
      }),
      20,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain('Could not establish a private Chrome debugging pipe.');
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(false);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally {
    await stopChild(child, state?.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google removes the profile when the browser exits before readiness', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-early-exit-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_EXIT_BEFORE_READY: '1',
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
    await stopChild(child, state?.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google reports pipe setup failure and removes its profile', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-spawn-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeInvalidBrowser(directory);

  try {
    const { exit, stderr } = await collectProcess(
      spawnLogin(browser, browserEnvironment(directory, temporaryDirectory, sessionPath), 20),
    );

    expect(exit).toBe(1);
    expect(stderr).toContain(
      'Could not establish a private Chrome debugging pipe. Select Google Chrome or Chromium with `--browser`, or use electronic ID (`inna-mcp auth login`) or `inna-mcp auth import`.',
    );
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google sweeps abandoned profiles but preserves recent and live profiles', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-sweep-');
  const abandoned = await mkdtemp(join(temporaryDirectory, 'inna-login-abandoned-'));
  const recent = await mkdtemp(join(temporaryDirectory, 'inna-login-recent-'));
  const active = await mkdtemp(join(temporaryDirectory, 'inna-login-active-'));
  const foreign = await mkdtemp(join(temporaryDirectory, 'abler-login-abandoned-'));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(abandoned, old, old);
  await utimes(foreign, old, old);
  await symlink(`test-host-${process.pid}`, join(active, 'SingletonLock'));
  await utimes(active, old, old);
  const missingBrowser = join(directory, 'missing-browser');
  const sessionPath = join(directory, 'session.json');

  try {
    const { exit, stdout, stderr } = await collectProcess(
      spawnLogin(
        missingBrowser,
        browserEnvironment(directory, temporaryDirectory, sessionPath),
        20,
      ),
    );

    expect(exit).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'Google sign-in requires Google Chrome or Chromium, and none was found. Install one, or give its executable with --browser or INNA_BROWSER. Electronic ID (`inna-mcp auth login`) needs no browser.\n',
    );
    await assert.rejects(stat(abandoned), { code: 'ENOENT' });
    expect((await stat(recent)).isDirectory()).toBe(true);
    expect((await stat(active)).isDirectory()).toBe(true);
    expect((await stat(foreign)).isDirectory()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google errors when an ignored launcher child may still be running', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-orphan-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_LAUNCHER: '1',
        INNA_FAKE_IGNORE_BROWSER_CLOSE: '1',
      }),
      20,
    );
    state = await waitForBrowserState(join(directory, 'browser.json'));
    const { exit, stdout, stderr } = await collectProcess(child);

    expect(exit).toBe(1);
    expect(stderr).toContain(
      'A browser process may still be running; its temporary profile was removed.',
    );
    expect(stdout).toBe('');
    await assert.rejects(stat(sessionPath), { code: 'ENOENT' });
    await assert.rejects(stat(storeAt(storeHome(directory)).path), { code: 'ENOENT' });
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(true);
  } finally {
    await stopChild(child, state?.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test('auth login --google rediscovers the student tab after its pipe session detaches', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-detached-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const stateFile = join(directory, 'browser.json');
  const exitFile = join(directory, 'browser.closed');
  const preload = await makePreload(directory);
  const upstream = createUpstream({ valid: true, stateFile, exitFile });
  let child: Bun.Subprocess | undefined;
  let state: z.infer<typeof browserStateSchema> | undefined;

  try {
    child = spawnLogin(
      browser,
      browserEnvironment(directory, temporaryDirectory, sessionPath, {
        INNA_FAKE_EMPTY_POLLS: '1',
        INNA_FAKE_DETACH_ON_EMPTY_POLL: '1',
        INNA_TEST_ORIGIN: upstream.origin,
      }),
      10,
      preload,
    );
    state = await waitForBrowserState(stateFile);
    const { exit, stderr } = await collectProcess(child);

    expect(stderr).toBe(START_MESSAGE);
    expect(exit).toBe(0);
    expect((await savedCookies(directory)).map(({ key }) => key).toSorted()).toEqual([
      'JSESSIONID',
      'SESSION',
      'XSRF-TOKEN',
    ]);
    expect(upstream.requests.map((request) => request.path)).toEqual([USER_PATH]);
    await assert.rejects(stat(state.profile), { code: 'ENOENT' });
    expect(pidIsRunning(state.pid)).toBe(false);
  } finally {
    await stopChild(child, state?.pid);
    await upstream.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('the browser options are valid only with auth login --google', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-arguments-');
  const sessionPath = join(directory, 'session.json');
  const browser = await makeFakeBrowser(directory);
  const env = browserEnvironment(directory, temporaryDirectory, sessionPath);

  try {
    for (const args of [
      ['--google'],
      ['serve', '--google'],
      ['auth', '--google'],
      ['auth', 'status', '--google'],
      ['auth', 'logout', '--google'],
      ['auth', 'import', join(directory, 'cookies.json'), '--google'],
      ['auth', 'login', 'extra', '--google'],
      ['auth', 'login', '--timeout', '5'],
      ['auth', 'login', '--browser', browser],
      ['auth', 'login', '--timeout', '5', '--browser', browser],
      ['auth', 'status', '--timeout', '5'],
      ['serve', '--browser', browser],
      ['--timeout', '5'],
      ['auth', 'login', '--google', '--browser', browser, '--no-keep-alive'],
      ['auth', 'login', '--google', '--browser', browser, '--allow-absence-writes'],
    ]) {
      const { exit, stdout, stderr } = await collectProcess(spawnCli(args, env));

      expect({ args, stderr }).toEqual({ args, stderr: 'Invalid command. Run inna-mcp --help.\n' });
      expect(stdout).toBe('');
      expect(exit).toBe(1);
    }

    for (const timeout of ['0', '-1', '1.5', 'soon', '']) {
      const { exit, stdout, stderr } = await collectProcess(
        spawnCli(['auth', 'login', '--google', '--browser', browser, `--timeout=${timeout}`], env),
      );

      expect({ timeout, stderr }).toEqual({
        timeout,
        stderr: 'Provide a positive whole number for --timeout.\n',
      });
      expect(stdout).toBe('');
      expect(exit).toBe(1);
    }

    await assert.rejects(stat(join(directory, 'browser.json')), { code: 'ENOENT' });
    expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('help presents Google sign-in as one command and cookie import as the fallback', async () => {
  const { directory, temporaryDirectory } = await makeTestDirectory('inna-login-help-');

  try {
    const { exit, stdout } = await collectProcess(
      spawnCli(
        ['--help'],
        browserEnvironment(directory, temporaryDirectory, join(directory, 'session.json')),
      ),
    );

    expect(exit).toBe(0);
    expect(stdout).toContain('inna-mcp auth login --google');
    expect(stdout).toContain('--timeout <seconds> (default 300)');
    expect(stdout).toContain('--browser <path> or INNA_BROWSER');
    expect(stdout).toContain('auth import is for a machine without a desktop');
    expect(stdout).not.toContain('--keep-browser');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
