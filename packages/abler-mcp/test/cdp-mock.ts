import * as z from 'zod/v4';

const requestSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.object({ urls: z.array(z.string()) }),
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
    port?: number;
    emptyPolls?: number;
    includeIdToken?: boolean;
  } = {},
) {
  const requests: z.infer<typeof requestSchema>[] = [];
  let polls = 0;

  const mockServer = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;

      if (path === '/json/version') return Response.json({ Browser: 'Chrome/1.0' });

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
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/1`,
          },
        ]);

      if (server.upgrade(request)) return undefined;

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const request = requestSchema.parse(JSON.parse(String(message)));
        requests.push(request);
        polls++;

        const cookies =
          polls <= (options.emptyPolls ?? 0)
            ? []
            : [refreshCookie, ...(options.includeIdToken ? [accessCookie] : [])];

        socket.send(JSON.stringify({ id: request.id, result: { cookies } }));
      },
    },
  });

  return { server: mockServer, requests };
}
