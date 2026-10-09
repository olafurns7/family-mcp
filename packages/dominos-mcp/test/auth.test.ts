import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { login, phoneNumber, requestCode, sessionStorage, withSession } from '../src/auth.js';
import { filesContaining, scratchHome } from './scratch.js';

test('SMS login uses the observed endpoints and stores verified credentials encrypted', async () => {
  const home = await scratchHome('dominos-auth-test-');
  const { path } = home;
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
    expect(await login('5550123', '123456', path, request)).toBe(false);
    expect(calls).toEqual(['/api/login/sendPin', '/api/token', '/api/user/newuser']);
    await assert.rejects(stat(path));

    for (const file of [home.record, `${home.record}.marker`, home.key])
      expect((await stat(file)).mode & 0o777).toBe(0o600);

    const saved = await withSession(path, new AbortController().signal, async (session) => session);
    expect(saved.refreshToken).toBe('synthetic-refresh');
    expect(await sessionStorage(path)).toBe('Saved in an encrypted file.');
    expect(
      await filesContaining(home.directory, ['synthetic-access', 'synthetic-refresh']),
    ).toEqual([]);
    expect(() => phoneNumber('https://example.invalid')).toThrow();
    await assert.rejects(login('5550123', '12345', path, request), /six digits/);
  } finally {
    await home.cleanup();
  }
});

test('upstream error bodies and transport errors never expose credentials', async () => {
  const home = await scratchHome('dominos-auth-error-');

  try {
    await assert.rejects(
      login(
        '5550123',
        '123456',
        join(home.directory, 'session.json'),
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
  } finally {
    await home.cleanup();
  }
});
