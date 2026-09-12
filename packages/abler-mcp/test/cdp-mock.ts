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

export function createCdpMock() {
  const requests: z.infer<typeof requestSchema>[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, mock) {
      const path = new URL(request.url).pathname;

      if (path === '/json/version')
        return Response.json({
          Browser: 'Chrome/1.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${mock.port}/devtools/browser/fake-browser`,
        });

      if (path === '/json/list')
        return Response.json([
          {
            type: 'page',
            url: 'https://unrelated.example',
            webSocketDebuggerUrl: 'ws://unrelated.example',
          },
          {
            type: 'page',
            url: 'https://www.abler.io/coach',
            webSocketDebuggerUrl: `ws://127.0.0.1:${mock.port}/devtools/page/1`,
          },
        ]);

      if (mock.upgrade(request)) return undefined;

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const parsed = requestSchema.safeParse(JSON.parse(String(message)));

        if (!parsed.success) {
          socket.close();

          return;
        }

        const request = parsed.data;
        requests.push(request);

        if (request.method === 'Network.getCookies')
          socket.send(JSON.stringify({ id: request.id, result: { cookies: [refreshCookie] } }));
      },
    },
  });

  return { server, requests };
}
