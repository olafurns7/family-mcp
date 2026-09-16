import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';

import { KronanClient } from '../src/api.js';

const TOKEN = 'synthetic-token-0123456789';

test('real loopback fetch authenticates, refuses redirects, maps 429, and cancels oversized streams', async () => {
  let mode: 'normal' | 'rate' | 'large' | 302 | 303 | 307 = 'normal';
  let authorization: string | null = null;
  let redirectTargetHit = false;
  let chunks = 0;
  let cancelled = false;

  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === '/api/v1/redirect-target') {
        redirectTargetHit = true;

        return Response.json({ type: 'user', name: 'Unexpected redirect target' });
      }

      if (url.pathname !== '/api/v1/me/') return new Response('Not found', { status: 404 });
      authorization = request.headers.get('authorization');

      if (mode === 302 || mode === 303 || mode === 307)
        return new Response(null, {
          status: mode,
          headers: { Location: '/api/v1/redirect-target' },
        });

      if (mode === 'rate') return new Response(null, { status: 429 });

      if (mode === 'large')
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              chunks += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
        );

      return Response.json({ type: 'user', name: 'Synthetic account' });
    },
  });

  const request = async (url: string, options: RequestInit): Promise<Response> => {
    const source = new URL(url);

    const local = new URL(source.pathname + source.search, 'http://127.0.0.1:' + upstream.port);

    const response = await fetch(local, options);

    if (mode !== 'large' || response.body === null) return response;
    const reader = response.body.getReader();

    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const result = await reader.read();

          if (result.done) controller.close();
          else controller.enqueue(result.value);
        },
        async cancel() {
          cancelled = true;
          await reader.cancel();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  };

  const client = new KronanClient(async () => TOKEN, request);

  try {
    assert.deepEqual(await client.status(), {
      authenticated: true,
      account: { type: 'user', name: 'Synthetic account' },
    });
    assert.equal(authorization, 'AccessToken ' + TOKEN);

    mode = 302;
    await assert.rejects(client.status(), /Krónan request failed or timed out/);
    mode = 303;
    await assert.rejects(client.status(), /Krónan request failed or timed out/);
    mode = 307;
    await assert.rejects(client.status(), /Krónan request failed or timed out/);
    expect(redirectTargetHit).toBe(false);

    mode = 'rate';
    await assert.rejects(client.status(), /Krónan rate limit reached/);

    mode = 'large';
    await assert.rejects(client.status(), /exceeded the 4 MiB limit/);
    expect(chunks).toBeGreaterThanOrEqual(5);
    expect(chunks).toBeLessThan(32);
    expect(cancelled).toBe(true);
  } finally {
    await client.close();
    await upstream.stop(true);
  }
});
