import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { z } from 'zod';
import { login, importSession } from './login.js';
import { installBrowser, installBrowserSchema } from './browser-install.js';
import type { InstallBrowserOptions } from './browser-install.js';
import {
  browserChoiceSchema,
  CHALLENGE_REQUIRED,
  inspectPage,
  InfoMentorError,
  launchBrowser,
  LOGIN_REQUIRED,
  openAuthenticatedPage,
  readSession,
  sessionPath,
  throwIfAborted,
  trustedUrl,
} from './session.js';
import type { Overview, SessionOptions, SessionStatus } from './session.js';

export const loginRequestSchema = z
  .object({
    importFile: z.string().refine(isAbsolute, 'Use an absolute path on the MCP host.').optional(),
    browser: browserChoiceSchema.optional(),
    executablePath: z
      .string()
      .refine(isAbsolute, 'Use an absolute browser executable path.')
      .optional(),
    cdpUrl: z.string().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();

export type LoginRequest = z.input<typeof loginRequestSchema>;

export const setupStatusSchema = z.object({
  state: z.enum(['idle', 'running', 'waiting', 'challenge', 'succeeded', 'failed', 'cancelled']),
  operation: z.enum(['login', 'import', 'install']).optional(),
  message: z.string(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** Reuses a browser and serializes reads for the lifetime of an MCP connection. */
export class InfoMentorClient {
  private active:
    | { browser: Browser; context: BrowserContext; page: Page; savedAt: string }
    | undefined;
  private pending: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;
  private closed = false;
  private loggingOut = false;
  private setup: { controller: AbortController; promise: Promise<void> } | undefined;
  private setupStatus: SetupStatus = { state: 'idle', message: 'No setup operation has started.' };

  private readonly options: SessionOptions;

  constructor(options: SessionOptions = {}) {
    this.options = { ...options };
  }

  private read<T>(read: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
    // ponytail: one queue per account/client; separate clients if multi-account use is added.
    const result = this.pending.then(async () => {
      throwIfAborted(signal);

      if (this.closed)
        throw new InfoMentorError('CANCELLED', 'This InfoMentor client has been closed.');

      if (this.setup || this.loggingOut)
        throw new InfoMentorError(
          'OPERATION_IN_PROGRESS',
          'Account setup is in progress. Call infomentor_setup_status before reading school data.',
        );

      if (Date.now() < this.cooldownUntil) {
        throw new InfoMentorError(
          'RATE_LIMITED',
          'InfoMentor requested a pause. Wait before retrying.',
          this.cooldownUntil - Date.now(),
        );
      }

      const file = sessionPath(this.options.sessionFile);
      const saved = await readSession(file);

      if (this.active?.savedAt !== saved.savedAt || !this.active.browser.isConnected()) {
        await this.closeBrowser();
        const browser = await launchBrowser(this.options);

        try {
          const context = await browser.newContext({
            storageState: saved.storageState,
            viewport: null,
          });

          this.active = { browser, context, page: await context.newPage(), savedAt: saved.savedAt };
        } catch (error) {
          await browser.close();
          throw error;
        }
      }

      const active = this.active;

      if (!active)
        throw new InfoMentorError('BROWSER_UNAVAILABLE', 'Browser session could not be created.');

      const cancel = (): void => {
        void active.page.close().catch(() => {});
      };

      signal?.addEventListener('abort', cancel, { once: true });

      try {
        if (active.page.isClosed()) active.page = await active.context.newPage();

        if ((await inspectPage(active.page)) === 'challenge') {
          throw new InfoMentorError('CHALLENGE_REQUIRED', CHALLENGE_REQUIRED);
        }

        await openAuthenticatedPage(active.context, saved.url, signal, active.page);
        const output = await read(active.page);
        throwIfAborted(signal);

        // Keep refreshed cookies in this context. Background writes could undo
        // a concurrent logout or overwrite a newly imported account session.
        return output;
      } catch (error) {
        throwIfAborted(signal);

        if (error instanceof InfoMentorError && error.code === 'RATE_LIMITED') {
          this.cooldownUntil = Date.now() + (error.retryAfterMs ?? 60_000);
        }

        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    });

    this.pending = result.then(
      () => {},
      () => {},
    );

    return result;
  }

  getOverview(signal?: AbortSignal): Promise<Overview> {
    return this.read(async (page) => {
      const texts: string[] = [];

      for (const frame of page.frames()) {
        try {
          trustedUrl(frame.url());
        } catch {
          continue;
        }

        texts.push((await frame.locator('body').innerText({ timeout: 5_000 })).trim());
      }

      const text = texts.filter(Boolean).join('\n\n');

      if (!text) throw new InfoMentorError('UNEXPECTED_PAGE', 'InfoMentor returned an empty page.');

      return {
        title: await page.title(),
        text: text.slice(0, 40_000),
        truncated: text.length > 40_000,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  async getSessionStatus(signal?: AbortSignal): Promise<SessionStatus> {
    try {
      return await this.read(async () => ({ authenticated: true }), signal);
    } catch (error) {
      if (error instanceof InfoMentorError && error.code === 'LOGIN_REQUIRED') {
        return { authenticated: false, nextStep: LOGIN_REQUIRED };
      }

      throw error;
    }
  }

  /** Starts a bounded background operation so MCP calls do not wait for human login. */
  private startSetup(
    operation: 'login' | 'import' | 'install',
    run: (signal: AbortSignal) => Promise<void>,
  ): SetupStatus {
    if (this.closed)
      throw new InfoMentorError('CANCELLED', 'This InfoMentor client has been closed.');

    if (this.setup || this.loggingOut)
      throw new InfoMentorError(
        'OPERATION_IN_PROGRESS',
        'Another setup operation is active. Check infomentor_setup_status or call infomentor_cancel_setup first.',
      );
    const controller = new AbortController();
    this.setupStatus = {
      operation,
      state: 'running',
      message: 'Setup started. Check infomentor_setup_status for progress.',
    };

    const promise = Promise.resolve()
      .then(async () => {
        await this.pending;
        throwIfAborted(controller.signal);
        await this.closeBrowser();
        await run(controller.signal);
        this.setupStatus = {
          operation,
          state: 'succeeded',
          message:
            operation === 'install'
              ? 'Browser installed. Call infomentor_login to sign in.'
              : 'Session saved. Call infomentor_session_status to verify access.',
        };
      })
      .catch((cause: unknown) => {
        this.setupStatus = {
          operation,
          state: controller.signal.aborted ? 'cancelled' : 'failed',
          message: controller.signal.aborted
            ? 'Setup cancelled. The previously saved session was kept.'
            : cause instanceof InfoMentorError
              ? cause.message
              : 'Setup failed. Check the browser, network, and session-file permissions.',
        };
      })
      .finally(() => {
        this.setup = undefined;
      });

    this.setup = { controller, promise };

    return this.getSetupStatus();
  }

  startLogin(request: LoginRequest = {}): SetupStatus {
    const parsed = loginRequestSchema.parse(request);
    const options = { ...this.options };

    if (parsed.browser !== undefined) options.browser = parsed.browser;

    if (parsed.executablePath !== undefined) options.executablePath = parsed.executablePath;

    if (parsed.cdpUrl !== undefined) options.cdpUrl = parsed.cdpUrl;

    return this.startSetup(parsed.importFile ? 'import' : 'login', async (signal) => {
      if (parsed.importFile) await importSession(parsed.importFile, options, signal);
      else
        await login({
          ...options,
          signal,
          timeoutMs: parsed.timeoutSeconds * 1000,
          onProgress: (stage) => {
            if (stage === 'saved') return;
            this.setupStatus = {
              operation: 'login',
              state: stage,
              message:
                stage === 'challenge'
                  ? 'Complete the security check in the browser. The login window stays open.'
                  : 'Sign in directly in the browser on the MCP host or connected desktop. Then check infomentor_setup_status. Never send passwords or cookies to the agent.',
            };
          },
        });
      Object.assign(this.options, options);
      this.cooldownUntil = 0;
    });
  }

  startBrowserInstall(request: InstallBrowserOptions = {}): SetupStatus {
    const options = installBrowserSchema.parse(request);

    return this.startSetup('install', (signal) => installBrowser(options, signal));
  }

  getSetupStatus(): SetupStatus {
    return { ...this.setupStatus };
  }

  async cancelSetup(): Promise<SetupStatus> {
    this.setup?.controller.abort();
    await this.setup?.promise;

    return this.getSetupStatus();
  }

  async logout(): Promise<void> {
    if (this.loggingOut)
      throw new InfoMentorError('OPERATION_IN_PROGRESS', 'Logout is already in progress.');
    this.loggingOut = true;

    try {
      await this.cancelSetup();
      await this.pending;

      try {
        await this.closeBrowser();
      } finally {
        await rm(sessionPath(this.options.sessionFile), { force: true });
      }

      this.cooldownUntil = 0;
      this.setupStatus = {
        state: 'idle',
        message: 'Local session removed. Call infomentor_login to sign in again.',
      };
    } finally {
      this.loggingOut = false;
    }
  }

  private async closeBrowser(): Promise<void> {
    const active = this.active;
    this.active = undefined;

    if (!active) return;

    try {
      await active.context.close();
    } finally {
      await active.browser.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cancelSetup();
    await this.pending;
    await this.closeBrowser();
  }
}
