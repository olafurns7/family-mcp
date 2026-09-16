import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSession, login, phoneNumber, requestCode } from '../src/auth.js';

test('SMS login uses the observed endpoints and stores verified credentials privately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dominos-auth-test-'));
  const path = join(directory, 'session.json');
  const calls: string[] = [];

  const request = async (url: string, options: RequestInit) => {
    calls.push(new URL(url).pathname);

    if (url.includes('/sendPin')) {
      expect(new URL(url).searchParams.get('phoneNumber')).toBe('3545550123');

      return new Response('');
    }

    if (url.endsWith('/token')) {
      expect(options.body).toBe(
        new URLSearchParams({
          grant_type: 'password',
          username: '3545550123',
          password: '123456',
          authentication_type: 'sms',
        }).toString(),
      );

      return Response.json({
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        username: '3545550123',
      });
    }

    expect(new Headers(options.headers).get('authorization')).toBe('bearer synthetic-access');

    return Response.json({ id: 1 });
  };

  try {
    await requestCode('+354 555-0123', request);
    await login('5550123', '123456', path, request);
    expect(calls).toEqual(['/api/login/sendPin', '/api/token', '/api/user/newuser']);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await loadSession(path)).refreshToken).toBe('synthetic-refresh');
    expect(() => phoneNumber('https://example.invalid')).toThrow();
    await assert.rejects(login('5550123', '12345', path, request), /six digits/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('upstream error bodies and transport errors never expose credentials', async () => {
  await assert.rejects(
    login(
      '5550123',
      '123456',
      join(tmpdir(), `dominos-error-${crypto.randomUUID()}.json`),
      async () => new Response('secret-synthetic-response', { status: 400 }),
    ),
    /rejected the sign-in/,
  );
  await assert.rejects(
    requestCode('5550123', async () => {
      throw new Error('secret-synthetic-token');
    }),
    /failed or timed out/,
  );
});
