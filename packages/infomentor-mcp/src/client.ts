import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  login,
  importSession,
  createAuthenticatedHttp,
  hasConfiguredCredentials,
  httpFromSession,
  sessionFromHttp,
} from './login.js';
import { withSessionLock } from './lock.js';
import {
  collectUpdates,
  collectRequestSchema,
  type CollectRequest,
  type Collection,
} from './collection.js';
import type { InfoMentorHttp } from './http.js';
import {
  InfoMentorError,
  selectChildRequestSchema,
  messagesRequestSchema,
  messageRequestSchema,
  notificationsRequestSchema,
  messagesPageResponseSchema,
  messageDetailSchema,
  notificationsResponseSchema,
  timetableResponseSchema,
  readSession,
  sessionPath,
  throwIfAborted,
  writeSession,
  type Overview,
  type SelectChildRequest,
  type SessionOptions,
  type SessionStatus,
  type MessagesRequest,
  type MessageRequest,
  type NotificationsRequest,
  type Messages,
  type Message,
  type Notifications,
  type SavedSession,
} from './session.js';

export const loginRequestSchema = z
  .object({
    importFile: z.string().refine(isAbsolute, 'Use an absolute path on the MCP host.').optional(),
    credentialsFile: z
      .string()
      .refine(isAbsolute, 'Use an absolute path on the MCP host.')
      .optional(),
    allowAccountChange: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();

export type LoginRequest = z.input<typeof loginRequestSchema>;

export const setupStatusSchema = z.object({
  state: z.enum(['idle', 'running', 'succeeded', 'failed', 'cancelled']),
  operation: z.enum(['login', 'import']).optional(),
  message: z.string(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

function comparableSession(session: SavedSession): string {
  return JSON.stringify({
    accountId: session.accountId,
    selectedChildId: session.selectedChildId,
    rateLimitedUntil: session.rateLimitedUntil,
    cookies: session.cookies.map(({ lastAccessed: _lastAccessed, ...cookie }) => cookie),
  });
}

/** Reuses cookies and serializes account requests for one MCP connection. */
export class InfoMentorClient {
  private active: { http: InfoMentorHttp; serializedSession: string } | undefined;
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

    // A local queue preserves call order; the file lock also excludes other MCP processes.
    const result = this.pending.then(async () => {
      throwIfAborted(combined);

      if (this.closed)
        throw new InfoMentorError('CANCELLED', 'This InfoMentor client has been closed.');

      if (this.setup || this.loggingOut)
        throw new InfoMentorError(
          'OPERATION_IN_PROGRESS',
          'Account setup is in progress. Check infomentor_setup_status before reading school data.',
        );
      const file = sessionPath(this.options.sessionFile);

      return withSessionLock(file, combined, async () => {
        let saved = await readSession(file);

        if (this.active?.serializedSession !== JSON.stringify(saved))
          this.active = {
            http: httpFromSession(saved, this.options.fetch),
            serializedSession: JSON.stringify(saved),
          };
        let http = this.active.http;
        let preserveSession = false;

        try {
          // A validated parent page already proves authentication and is reused by the read below.
          const parent = await http.readParent(combined);

          if (saved.accountId && parent.account.currentUser.id !== saved.accountId)
            throw new InfoMentorError(
              'INVALID_SESSION',
              'The saved session no longer matches its verified account. Sign in explicitly before continuing.',
            );
          saved = await this.saveActive(http, saved, combined);
          const output = await read(http, combined);
          throwIfAborted(combined);

          return output;
        } catch (cause) {
          if (!(cause instanceof InfoMentorError) || cause.code !== 'LOGIN_REQUIRED') throw cause;
          preserveSession = true;

          if (!hasConfiguredCredentials(this.options)) throw cause;
          const accountId = saved.accountId ?? http.parent?.account.currentUser.id;

          if (!accountId)
            throw new InfoMentorError(
              'LOGIN_REQUIRED',
              'This older session expired before its account could be verified. Call infomentor_login once to enable automatic authentication refresh.',
            );
          const selectedChildId = saved.selectedChildId;

          const candidate = await createAuthenticatedHttp({
            ...this.options,
            signal: combined,
            timeoutMs: 60_000,
          });

          if (candidate.parent?.account.currentUser.id !== accountId)
            throw new InfoMentorError(
              'LOGIN_REQUIRED',
              'The configured credentials belong to a different InfoMentor account. The previous session was kept. Correct the private credentials or explicitly sign in to change accounts.',
            );

          if (selectedChildId) await candidate.readParent(combined, selectedChildId);
          saved = await this.saveActive(candidate, saved, combined);
          http = candidate;
          preserveSession = false;
          // Only confirmed authentication expiry replays a read, once. Other failures propagate.
          const output = await read(http, combined);
          throwIfAborted(combined);

          return output;
        } finally {
          if (!preserveSession && !combined.aborted) await this.saveActive(http, saved, combined);
        }
      });
    });

    this.pending = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private async saveActive(
    http: InfoMentorHttp,
    previous: SavedSession,
    signal: AbortSignal,
  ): Promise<SavedSession> {
    const current = sessionFromHttp(http);

    if (previous.accountId && current.accountId && current.accountId !== previous.accountId)
      throw new InfoMentorError(
        'INVALID_SESSION',
        'Refusing to replace the verified account during a school-data request. Sign in explicitly to change accounts.',
      );

    if (!current.accountId && previous.accountId) current.accountId = previous.accountId;

    if (!current.selectedChildId && previous.selectedChildId)
      current.selectedChildId = previous.selectedChildId;

    if (comparableSession(current) === comparableSession(previous)) {
      this.active = { http, serializedSession: JSON.stringify(previous) };

      return previous;
    }

    await (this.options.writeSession ?? writeSession)(
      current,
      sessionPath(this.options.sessionFile),
      signal,
    );
    this.active = { http, serializedSession: JSON.stringify(current) };

    return current;
  }

  getOverview(signal?: AbortSignal): Promise<Overview> {
    return this.read((http, activeSignal) => this.overview(http, activeSignal), signal);
  }

  selectChild(request: SelectChildRequest, signal?: AbortSignal): Promise<Overview> {
    const { childId } = selectChildRequestSchema.parse(request);

    return this.read((http, activeSignal) => this.overview(http, activeSignal, childId), signal);
  }

  collectUpdates(request: CollectRequest = {}, signal?: AbortSignal): Promise<Collection> {
    const input = collectRequestSchema.parse(request);
    const deadline = AbortSignal.timeout(5 * 60_000);
    const collectionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

    return this.read((http, activeSignal) => {
      let cachedParent = http.parent;

      const getParent = (nextSignal: AbortSignal) => {
        if (cachedParent) {
          const parent = cachedParent;
          cachedParent = undefined;

          return Promise.resolve(parent);
        }

        return http.readParent(nextSignal);
      };

      return collectUpdates(input, {
        sessionFile: sessionPath(this.options.sessionFile),
        signal: activeSignal,
        getParent,
        selectChild: (childId, nextSignal) => http.readParent(nextSignal, childId),
        readTimetable: async (parent, nextSignal) =>
          parent.apps.some((app) => app.codeName === 'timetable')
            ? await http.readAppData(
                'timetable/timetable/appData',
                {},
                timetableResponseSchema,
                nextSignal,
              )
            : null,
        getMessages: (folder, page, nextSignal) =>
          http.readAppData(
            'Message/message/GetMessages',
            {
              page: String(page),
              pageSize: '100',
              messageText: '',
              inbox: String(folder === 'inbox'),
              sentItems: String(folder === 'sent'),
            },
            messagesPageResponseSchema,
            nextSignal,
          ),
        getMessage: (id, nextSignal) =>
          http.readAppData(
            'Message/message/GetMessage',
            { id: String(id) },
            messageDetailSchema,
            nextSignal,
          ),
        getNotifications: (nextSignal) =>
          http.readAppData(
            'NotificationApp/NotificationApp/appData',
            {},
            notificationsResponseSchema,
            nextSignal,
          ),
      });
    }, collectionSignal);
  }

  private async overview(
    http: InfoMentorHttp,
    signal: AbortSignal,
    childId?: string,
  ): Promise<Overview> {
    let selectionAttempted = false;

    try {
      selectionAttempted = childId !== undefined;

      const parent =
        childId === undefined && http.parent ? http.parent : await http.readParent(signal, childId);

      const hasTimetable = parent.apps.some((app) => app.codeName === 'timetable');
      let timetable: Overview['timetable'] = null;
      let skipped = 0;

      if (hasTimetable) {
        const feed = await http.readAppData(
          'timetable/timetable/appData',
          {},
          timetableResponseSchema,
          signal,
        );

        timetable = feed.items;
        skipped = feed.skipped;
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
        children: parent.account.pupils.map(({ id, name, selected }) => ({ id, name, selected })),
        timetable,
        skipped,
        retrievedAt: new Date().toISOString(),
      };
    } catch (cause) {
      if (!selectionAttempted) throw cause;
      const error = cause instanceof InfoMentorError ? cause : undefined;

      throw new InfoMentorError(
        error?.code ?? 'UNEXPECTED_PAGE',
        'InfoMentor could not load the selected child. Selection may have changed; refresh infomentor_get_overview before continuing.',
        error?.retryAfterMs,
      );
    }
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
        messagesPageResponseSchema,
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
        notificationsResponseSchema,
        activeSignal,
      );

      return {
        notifications: data.notifications.filter(
          (item) =>
            (input.includeCleared || item.state !== 'Cleared') &&
            (!input.selectedChildOnly || item.currentlySelectedPupil),
        ),
        skipped: data.skipped,
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
        return { authenticated: false, nextStep: error.message };
      throw error;
    }
  }

  startLogin(request: LoginRequest = {}): SetupStatus {
    const parsed = loginRequestSchema.parse(request);

    if (parsed.importFile && parsed.credentialsFile)
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

    const promise = (async () => {
      await this.pending;
      throwIfAborted(controller.signal);
      this.active = undefined;

      if (parsed.importFile)
        await importSession(
          parsed.importFile,
          { ...this.options, allowAccountChange: parsed.allowAccountChange ?? false },
          controller.signal,
        );
      else {
        const options = {
          ...this.options,
          signal: controller.signal,
          allowAccountChange: parsed.allowAccountChange ?? false,
          timeoutMs: parsed.timeoutSeconds * 1000,
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
    })()
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
      const file = sessionPath(this.options.sessionFile);
      await withSessionLock(file, undefined, async () => {
        await rm(file, { force: true });
        // Snapshots hold fingerprints and identifiers of the account; they leave with the session.
        await rm(file + '.collections', { recursive: true, force: true });
      });
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
