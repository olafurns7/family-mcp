import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { parseForms, InfoMentorHttp, parseParent } from '../src/http.js';
import { promptCredentials } from '../src/credentials.js';
import { PARENT_URL, InfoMentorError } from '../src/session.js';

test('HTTP responses over 8 MiB are rejected before buffering', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      controller.close();
    },
  });

  const fetcher = async (): Promise<Response> => new Response(body);
  const http = new InfoMentorHttp(undefined, 0, fetcher);

  await assert.rejects(http.request(PARENT_URL), /unexpectedly large/);
});

test('Retry-After HTTP-date produces a bounded cooldown', async () => {
  const retryAt = new Date(Date.now() + 5000).toUTCString();

  const fetcher = async (): Promise<Response> =>
    new Response(null, { status: 429, headers: { 'Retry-After': retryAt } });

  const http = new InfoMentorHttp(undefined, 0, fetcher);

  await assert.rejects(http.isAuthenticated(), (error: Error) => {
    return (
      error instanceof InfoMentorError &&
      error.code === 'RATE_LIMITED' &&
      (error.retryAfterMs ?? 0) > 3000 &&
      (error.retryAfterMs ?? 0) <= 5000
    );
  });
});

test('malformed parent bootstrap is rejected without evaluation', () => {
  assert.throws(
    () => parseParent('<script>IMHome.home.homeData = {bad}; IMHome.home.init(1);</script>'),
    /changed or is unavailable/,
  );
});

test('local credential form rejects oversized and CSRF-mismatched posts', async () => {
  const controller = new AbortController();
  const ready = Promise.withResolvers<string>();

  const pending = promptCredentials(
    controller.signal,
    (url) => ready.resolve(url),
    () => {},
  );

  try {
    const url = await ready.promise;
    const page = await fetch(url);
    const form = parseForms(await page.text())[0];
    assert.ok(form);

    const oversized = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: new URL(url).origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'x'.repeat(16_385),
    });

    assert.equal(oversized.status, 413);

    form.fields.set('csrf', 'wrong');
    form.fields.set('username', 'user');
    form.fields.set('password', 'password');

    const mismatched = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: new URL(url).origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.fields,
    });

    assert.equal(mismatched.status, 403);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test('CLI rejects arguments for the wrong command', async () => {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'status', '--local-form'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  assert.equal(await child.exited, 1);
  assert.match(await new Response(child.stderr).text(), /Login options only apply to login/);
});
