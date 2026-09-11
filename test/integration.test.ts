import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { InfoMentorClient, setupStatusSchema } from '../src/client.js';
import { createServer } from '../src/server.js';
import { importSession, login, waitForLoginPage } from '../src/login.js';
import {
  captureSession,
  inspectPage,
  launchBrowser,
  LOGIN_REQUIRED,
  LOGIN_URL,
  openAuthenticatedPage,
  readSession,
  savedSessionSchema,
  sessionStatusSchema,
  trustedUrl,
  validateCdpUrl,
  writeSession,
} from '../src/session.js';

const overviewUrl = new URL('/parent/overview', LOGIN_URL).href;
const testEngine =
  process.env['INFOMENTOR_BROWSER'] === 'firefox'
    ? firefox
    : process.env['INFOMENTOR_BROWSER'] === 'webkit'
      ? webkit
      : chromium;

/** All school pages/data below are synthetic; no parent account is used. */
async function intercept(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const authenticated = (await context.cookies(route.request().url())).some(
      ({ name, value }) => name === 'test-session' && value === 'synthetic',
    );
    const body = authenticated
      ? '<title>Test overview</title><h1>Vikuáætlun</h1><a href="/logout">Útskrá</a><iframe src="/school"></iframe>'
      : '<title>Sign in</title><input type="password"><button>Innskrá</button>';
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body:
        '<meta charset="utf-8">' +
        (new URL(route.request().url()).pathname === '/school'
          ? '<p>Synthetic homework only</p>'
          : body),
    });
  });
}

test('HTTPS/session and remote-browser boundaries reject lookalikes and insecure remote endpoints', () => {
  assert.equal(trustedUrl(LOGIN_URL).hostname, 'im1.infomentor.is');
  assert.equal(trustedUrl('https://parents.infomentor.is/').hostname, 'parents.infomentor.is');
  for (const url of [
    'http://im1.infomentor.is/',
    'https://im1.infomentor.is.evil.test/',
    'https://im1.infomentor.is@evil.test/',
    'https://im1.infomentor.is:8443/',
    'file:///etc/passwd',
    'https://evilinfomentor.is/',
  ])
    assert.throws(() => trustedUrl(url));
  for (const url of [
    'http://localhost:9222',
    'http://127.0.0.1:9222',
    'ws://[::1]:9222/devtools/browser/test',
    'wss://browser.example/session?token=synthetic',
  ]) {
    assert.equal(validateCdpUrl(url), url);
  }
  for (const url of [
    'http://browser.example:9222',
    'ws://localhost.evil.test',
    'file:///tmp/socket',
    'http://name:password@localhost',
  ]) {
    assert.throws(() => validateCdpUrl(url));
  }
});

test(
  'headless session transfer restores HttpOnly cookies, local storage and IndexedDB; expired sessions fail closed',
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infomentor-state-'));
    const file = join(directory, 'private', 'session.json');
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      await intercept(context);
      const page = await context.newPage();
      await page.goto(LOGIN_URL);
      assert.equal(await inspectPage(page), 'login');
      await page.setContent('<h1>A public page without a login form</h1>');
      assert.equal(await inspectPage(page), 'loading');
      await context.addCookies([
        {
          name: 'test-session',
          value: 'synthetic',
          domain: 'im1.infomentor.is',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        { name: 'unrelated', value: 'must-not-save', domain: 'unrelated.example', path: '/' },
      ]);
      await page.goto(overviewUrl);
      await page.evaluate(async () => {
        localStorage.setItem('synthetic-token', 'test-token');
        await new Promise<void>((resolveDb, reject) => {
          const request = indexedDB.open('test-auth', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('tokens');
          request.onerror = () => reject(new Error('Could not create synthetic database'));
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction('tokens', 'readwrite');
            transaction.objectStore('tokens').put('test-idb-token', 'token');
            transaction.oncomplete = () => {
              db.close();
              resolveDb();
            };
            transaction.onerror = () => reject(new Error('Could not write synthetic database'));
          };
        });
      });
      const saved = await captureSession(context, page.url());
      await writeSession(saved, file);
      assert.equal(saved.storageState.cookies.length, 1);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
      assert.ok(!(await readFile(file, 'utf8')).includes('must-not-save'));
      const reloaded = await readSession(file);
      const restored = await browser.newContext({ storageState: reloaded.storageState });
      await intercept(restored);
      const restoredPage = await openAuthenticatedPage(restored, reloaded.url);
      assert.equal(await inspectPage(restoredPage), 'authenticated');
      assert.equal((await restored.cookies(LOGIN_URL))[0]?.value, 'synthetic');
      assert.equal(await restoredPage.evaluate(() => document.cookie), '');
      assert.equal(
        await restoredPage.evaluate(() => localStorage.getItem('synthetic-token')),
        'test-token',
      );
      assert.equal(
        await restoredPage.evaluate(
          () =>
            new Promise<string>((resolveDb, reject) => {
              const request = indexedDB.open('test-auth');
              request.onerror = () => reject(new Error('Database missing'));
              request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction('tokens');
                const value = transaction.objectStore('tokens').get('token');
                value.onsuccess = () => resolveDb(String(value.result));
                transaction.oncomplete = () => db.close();
              };
            }),
        ),
        'test-idb-token',
      );
      await restored.clearCookies();
      await assert.rejects(openAuthenticatedPage(restored, reloaded.url), {
        code: 'LOGIN_REQUIRED',
      });

      const before = await readFile(file, 'utf8');
      const corrupt = join(directory, 'corrupt.json');
      await writeFile(corrupt, '{broken');
      await assert.rejects(importSession(corrupt, { sessionFile: file }), {
        code: 'INVALID_SESSION',
      });
      assert.equal(await readFile(file, 'utf8'), before);
      assert.equal(savedSessionSchema.safeParse({ ...saved, version: 2 }).success, false);
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'login detects a signed-in popup automatically and supports cancellation and timeout without a terminal',
  { timeout: 15_000 },
  async () => {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      await intercept(context);
      const loginPage = await context.newPage();
      await loginPage.goto(LOGIN_URL);
      const waiting = waitForLoginPage(context, Date.now() + 5_000);
      await context.addCookies([
        {
          name: 'test-session',
          value: 'synthetic',
          domain: 'im1.infomentor.is',
          path: '/',
          httpOnly: true,
          secure: true,
        },
      ]);
      const popup = await context.newPage();
      await popup.goto(overviewUrl);
      assert.equal(await waiting, popup);
      await popup.close();
      const controller = new AbortController();
      const cancelled = waitForLoginPage(context, Date.now() + 5_000, controller.signal);
      controller.abort();
      await assert.rejects(cancelled, { code: 'CANCELLED' });
      await assert.rejects(waitForLoginPage(context, Date.now() + 1), { code: 'LOGIN_TIMEOUT' });
    } finally {
      await browser.close();
    }
  },
);

test('login keeps an initial HTTP 403 challenge open for a human without retrying', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infomentor-challenge-'));
  const file = join(directory, 'session.json');
  const browser = await launchBrowser();
  const context = await browser.newContext();
  let requests = 0;
  await context.route('**/*', async (route) => {
    requests++;
    await route.fulfill({
      status: 403,
      contentType: 'text/html',
      body: '<title>Just a moment...</title><div id="challenge-running">Verify you are human</div>',
    });
  });
  // Keep this interactive-login check headless and use only synthetic pages.
  const launcher = mock.method(testEngine, 'launch', async () => browser);
  mock.method(browser, 'newContext', async () => context);
  let showChallenge = (): void => {};
  const challenge = new Promise<void>((resolveChallenge) => {
    showChallenge = resolveChallenge;
  });
  const stages: string[] = [];
  try {
    await Promise.all([
      login({
        sessionFile: file,
        timeoutMs: 5_000,
        onProgress(stage) {
          stages.push(stage);
          if (stage === 'challenge') showChallenge();
        },
      }),
      (async () => {
        await challenge;
        assert.equal(requests, 1);
        await context.addCookies([
          { name: 'test-session', value: 'synthetic', domain: 'im1.infomentor.is', path: '/' },
        ]);
        const page = context.pages()[0];
        assert.ok(page);
        await page.setContent('<meta charset="utf-8"><a href="/logout">Útskrá</a>');
      })(),
    ]);
    assert.equal(stages[0], 'waiting');
    assert.ok(stages.includes('challenge'));
    assert.equal(stages.at(-1), 'saved');
    assert.equal(requests, 1);
    assert.equal((await readSession(file)).storageState.cookies[0]?.value, 'synthetic');
  } finally {
    launcher.mock.restore();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'CDP login contexts are isolated and disconnect leaves the remote browser and existing tabs open',
  {
    timeout: 20_000,
    skip: ['firefox', 'webkit'].includes(process.env['INFOMENTOR_BROWSER'] ?? ''),
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infomentor-cdp-'));
    const executable =
      process.env['INFOMENTOR_BROWSER'] === 'chromium'
        ? chromium.executablePath()
        : process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath();
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--no-sandbox',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=' + directory,
      ],
      { stdio: 'ignore' },
    );
    let processError: Error | undefined;
    child.on('error', (error) => {
      processError = error;
    });
    try {
      let port: string | undefined;
      for (let tries = 0; tries < 100; tries++) {
        if (processError) throw processError;
        try {
          port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        } catch {
          /* Browser is starting. */
        }
        if (port) break;
        await delay(100);
      }
      assert.ok(port, 'Chrome should expose a loopback debugging port');
      const cdpUrl = 'http://127.0.0.1:' + port;
      const remote = await launchBrowser({ cdpUrl });
      const defaultContext = remote.contexts()[0];
      assert.ok(defaultContext);
      const existingPage = await defaultContext.newPage();
      await existingPage.goto('data:text/html,Existing tab');
      const isolated = await remote.newContext();
      await isolated.addCookies([
        { name: 'test-session', value: 'synthetic', domain: 'im1.infomentor.is', path: '/' },
      ]);
      assert.equal((await defaultContext.cookies(LOGIN_URL)).length, 0);
      await isolated.close();
      await remote.close();
      const reconnected = await launchBrowser({ cdpUrl });
      try {
        assert.ok(
          reconnected
            .contexts()[0]
            ?.pages()
            .some((page) => page.url().includes('Existing')),
        );
      } finally {
        await reconnected.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
        child.kill('SIGTERM');
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'compiled Node CLI speaks typed MCP over stdio; missing auth cannot return school data',
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infomentor-mcp-'));
    const client = new Client({ name: 'infomentor-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [resolve('dist/cli.js'), '--session', join(directory, 'missing.json')],
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map(({ name }) => name),
        [
          'infomentor_session_status',
          'infomentor_get_overview',
          'infomentor_login',
          'infomentor_setup_status',
          'infomentor_cancel_setup',
          'infomentor_logout',
          'infomentor_install_browser',
        ],
      );
      assert.ok(
        tools
          .filter(({ name }) =>
            [
              'infomentor_session_status',
              'infomentor_get_overview',
              'infomentor_setup_status',
            ].includes(name),
          )
          .every(
            ({ annotations, outputSchema }) =>
              annotations?.readOnlyHint && !annotations.destructiveHint && outputSchema,
          ),
      );
      const status = CallToolResultSchema.parse(
        await client.callTool({ name: 'infomentor_session_status', arguments: {} }),
      );
      assert.equal(sessionStatusSchema.parse(status.structuredContent).authenticated, false);
      const overview = CallToolResultSchema.parse(
        await client.callTool({ name: 'infomentor_get_overview', arguments: {} }),
      );
      assert.equal(overview.isError, true);
      const content = overview.content[0];
      assert.equal(content?.type === 'text' ? content.text : undefined, LOGIN_REQUIRED);
      const invalid = CallToolResultSchema.parse(
        await client.callTool({
          name: 'infomentor_get_overview',
          arguments: { password: 'never-accept-a-password' },
        }),
      );
      assert.equal(invalid.isError, true);
      assert.ok(!JSON.stringify(invalid).includes('never-accept-a-password'));
      const setup = CallToolResultSchema.parse(
        await client.callTool({ name: 'infomentor_setup_status', arguments: {} }),
      );
      assert.equal(setupStatusSchema.parse(setup.structuredContent).state, 'idle');
      assert.equal(
        tools.find(({ name }) => name === 'infomentor_logout')?.annotations?.destructiveHint,
        true,
      );
      assert.equal(
        tools.find(({ name }) => name === 'infomentor_login')?.annotations?.readOnlyHint,
        false,
      );
      // CI installs this exact engine first; do not download another browser in ordinary tests.
      const browser = process.env['INFOMENTOR_BROWSER'];
      if (browser && ['chromium', 'firefox', 'webkit'].includes(browser)) {
        const install = CallToolResultSchema.parse(
          await client.callTool({ name: 'infomentor_install_browser', arguments: { browser } }),
        );
        assert.equal(setupStatusSchema.parse(install.structuredContent).state, 'running');
        let state = 'running';
        for (let tries = 0; tries < 100 && state === 'running'; tries++) {
          await delay(50);
          const status = CallToolResultSchema.parse(
            await client.callTool({ name: 'infomentor_setup_status', arguments: {} }),
          );
          state = setupStatusSchema.parse(status.structuredContent).state;
        }
        assert.equal(state, 'succeeded');
      }
      assert.equal(stderr, '');
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'MCP client reuses one browser and rotating cookies, serializes reads, and stops on challenges or rate limits',
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infomentor-client-'));
    const file = join(directory, 'session.json');
    await writeSession(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        url: overviewUrl,
        storageState: {
          cookies: [
            {
              name: 'test-session',
              value: 'synthetic',
              domain: 'im1.infomentor.is',
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax',
            },
          ],
          origins: [],
        },
      },
      file,
    );
    let launches = 0;
    let contexts = 0;
    let requests = 0;
    let concurrent = 0;
    let maximumConcurrent = 0;
    let mode: 'ready' | 'limited' | 'challenge' | 'slow' = 'ready';
    let contextForHuman: BrowserContext | undefined;
    const launch = testEngine.launch.bind(testEngine);
    // Only intercept network traffic; exercise the actual browser and client lifecycle.
    const launcher = mock.method(
      testEngine,
      'launch',
      async (...args: Parameters<typeof testEngine.launch>): Promise<Browser> => {
        launches++;
        const browser = await launch(...args);
        const newContext = browser.newContext.bind(browser);
        mock.method(
          browser,
          'newContext',
          async (...contextArgs: Parameters<Browser['newContext']>): Promise<BrowserContext> => {
            contexts++;
            const context = await newContext(...contextArgs);
            contextForHuman = context;
            await context.route('**/*', async (route) => {
              requests++;
              concurrent++;
              maximumConcurrent = Math.max(maximumConcurrent, concurrent);
              await delay(40);
              concurrent--;
              if (mode === 'slow') {
                await delay(1000);
                await route.abort().catch(() => {});
                return;
              }
              if (mode === 'limited') {
                await route.fulfill({
                  status: 429,
                  headers: { 'retry-after': '1' },
                  body: 'Slow down',
                });
              } else if (mode === 'challenge') {
                await route.fulfill({
                  status: 403,
                  contentType: 'text/html; charset=utf-8',
                  body: '<title>Just a moment...</title><div id="challenge-running">Verify you are human</div>',
                });
              } else {
                await route.fulfill({
                  contentType: 'text/html; charset=utf-8',
                  headers: {
                    'set-cookie': 'test-session=rotated; Path=/; HttpOnly; Secure; SameSite=Lax',
                  },
                  body: '<meta charset="utf-8"><title>Synthetic school</title><h1>Vikuáætlun</h1><a href="/logout">Útskrá</a>',
                });
              }
            });
            return context;
          },
        );
        return browser;
      },
    );
    const client = new InfoMentorClient({ sessionFile: file });
    try {
      const results = await Promise.all([client.getOverview(), client.getOverview()]);
      assert.ok(results.every((result) => result.text.includes('Vikuáætlun')));
      assert.equal(launches, 1);
      assert.equal(contexts, 1);
      assert.equal(maximumConcurrent, 1);
      assert.ok(contextForHuman);
      assert.equal((await contextForHuman.cookies(LOGIN_URL))[0]?.value, 'rotated');
      assert.equal((await readSession(file)).storageState.cookies[0]?.value, 'synthetic');

      mode = 'slow';
      const cancellation = new AbortController();
      const cancelledRead = client.getOverview(cancellation.signal);
      await delay(100);
      cancellation.abort();
      await assert.rejects(cancelledRead, { code: 'CANCELLED' });
      mode = 'ready';
      assert.equal((await client.getSessionStatus()).authenticated, true);
      assert.equal(launches, 1);

      mode = 'limited';
      await assert.rejects(client.getOverview(), { code: 'RATE_LIMITED', retryAfterMs: 1000 });
      const limitedRequests = requests;
      mode = 'ready';
      await assert.rejects(client.getOverview(), { code: 'RATE_LIMITED' });
      assert.equal(requests, limitedRequests);
      await delay(1050);
      assert.equal((await client.getSessionStatus()).authenticated, true);

      mode = 'challenge';
      await assert.rejects(client.getOverview(), { code: 'CHALLENGE_REQUIRED' });
      const challengedRequests = requests;
      await assert.rejects(client.getOverview(), { code: 'CHALLENGE_REQUIRED' });
      assert.equal(requests, challengedRequests);
      assert.ok(contextForHuman);
      const page = contextForHuman.pages()[0];
      assert.ok(page);
      // Simulate a human finishing our synthetic challenge; never solve real challenges.
      await page.setContent('<a href="/logout">Útskrá</a>');
      mode = 'ready';
      assert.equal((await client.getSessionStatus()).authenticated, true);
      assert.equal(launches, 1);
      await client.close();
      await assert.rejects(client.getOverview(), { code: 'CANCELLED' });
    } finally {
      await client.close();
      launcher.mock.restore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'MCP manages login, import, cancellation and logout through real browser contexts',
  { timeout: 25_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infomentor-mcp-setup-'));
    const file = join(directory, 'session.json');
    const browsers: Browser[] = [];
    let latestContext: BrowserContext | undefined;
    const launch = testEngine.launch.bind(testEngine);
    const launcher = mock.method(
      testEngine,
      'launch',
      async (...args: Parameters<typeof testEngine.launch>): Promise<Browser> => {
        const browser = await launch({ ...args[0], headless: true });
        browsers.push(browser);
        const newContext = browser.newContext.bind(browser);
        mock.method(
          browser,
          'newContext',
          async (...contextArgs: Parameters<Browser['newContext']>): Promise<BrowserContext> => {
            const context = await newContext(...contextArgs);
            latestContext = context;
            await intercept(context);
            return context;
          },
        );
        return browser;
      },
    );
    const server = createServer({ sessionFile: file });
    const client = new Client({ name: 'setup-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const waitFor = async (expected: string) => {
      for (let tries = 0; tries < 100; tries++) {
        const result = await call('infomentor_setup_status');
        const status = setupStatusSchema.parse(result.structuredContent);
        if (status.state === expected) return status;
        assert.ok(!['failed', 'cancelled'].includes(status.state), status.message);
        await delay(50);
      }
      assert.fail('Setup should reach ' + expected);
    };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await call('infomentor_login');
      assert.equal(setupStatusSchema.parse(started.structuredContent).state, 'running');
      assert.equal((await call('infomentor_login')).isError, true);
      assert.equal((await call('infomentor_get_overview')).isError, true);
      await waitFor('waiting');
      assert.ok(latestContext);
      await latestContext.addCookies([
        {
          name: 'test-session',
          value: 'synthetic',
          domain: 'im1.infomentor.is',
          path: '/',
          httpOnly: true,
          secure: true,
        },
      ]);
      const page = latestContext.pages()[0];
      assert.ok(page);
      await page.goto(overviewUrl);
      await waitFor('succeeded');
      assert.equal(
        (await call('infomentor_session_status')).structuredContent?.['authenticated'],
        true,
      );
      const overview = await call('infomentor_get_overview');
      assert.ok(JSON.stringify(overview).includes('Vikuáætlun'));
      assert.ok(!JSON.stringify(overview).includes('test-session'));

      const before = await readFile(file, 'utf8');
      const transfer = join(directory, 'transfer.json');
      await writeFile(transfer, before);
      await call('infomentor_logout');
      assert.equal(
        (await call('infomentor_session_status')).structuredContent?.['authenticated'],
        false,
      );
      assert.ok(browsers.every((browser) => !browser.isConnected()));
      await call('infomentor_login', { importFile: transfer });
      await waitFor('succeeded');
      assert.equal(
        (await call('infomentor_session_status')).structuredContent?.['authenticated'],
        true,
      );

      const imported = await readFile(file, 'utf8');
      await call('infomentor_login');
      await waitFor('waiting');
      const cancelled = await call('infomentor_cancel_setup');
      assert.equal(setupStatusSchema.parse(cancelled.structuredContent).state, 'cancelled');
      assert.equal(await readFile(file, 'utf8'), imported);
      await call('infomentor_login', { timeoutSeconds: 1 });
      await waitFor('failed');
      assert.equal(await readFile(file, 'utf8'), imported);

      await call('infomentor_login');
      const loggedOut = await call('infomentor_logout');
      assert.equal(loggedOut.structuredContent?.['authenticated'], false);
      await assert.rejects(readSession(file), { code: 'LOGIN_REQUIRED' });
      assert.ok(browsers.every((browser) => !browser.isConnected()));
      await call('infomentor_login');
      await waitFor('waiting');
      await client.close();
      for (let tries = 0; tries < 50 && browsers.some((browser) => browser.isConnected()); tries++)
        await delay(50);
      assert.ok(browsers.every((browser) => !browser.isConnected()));
    } finally {
      await client.close();
      await server.close();
      launcher.mock.restore();
      for (const browser of browsers) await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
