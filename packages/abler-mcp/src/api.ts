import { SafeError } from '@family-mcp/mcp-runtime';
import { Cookie, type CookieJar } from 'tough-cookie';
import * as z from 'zod/v4';

import {
  AUTH_COOKIES,
  ORIGIN,
  loadSession,
  saveSession,
  sessionPath,
  withSessionLock,
} from './auth.js';

const id = z.string().min(1).max(256);

const date = z.iso.date();

type GraphqlValue = string | number | boolean | null | string[] | Record<string, string | string[]>;

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
  arrivalTime: z.string().nullable().optional(),
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

const pageSchema = z
  .object({
    edges: z.array(z.object({ node: eventSchema })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  })
  .refine(
    (page) =>
      !page.pageInfo.hasNextPage || (page.edges.length > 0 && Boolean(page.pageInfo.endCursor)),
    {
      message: 'Abler returned an incomplete pagination cursor.',
    },
  );

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

export class AblerClient {
  private readonly lifecycle = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly path = sessionPath(),
    private readonly request: (url: string, options: RequestInit) => Promise<Response> = fetch,
  ) {}

  private session<T>(work: (jar: CookieJar) => Promise<T>): Promise<T> {
    const operation = withSessionLock(
      this.path,
      async () => work(await loadSession(this.path)),
      this.lifecycle.signal,
    );

    this.active.add(operation);

    return operation.finally(() => this.active.delete(operation));
  }

  async close(): Promise<void> {
    this.lifecycle.abort();
    await Promise.allSettled(this.active);
  }

  private async post(
    jar: CookieJar,
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

    for (const header of response.headers.getSetCookie()) {
      const cookie = Cookie.parse(header);

      if (!cookie || !AUTH_COOKIES.has(cookie.key)) continue;
      cookie.secure = true;
      await jar.setCookie(cookie, `${ORIGIN}${path}`);
      changed = true;
    }

    // Persist rotation before another request, including when Abler returns an error.
    if (changed) await saveSession(this.path, jar);

    return response;
  }

  private async refresh(jar: CookieJar): Promise<void> {
    const response = await this.post(jar, '/oauth/token');

    if ([401, 403].includes(response.status))
      throw new SafeError(
        'Abler session expired or was revoked. Sign in again and capture/import it.',
      );

    if (!response.ok)
      throw new SafeError('Abler session refresh failed. Check your session and try again.');

    const result = z
      .object({ access_token: z.string().min(1), error: z.unknown().optional() })
      .safeParse(await response.json().catch(() => null));

    if (!result.success || result.data.error)
      throw new SafeError('Abler returned an invalid session refresh response.');

    if (!(await jar.getCookies(`${ORIGIN}/graphql`)).some((c) => c.key === 'id_token')) {
      throw new SafeError('Abler did not issue an access cookie. Capture a fresh session.');
    }
  }

  private async query(
    jar: CookieJar,
    operationName: string,
    query: string,
    variables: GraphqlVariables = {},
    forceRefresh = false,
  ): Promise<Record<string, JsonValue>> {
    const access = (await jar.getCookies(`${ORIGIN}/graphql`)).find((c) => c.key === 'id_token');

    if (forceRefresh || !access || access.TTL() < 60000) await this.refresh(jar);
    const body = { operationName, query, variables };
    let response = await this.post(jar, '/graphql', body);
    let result = graphqlResponseSchema.safeParse(await response.json().catch(() => null));

    if (
      response.status === 401 ||
      (result.success &&
        result.data.errors?.some((error) => error?.extensions?.code === 'UNAUTHENTICATED'))
    ) {
      await this.refresh(jar);
      response = await this.post(jar, '/graphql', body);
      result = graphqlResponseSchema.safeParse(await response.json().catch(() => null));
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
    return this.session(async (jar) => {
      const data = await this.query(
        jar,
        'SessionStatus',
        'query SessionStatus { me { id displayName } }',
        {},
        forceRefresh,
      );

      return { authenticated: true, account: person.parse(data.me) };
    });
  }

  async profile() {
    return this.session((jar) => this.profileWithSession(jar));
  }

  private async profileWithSession(jar: CookieJar) {
    const data = await this.query(
      jar,
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
    return this.session(async (jar) => {
      const data = await this.query(
        jar,
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

    return this.session((jar) => this.scheduleWithSession(jar, filters));
  }

  private async scheduleWithSession(jar: CookieJar, input: z.input<typeof scheduleInput>) {
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
      jar,
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

    return this.session(async (jar) => {
      const profile = await this.profileWithSession(jar);

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

        const page = await this.scheduleWithSession(jar, childFilters);

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

    return this.session(async (jar) => {
      const data = await this.query(
        jar,
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
}
