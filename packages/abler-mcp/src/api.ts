import { readBody, SafeError } from '@family-mcp/mcp-runtime';
import type { KeyProvider } from '@family-mcp/session-store';
import { Cookie, type CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

import {
  AUTH_COOKIES,
  ExpiredSession,
  ORIGIN,
  sessionPath,
  withSession,
  type SaveJar,
  type Slot,
} from './auth.js';

const id = z.string().min(1).max(256);

const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;

const date = z.iso.date();

type GraphqlValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Record<string, string | string[]>
  | { first: number; after: string | null };

type GraphqlVariables = Record<string, GraphqlValue>;

type GraphqlBody = {
  operationName: string;
  query: string;
  variables: GraphqlVariables;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const scheduleFields = z.strictObject({
  from: date
    .optional()
    .describe("First calendar date, YYYY-MM-DD, as used by Abler's date filter."),
  to: date.optional().describe('Last calendar date, YYYY-MM-DD.'),
  types: z
    .array(z.enum(['TRAINING', 'MATCH', 'GENERAL', 'CLASSES']))
    .max(4)
    .optional(),
  groupIds: z
    .array(id)
    .min(1)
    .max(50)
    .optional()
    .describe('Subgroup IDs from list_groups, not age-group IDs.'),
  participantIds: z.array(id).min(1).max(20).optional().describe('Player IDs from get_profile.'),
  first: z.number().int().min(1).max(100).default(20),
  after: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('Opaque endCursor from the previous page; keep filters unchanged.'),
});

export const scheduleInput = scheduleFields.refine((v) => !v.from || !v.to || v.from <= v.to, {
  message: 'from must be on or before to',
});

export const childSchedulesInput = scheduleFields
  .omit({ participantIds: true, after: true })
  .extend({
    childIds: z
      .array(id)
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Linked child IDs from get_profile. Omit for all children; IDs distinguish children with the same name.',
      ),
    first: scheduleFields.shape.first.describe(
      'Maximum events per child, independently paginated.',
    ),
    afterByChild: z
      .record(id, scheduleFields.shape.after.unwrap())
      .optional()
      .describe(
        "Map child ID to that child's endCursor. To continue one child, also select only that ID in childIds. Keep filters unchanged.",
      ),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must be on or before to' });

export const eventInput = z.strictObject({ eventId: id, ageGroupId: id });

const messagePageFields = {
  first: z.number().int().min(1).max(50).default(20),
  after: scheduleFields.shape.after,
};

export const conversationsInput = z.strictObject(messagePageFields);

export const messagesInput = z.strictObject({
  conversationId: id.describe('Conversation id from list_conversations.'),
  ...messagePageFields,
});

const person = z.object({ id, displayName: z.string() });

const profileSchema = person.extend({ children: z.array(person) });

export const profileResultSchema = profileSchema.extend({
  childNamesById: z.record(z.string(), z.string()),
});

export const statusResultSchema = z.object({ authenticated: z.literal(true), account: person });

const attendanceSchema = z.array(
  z.object({ status: z.string().nullable(), coachStatus: z.string().nullable(), player: person }),
);

const graphqlResponseSchema = z.object({
  data: z.record(z.string(), z.json()).nullish(),
  errors: z
    .array(z.object({ extensions: z.object({ code: z.string().optional() }).nullish() }).nullable())
    .nullish(),
});

export const eventSchema = z.object({
  eventId: id,
  name: z.string(),
  type: z.string().optional(),
  description: z.string().nullable().optional(),
  from: z.string(),
  to: z.string().nullable(),
  status: z.string().optional(),
  // Abler sends this as a number (minutes before `from`); keep strings for older shapes.
  arrivalTime: z.union([z.string(), z.number()]).nullable().optional(),
  locationDetails: z.string().nullable().optional(),
  locationAddress: z.string().nullable().optional(),
  locationLink: z.string().nullable().optional(),
  ageGroup: z.object({ id, name: z.string() }),
  groups: z.array(z.object({ id, name: z.string() })).optional(),
  currentPlayerAttendance: attendanceSchema,
});

const subgroupSchema = z.object({ id, name: z.string(), label: z.string().nullish() });

const groupSchema = z.object({
  id,
  name: z.string(),
  isActive: z.boolean().optional(),
  groups: z.array(subgroupSchema).optional(),
  sport: z.object({ id, name: z.string() }).nullish(),
});

export const groupsResultSchema = z.object({ groups: z.array(groupSchema) });

const eventFields = `
  eventId name type description from to status arrivalTime
  locationDetails locationAddress locationLink
  ageGroup { id name }
  groups { id name }
  currentPlayerAttendance { status coachStatus player { id displayName } }
`;

const pageFields = `pageInfo { hasNextPage endCursor }`;

const pageOf = <T extends z.ZodType>(node: T) =>
  z
    .object({
      edges: z.array(z.object({ node })),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    })
    .refine(
      (page) =>
        !page.pageInfo.hasNextPage || (page.edges.length > 0 && Boolean(page.pageInfo.endCursor)),
      {
        message: 'Abler returned an incomplete pagination cursor.',
      },
    );

const pageSchema = pageOf(eventSchema);

export const scheduleResultSchema = z.object({
  events: z.array(eventSchema),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});

export const childSchedulesResultSchema = z.object({
  children: z.array(
    z.object({
      child: person,
      events: z.array(
        eventSchema.omit({ currentPlayerAttendance: true }).extend({
          attendance: z.array(
            z.object({ status: z.string().nullable(), coachStatus: z.string().nullable() }),
          ),
        }),
      ),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  ),
});

const messageFields = `
  id messageBody createdAt
  creator { id displayName }
  attachments { id fileName description contentType }
  recipient { isRead }
`;

// Upstream shapes accept null or missing fields more widely than observed.
const upstreamMessageSchema = z.object({
  id,
  messageBody: z.string().nullish(),
  createdAt: z.string(),
  creator: person.nullish(),
  attachments: z
    .array(
      z.object({
        id,
        fileName: z.string(),
        description: z.string().nullish(),
        contentType: z.string(),
      }),
    )
    .nullish(),
  recipient: z.object({ isRead: z.boolean().nullish() }).nullish(),
});

const upstreamConversationSchema = z.object({
  id,
  name: z.string().nullish(),
  conversationType: z.string(),
  membersCount: z.number().nullish(),
  unreadCount: z.number(),
  messageGroup: z.object({ id, name: z.string() }).nullish(),
  user1: person.nullish(),
  user2: person.nullish(),
  messages: z.object({ edges: z.array(z.object({ node: upstreamMessageSchema })) }).nullish(),
});

const conversationPageSchema = pageOf(upstreamConversationSchema);

const messagePageSchema = pageOf(upstreamMessageSchema);

const messageSchema = z.object({
  id,
  body: z.string().nullable(),
  createdAt: z.string(),
  sender: person.nullable(),
  read: z.boolean().nullable(),
  attachments: z.array(
    z.object({
      id,
      fileName: z.string(),
      description: z.string().nullable(),
      contentType: z.string(),
    }),
  ),
});

export const conversationsResultSchema = z.object({
  unreadCount: z.number(),
  conversations: z.array(
    z.object({
      id,
      name: z.string().nullable(),
      type: z.string(),
      membersCount: z.number().nullable(),
      unreadCount: z.number(),
      group: z.object({ id, name: z.string() }).nullable(),
      participants: z.array(person),
      latestMessage: messageSchema.nullable(),
    }),
  ),
  pageInfo: scheduleResultSchema.shape.pageInfo,
});

export const messagesResultSchema = z.object({
  messages: z.array(messageSchema),
  pageInfo: scheduleResultSchema.shape.pageInfo,
});

function toMessage(message: z.infer<typeof upstreamMessageSchema>) {
  return {
    id: message.id,
    body: message.messageBody ?? null,
    createdAt: message.createdAt,
    sender: message.creator ?? null,
    read: message.recipient?.isRead ?? null,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      description: attachment.description ?? null,
      contentType: attachment.contentType,
    })),
  };
}

function toConversation(conversation: z.infer<typeof upstreamConversationSchema>) {
  const latest = conversation.messages?.edges[0]?.node;

  return {
    id: conversation.id,
    name: conversation.name ?? null,
    type: conversation.conversationType,
    membersCount: conversation.membersCount ?? null,
    unreadCount: conversation.unreadCount,
    group: conversation.messageGroup ?? null,
    participants: [conversation.user1, conversation.user2].flatMap((user) => (user ? [user] : [])),
    latestMessage: latest ? toMessage(latest) : null,
  };
}

/** The jar of one held operation, and how to persist its rotation. */
type Session = { jar: CookieJar; save: SaveJar };

export class AblerClient {
  private readonly lifecycle = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly path = sessionPath(),
    private readonly request: (url: string, options: RequestInit) => Promise<Response> = fetch,
    private readonly keys?: KeyProvider,
    /** `candidate` verifies a new session before it is promoted; its rotations stay there. */
    private readonly slot: Slot = 'current',
  ) {}

  private session<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const operation = withSession(
      this.path,
      this.slot,
      this.lifecycle.signal,
      (jar, save) => work({ jar, save }),
      this.keys,
    );

    this.active.add(operation);

    return operation.finally(() => this.active.delete(operation));
  }

  async close(): Promise<void> {
    this.lifecycle.abort();
    await Promise.allSettled(this.active);
  }

  private async post(
    { jar, save }: Session,
    path: '/oauth/token' | '/graphql',
    body?: GraphqlBody,
  ): Promise<Response> {
    let response: Response;
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(20000)]);

    try {
      const options: RequestInit = {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Cookie: await jar.getCookieString(`${ORIGIN}${path}`),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      };

      if (body !== undefined) options.body = JSON.stringify(body);
      response = await this.request(`${ORIGIN}${path}`, options);
    } catch {
      throw new SafeError('Abler request failed or timed out. Check the connection and try again.');
    }

    let changed = false;

    try {
      for (const header of response.headers.getSetCookie()) {
        const cookie = Cookie.parse(header);

        if (!cookie || !AUTH_COOKIES.has(cookie.key)) continue;
        cookie.secure = true;
        await jar.setCookie(cookie, `${ORIGIN}${path}`);
        changed = true;
      }
    } catch {
      // Cookie-library errors can include untrusted response headers.
      throw new SafeError('Abler returned an invalid authentication cookie.');
    }

    // Persist rotation before another request, including when Abler returns an error.
    if (changed) await save();

    return response;
  }

  private async readJson(response: Response): Promise<JsonValue> {
    try {
      return z
        .json()
        .parse(
          JSON.parse(await readBody(response, MAX_RESPONSE_BODY_BYTES, this.lifecycle.signal)),
        );
    } catch {
      return null;
    }
  }

  private async refresh(session: Session): Promise<void> {
    const response = await this.post(session, '/oauth/token');

    if ([401, 403].includes(response.status))
      throw new ExpiredSession(
        'Abler session expired or was revoked. Sign in again and capture/import it.',
      );

    if (!response.ok)
      throw new SafeError('Abler session refresh failed. Check your session and try again.');

    const result = z
      .object({ access_token: z.string().min(1), error: z.unknown().optional() })
      .safeParse(await this.readJson(response));

    if (!result.success || result.data.error)
      throw new SafeError('Abler returned an invalid session refresh response.');

    if (!(await session.jar.getCookies(`${ORIGIN}/graphql`)).some((c) => c.key === 'id_token')) {
      throw new SafeError('Abler did not issue an access cookie. Capture a fresh session.');
    }
  }

  private async query(
    session: Session,
    operationName: string,
    query: string,
    variables: GraphqlVariables = {},
    forceRefresh = false,
  ): Promise<Record<string, JsonValue>> {
    const access = (await session.jar.getCookies(`${ORIGIN}/graphql`)).find(
      (c) => c.key === 'id_token',
    );

    if (forceRefresh || !access || access.TTL() < 60000) await this.refresh(session);
    const body = { operationName, query, variables };
    let response = await this.post(session, '/graphql', body);
    let result = graphqlResponseSchema.safeParse(await this.readJson(response));

    if (
      response.status === 401 ||
      (result.success &&
        result.data.errors?.some((error) => error?.extensions?.code === 'UNAUTHENTICATED'))
    ) {
      await this.refresh(session);
      response = await this.post(session, '/graphql', body);
      result = graphqlResponseSchema.safeParse(await this.readJson(response));
    }

    if (!response.ok) throw new SafeError('Abler returned an error for the requested operation.');

    if (!result.success) throw new SafeError('Abler returned an invalid API response.');

    if (result.data.errors?.length) {
      // Server messages may contain private values. Never echo raw response bodies.
      throw new SafeError(
        'Abler rejected the request. The session may lack permission, or the API may have changed.',
      );
    }

    if (!result.data.data) throw new SafeError('Abler returned no data.');

    return result.data.data;
  }

  async status(forceRefresh = false) {
    // Use an authenticated read so 'authenticated' never means only 'file exists'.
    return this.session(async (session) => {
      const data = await this.query(
        session,
        'SessionStatus',
        'query SessionStatus { me { id displayName } }',
        {},
        forceRefresh,
      );

      return { authenticated: true, account: person.parse(data.me) };
    });
  }

  async profile() {
    return this.session((session) => this.profileWithSession(session));
  }

  private async profileWithSession(session: Session) {
    const data = await this.query(
      session,
      'Profile',
      `query Profile { me { id displayName children { id displayName } } }`,
    );

    if (!data.me) throw new SafeError('Abler returned no signed-in user.');
    const profile = profileSchema.parse(data.me);

    return profileResultSchema.parse({
      ...profile,
      childNamesById: Object.fromEntries(
        profile.children.map((child) => [child.id, child.displayName]),
      ),
    });
  }

  async groups() {
    return this.session(async (session) => {
      const data = await this.query(
        session,
        'Groups',
        `query Groups { me { userAgeGroups {
        id name isActive groups { id name label } sport { id name }
      } } }`,
      );

      const groups = z.object({ userAgeGroups: z.array(groupSchema) }).parse(data.me).userAgeGroups;

      return groups;
    });
  }

  async schedule(input: z.input<typeof scheduleInput> = {}) {
    const filters = scheduleInput.parse(input);

    return this.session((session) => this.scheduleWithSession(session, filters));
  }

  private async scheduleWithSession(session: Session, input: z.input<typeof scheduleInput>) {
    const { from, to, types, groupIds, participantIds, first, after } = scheduleInput.parse(input);

    const filter: Record<string, string | string[]> = {};

    if (from) filter.dateFrom = from;

    if (to) filter.dateTo = to;

    if (types) filter.label = types;

    if (groupIds) filter.group = groupIds;

    if (participantIds) filter.participant = participantIds;

    const variables = {
      first,
      cursor: after ?? null,
    };

    if (Object.keys(filter).length) Object.assign(variables, { filter });

    const data = await this.query(
      session,
      'Schedule',
      `query Schedule($first: Int, $cursor: String, $filter: eventFilter) {
      schedule(first: $first, after: $cursor, filter: $filter) { edges { node { ${eventFields} } } ${pageFields} }
    }`,
      variables,
    );

    const page = pageSchema.parse(data.schedule);

    if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === after) {
      throw new SafeError(
        'Abler pagination did not advance. Retry later; do not report this schedule as complete.',
      );
    }

    return scheduleResultSchema.parse({
      events: page.edges.map((e) => e.node),
      pageInfo: page.pageInfo,
    });
  }

  async childSchedules(input: z.input<typeof childSchedulesInput> = {}) {
    const { childIds, afterByChild = {}, ...filters } = childSchedulesInput.parse(input);

    return this.session(async (session) => {
      const profile = await this.profileWithSession(session);

      if (childIds?.some((childId) => !Object.hasOwn(profile.childNamesById, childId))) {
        throw new SafeError('Unknown child ID. Use get_profile to choose linked children.');
      }

      const selected = profile.children.filter((child) => !childIds || childIds.includes(child.id));

      if (
        Object.keys(afterByChild).some((childId) => !selected.some((child) => child.id === childId))
      ) {
        throw new SafeError(
          'A cursor was supplied for an unselected child. Match afterByChild keys to childIds.',
        );
      }

      const children = [];

      for (const child of selected) {
        // Each child gets an upstream-filtered page, so another child's busy schedule cannot hide theirs.
        const childFilters = {
          ...filters,
          participantIds: [child.id],
          after: afterByChild[child.id],
        };

        const page = await this.scheduleWithSession(session, childFilters);

        const events = page.events.map(({ currentPlayerAttendance, ...event }) => ({
          ...event,
          attendance: attendanceSchema
            .parse(currentPlayerAttendance)
            .filter((row) => row.player.id === child.id)
            .map(({ status, coachStatus }) => ({ status, coachStatus })),
        }));

        children.push({ child, events, pageInfo: page.pageInfo });
      }

      return childSchedulesResultSchema.parse({ children });
    });
  }

  async event(input: z.input<typeof eventInput>) {
    const { eventId, ageGroupId } = eventInput.parse(input);

    return this.session(async (session) => {
      const data = await this.query(
        session,
        'Event',
        `query Event($id: String!, $ageGroupId: String!) {
        event(id: $id, ageGroupId: $ageGroupId, first: 1) { edges { node { ${eventFields} } } ${pageFields} }
      }`,
        { id: eventId, ageGroupId },
      );

      const page = pageSchema.parse(data.event);
      const event = page.edges[0]?.node;

      if (!event) throw new SafeError('Event not found or not accessible with this session.');

      if (event.eventId !== eventId || event.ageGroup.id !== ageGroupId) {
        throw new SafeError('Abler returned a different event than requested.');
      }

      return eventSchema.parse(event);
    });
  }

  async conversations(input: z.input<typeof conversationsInput> = {}) {
    const { first, after } = conversationsInput.parse(input);

    return this.session(async (session) => {
      const data = await this.query(
        session,
        'Conversations',
        `query Conversations($first: Int, $cursor: String) {
        getMessageUnreadCount
        message(first: $first, after: $cursor) {
          edges { node {
            id name conversationType membersCount unreadCount
            messageGroup { id name }
            user1 { id displayName }
            user2 { id displayName }
            messages(first: 1) { edges { node { ${messageFields} } } }
          } }
          ${pageFields}
        }
      }`,
        { first, cursor: after ?? null },
      );

      const page = conversationPageSchema.parse(data.message);

      if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === after) {
        throw new SafeError(
          'Abler pagination did not advance. Retry later; do not report these conversations as complete.',
        );
      }

      return conversationsResultSchema.parse({
        unreadCount: data.getMessageUnreadCount,
        conversations: page.edges.map((edge) => toConversation(edge.node)),
        pageInfo: page.pageInfo,
      });
    });
  }

  async messages(input: z.input<typeof messagesInput>) {
    const { conversationId, first, after } = messagesInput.parse(input);

    return this.session(async (session) => {
      const data = await this.query(
        session,
        'ConversationMessages',
        `query ConversationMessages($pagination: PaginationType!, $conversationIds: [ID!]) {
        conversationMessages(pagination: $pagination, conversationIds: $conversationIds) {
          edges { node { ${messageFields} } }
          ${pageFields}
        }
      }`,
        { pagination: { first, after: after ?? null }, conversationIds: [conversationId] },
      );

      const page = messagePageSchema.parse(data.conversationMessages);

      if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === after) {
        throw new SafeError(
          'Abler pagination did not advance. Retry later; do not report these messages as complete.',
        );
      }

      return messagesResultSchema.parse({
        messages: page.edges.map((edge) => toMessage(edge.node)),
        pageInfo: page.pageInfo,
      });
    });
  }
}
