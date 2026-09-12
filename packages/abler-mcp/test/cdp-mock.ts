import * as z from 'zod/v4';

const requestSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z
    .object({
      urls: z.array(z.string()).optional(),
      targetId: z.string().optional(),
      flatten: z.literal(true).optional(),
    })
    .default({}),
  sessionId: z.string().optional(),
});

const refreshCookie = {
  name: 'refreshToken',
  value: 'private-refresh',
  domain: 'www.abler.io',
  path: '/',
  expires: Date.now() / 1000 + 3600,
};

const accessCookie = {
  ...refreshCookie,
  name: 'id_token',
  value: 'private-access',
};

export function createCdpMock(
  options: {
    hostname?: string;
    refreshToken?: string;
    idToken?: string;
    port?: number;
    emptyPolls?: number;
    includeIdToken?: boolean;
    invalidVersion?: boolean;
    ignoreBrowserClose?: boolean;
    browserPid?: number | null;
    substituteDiscoveryAfterProcessInfo?: boolean;
    onSubstituteRequest?: () => void;
    onProcessInfo?: () => void | Promise<void>;
    onBrowserClose?: () => void | Promise<void>;
    onRequest?: () => void;
  } = {},
) {
  const requests: z.infer<typeof requestSchema>[] = [];
  let polls = 0;
  const hostname = options.hostname ?? '127.0.0.1';
  const refreshCookieValue = options.refreshToken ?? 'private-refresh';
  const idTokenValue = options.idToken ?? 'private-access';
  let substituteDiscovery = false;

  const mockServer = Bun.serve<{ pathname: string }>({
    hostname,
    port: options.port ?? 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      options.onRequest?.();

      if (path === '/json/version')
        return Response.json({
          Browser: 'Chrome/1.0',
          webSocketDebuggerUrl: `ws://${hostname}:${server.port}/devtools/browser/fake-browser`,
        });

      if (path === '/json/list') {
        if (substituteDiscovery) options.onSubstituteRequest?.();

        return Response.json([
          {
            type: 'page',
            url: 'https://unrelated.example',
            webSocketDebuggerUrl: 'ws://unrelated.example',
          },
          {
            type: 'page',
            url: 'https://www.abler.io/coach',
            webSocketDebuggerUrl: `ws://${hostname}:${server.port}${
              substituteDiscovery ? '/devtools/page/substitute' : '/devtools/page/1'
            }`,
          },
        ]);
      }

      if (server.upgrade(request, { data: { pathname: path } })) return undefined;

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      async message(socket, message) {
        const parsed = requestSchema.safeParse(JSON.parse(String(message)));

        if (!parsed.success) {
          socket.close();

          return;
        }

        const request = parsed.data;
        requests.push(request);

        if (request.method === 'Browser.getVersion') {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: options.invalidVersion ? {} : { product: 'Chrome/1.0' },
            }),
          );

          return;
        }

        if (request.method === 'SystemInfo.getProcessInfo') {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                processes:
                  options.browserPid === null
                    ? []
                    : [{ type: 'browser', id: options.browserPid ?? process.pid, cpuTime: 0 }],
              },
            }),
          );
          substituteDiscovery = options.substituteDiscoveryAfterProcessInfo === true;
          await options.onProcessInfo?.();

          return;
        }

        if (request.method === 'Target.getTargets') {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                targetInfos: [
                  {
                    targetId: 'fake-page',
                    type: 'page',
                    url: 'https://www.abler.io/coach',
                  },
                ],
              },
            }),
          );

          return;
        }

        if (request.method === 'Target.attachToTarget') {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { sessionId: request.params.targetId ?? 'fake-page' },
            }),
          );

          return;
        }

        if (request.method === 'Browser.close') {
          if (!options.ignoreBrowserClose) await options.onBrowserClose?.();
          socket.send(JSON.stringify({ id: request.id, result: {} }));

          return;
        }

        if (request.method !== 'Network.getCookies') return;

        polls++;

        const substitutedPage =
          substituteDiscovery && socket.data.pathname === '/devtools/page/substitute';

        if (substitutedPage) options.onSubstituteRequest?.();

        const cookies =
          polls <= (options.emptyPolls ?? 0)
            ? []
            : [
                {
                  ...refreshCookie,
                  value: substitutedPage ? 'decoy-refresh' : refreshCookieValue,
                },
                ...(options.includeIdToken
                  ? [
                      {
                        ...accessCookie,
                        value: substitutedPage ? 'decoy-access' : idTokenValue,
                      },
                    ]
                  : []),
              ];

        socket.send(JSON.stringify({ id: request.id, result: { cookies } }));
      },
    },
  });

  return { server: mockServer, requests };
}
