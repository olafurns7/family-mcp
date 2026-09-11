import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { login, importSession } from './login.js';
import { InfoMentorHttp, parseParent, timetableSchema } from './http.js';
import {
  InfoMentorError,
  LOGIN_REQUIRED,
  PARENT_URL,
  messagesRequestSchema,
  messageRequestSchema,
  notificationsRequestSchema,
  messagesPageSchema,
  messageDetailSchema,
  notificationsDataSchema,
  readSession,
  restoreCookies,
  sessionPath,
  throwIfAborted,
} from './session.js';
import type {
  Overview,
  SessionOptions,
  SessionStatus,
  MessagesRequest,
  MessageRequest,
  NotificationsRequest,
  Messages,
  Message,
  Notifications,
} from './session.js';

export const loginRequestSchema = z
  .object({
    importFile: z.string().refine(isAbsolute, 'Use an absolute path on the MCP host.').optional(),
    credentialsFile: z
      .string()
      .refine(isAbsolute, 'Use an absolute path on the MCP host.')
      .optional(),
    localForm: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();

export type LoginRequest = z.input<typeof loginRequestSchema>;

export const setupStatusSchema = z.object({
  state: z.enum(['idle', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']),
  operation: z.enum(['login', 'import']).optional(),
  message: z.string(),
  loginUrl: z.string().optional(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** Reuses cookies and serializes account reads for one MCP connection. */
export class InfoMentorClient {
  private active: { http: InfoMentorHttp; savedAt: string } | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private closed = false;
  private loggingOut = false;
  private setup: { controller: AbortController; promise: Promise<void> } | undefined;
  private setupStatus: SetupStatus = { state: 'idle', message: 'No setup operation has started.' };
  private readonly options: SessionOptions;
  constructor(options: SessionOptions = {}) {
    this.options = { ...options };
  }

  private read<T>(
    read: (http: InfoMentorHttp, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;

    // ponytail: one queue per account/client; separate clients if multi-account use is added.
    const result = this.pending.then(async () => {
      throwIfAborted(combined);

      if (this.closed)
        throw new InfoMentorError('CANCELLED', 'This InfoMentor client has been closed.');

      if (this.setup || this.loggingOut)
        throw new InfoMentorError(
          'OPERATION_IN_PROGRESS',
          'Account setup is in progress. Check infomentor_setup_status before reading school data.',
        );
      const saved = await readSession(sessionPath(this.options.sessionFile));

      if (this.active?.savedAt !== saved.savedAt)
        this.active = { http: new InfoMentorHttp(restoreCookies(saved)), savedAt: saved.savedAt };
      const http = this.active.http;
      await http.requireAuthentication(combined);
      const output = await read(http, combined);
      throwIfAborted(combined);

      // Rotated cookies stay in memory; a background disk write could undo logout or a new login.
      return output;
    });

    this.pending = result.then(
      () => {},
      () => {},
    );

    return result;
  }

  getOverview(signal?: AbortSignal): Promise<Overview> {
    return this.read(async (http, activeSignal) => {
      const page = await http.request(PARENT_URL, undefined, activeSignal);
      const parent = parseParent(page.text);
      const hasTimetable = parent.apps.some((app) => app.codeName === 'timetable');
      let timetable: Overview['timetable'] = null;

      if (hasTimetable) {
        timetable = (
          await http.readAppData('timetable/timetable/appData', {}, timetableSchema, activeSignal)
        ).items;
      }

      const lines = parent.account.pupils.map(
        (pupil) => `${pupil.name}${pupil.selected ? ' (selected)' : ''}`,
      );

      if (timetable)
        for (const item of timetable)
          lines.push(`${item.start}: ${item.title} (${item.startTime}–${item.endTime})`);
      const text = lines.join('\n');

      return {
        title: 'InfoMentor parent overview',
        text: text.slice(0, 40_000),
        truncated: text.length > 40_000,
        children: parent.account.pupils,
        timetable,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  getMessages(request: MessagesRequest = {}, signal?: AbortSignal): Promise<Messages> {
    const input = messagesRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const data = await http.readAppData(
        'Message/message/GetMessages',
        {
          page: String(input.page),
          pageSize: String(input.pageSize),
          messageText: input.search,
          inbox: String(input.folder === 'inbox'),
          sentItems: String(input.folder === 'sent'),
        },
        messagesPageSchema,
        activeSignal,
      );

      // The live endpoint reports page: 0 even when it correctly applies a requested page.
      return {
        ...data,
        page: input.page,
        pageSize: input.pageSize,
        folder: input.folder,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  getMessage(request: MessageRequest, signal?: AbortSignal): Promise<Message> {
    const { id } = messageRequestSchema.parse(request);

    return this.read(
      async (http, activeSignal) => ({
        message: await http.readAppData(
          'Message/message/GetMessage',
          { id: String(id) },
          messageDetailSchema,
          activeSignal,
        ),
        retrievedAt: new Date().toISOString(),
      }),
      signal,
    );
  }

  getNotifications(
    request: NotificationsRequest = {},
    signal?: AbortSignal,
  ): Promise<Notifications> {
    const input = notificationsRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const data = await http.readAppData(
        'NotificationApp/NotificationApp/appData',
        {},
        notificationsDataSchema,
        activeSignal,
      );

      return {
        notifications: data.notifications.filter(
          (item) =>
            (input.includeCleared || item.state !== 'Cleared') &&
            (!input.selectedChildOnly || item.currentlySelectedPupil),
        ),
        ...input,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  async getSessionStatus(signal?: AbortSignal): Promise<SessionStatus> {
    try {
      return await this.read(async () => ({ authenticated: true }), signal);
    } catch (error) {
      if (error instanceof InfoMentorError && error.code === 'LOGIN_REQUIRED')
        return { authenticated: false, nextStep: LOGIN_REQUIRED };
      throw error;
    }
  }

  startLogin(request: LoginRequest = {}): SetupStatus {
    const parsed = loginRequestSchema.parse(request);

    if (parsed.importFile && (parsed.credentialsFile || parsed.localForm))
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Choose session import or login, not both.',
      );

    if (this.closed)
      throw new InfoMentorError('CANCELLED', 'This InfoMentor client has been closed.');

    if (this.setup || this.loggingOut)
      throw new InfoMentorError(
        'OPERATION_IN_PROGRESS',
        'Another setup operation is active. Check its status or cancel it first.',
      );
    const operation = parsed.importFile ? 'import' : 'login';
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
        this.active = undefined;

        if (parsed.importFile)
          await importSession(parsed.importFile, this.options, controller.signal);
        else {
          const options = {
            ...this.options,
            signal: controller.signal,
            localForm: parsed.localForm ?? false,
            timeoutMs: parsed.timeoutSeconds * 1000,
            onProgress: (stage: 'waiting' | 'saved', loginUrl?: string): void => {
              if (stage === 'saved') return;
              this.setupStatus = {
                operation,
                state: 'waiting',
                message:
                  'Open the private local sign-in form. Never send passwords or session cookies to the agent.',
              };

              if (loginUrl) this.setupStatus.loginUrl = loginUrl;
            },
          };

          await login(
            parsed.credentialsFile
              ? { ...options, credentialsFile: parsed.credentialsFile }
              : options,
          );
        }

        this.setupStatus = {
          operation,
          state: 'succeeded',
          message: 'Session saved. Call infomentor_session_status to verify access.',
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
              : 'Setup failed. Check the network and session-file permissions.',
        };
      })
      .finally(() => {
        this.setup = undefined;
      });

    this.setup = { controller, promise };

    return this.getSetupStatus();
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
      this.active = undefined;
      await rm(sessionPath(this.options.sessionFile), { force: true });
      this.setupStatus = {
        state: 'idle',
        message: 'Local session removed. Call infomentor_login to sign in again.',
      };
    } finally {
      this.loggingOut = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await this.cancelSetup();
    await this.pending;
    this.active = undefined;
  }
}
