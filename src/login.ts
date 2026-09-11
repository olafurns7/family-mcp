import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  captureSession,
  inspectPage,
  InfoMentorError,
  launchBrowser,
  LOGIN_URL,
  pause,
  readSession,
  sessionPath,
  throwIfAborted,
  verifySession,
  writeSession,
} from './session.js';
import type { SessionOptions } from './session.js';

export type LoginOptions = SessionOptions & {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: 'waiting' | 'challenge' | 'saved') => void;
};

/** Waits for the user in any tab/popup belonging to our isolated context. */
export async function waitForLoginPage(
  context: BrowserContext,
  deadline: number,
  signal?: AbortSignal,
  onChallenge?: () => void,
): Promise<Page> {
  while (Date.now() < deadline) {
    throwIfAborted(signal);

    if (!context.browser()?.isConnected() || context.pages().length === 0) {
      throw new InfoMentorError(
        'CANCELLED',
        'The login window was closed. The existing saved session was kept.',
      );
    }

    for (const page of context.pages()) {
      if (page.isClosed()) continue;

      try {
        const state = await inspectPage(page);

        if (state === 'authenticated' && !page.isClosed()) return page;

        if (state === 'challenge') onChallenge?.();
      } catch (error) {
        // Sign-in popups can close themselves after updating the parent window.
        if (!page.isClosed()) throw error;
      }
    }

    await pause(signal);
  }

  throw new InfoMentorError(
    'LOGIN_TIMEOUT',
    'Sign-in timed out. The existing saved session was kept. Retry login or increase --timeout.',
  );
}

export async function login(options: LoginOptions = {}): Promise<void> {
  const timeout = options.timeoutMs ?? 300_000;

  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 3_600_000) {
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Login timeout must be between 1 millisecond and one hour.',
    );
  }

  throwIfAborted(options.signal);
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const deadline = Date.now() + timeout;
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser(options, false, signal);
    throwIfAborted(signal);
    const context = await browser.newContext({ viewport: null });

    const cancel = (): void => {
      void context.close().catch(() => {});
    };

    signal.addEventListener('abort', cancel, { once: true });

    try {
      throwIfAborted(signal);
      const page = await context.newPage();

      try {
        const response = await page.goto(LOGIN_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });

        if (!response?.ok() && (await inspectPage(page)) !== 'challenge')
          throw new InfoMentorError('NETWORK_ERROR', 'InfoMentor could not load its login page.');
      } catch {
        throwIfAborted(signal);
        throw new InfoMentorError(
          'NETWORK_ERROR',
          'Could not open the InfoMentor login page. Check the network and retry.',
        );
      }

      options.onProgress?.('waiting');

      const authenticated = await waitForLoginPage(context, deadline, signal, () =>
        options.onProgress?.('challenge'),
      );

      const candidate = await captureSession(context, authenticated.url());
      throwIfAborted(signal);
      await writeSession(candidate, sessionPath(options.sessionFile), signal);
      options.onProgress?.('saved');
    } finally {
      signal.removeEventListener('abort', cancel);
      await context.close().catch(() => {});
    }
  } catch (error) {
    if (timeoutSignal.aborted && !options.signal?.aborted) {
      throw new InfoMentorError(
        'LOGIN_TIMEOUT',
        'Sign-in timed out. The existing saved session was kept. Retry login or increase --timeout.',
      );
    }

    throwIfAborted(options.signal);
    throw error;
  } finally {
    await browser?.close();
  } // CDP connections disconnect without stopping the remote browser.
}

/** Validate in a headless context before replacing the destination session. */
export async function importSession(
  file: string,
  options: SessionOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const imported = await readSession(resolve(file));
  const browser = await launchBrowser(options, true, signal);

  try {
    const verified = await verifySession(browser, imported, signal);
    throwIfAborted(signal);
    await writeSession(verified, sessionPath(options.sessionFile), signal);
  } finally {
    await browser.close();
  }
}
