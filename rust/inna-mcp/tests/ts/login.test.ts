// packages/inna-mcp/test/login.test.ts against the Rust binary, run by tests/typescript.rs from
// packages/inna-mcp. Changed only in its import: the ./rust-login.ts drop-in signs in with the
// binary's `auth login` instead of calling the TypeScript sign-in.
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
// Rust: the binary's sign-in.
import { loginWithElectronicId } from './rust-login.js';

import { provider, token } from './fake-eid.ts';

test('phone login replaces the polling session, completes logout relay, upgrades HTTP, and retains only school cookies', async () => {
  const p = provider();
  const codes: string[] = [];
  const waits: number[] = [];

  const jar = await loginWithElectronicId(
    '5550000',
    (code) => {
      expect(p.calls.some((call) => call.url.pathname === '/login/phone/authenticate')).toBe(false);
      codes.push(code);
    },
    {
      fetch: p.fetcher,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );

  expect(codes).toEqual(['1234']);
  expect(p.selections).toEqual([{ i: '0', system: '1', user_id: '2', status: '3' }]);
  expect(waits).toEqual([2000, 3000]);
  const saved = JSON.stringify(await jar.serialize());
  expect(saved).not.toContain(token);
  expect(saved).not.toContain('synthetic-identity-cookie');
  expect(saved).not.toContain('DO-NOT-SAVE');
  const cookies = await jar.getCookies('https://nam.inna.is/');
  expect(cookies.map((cookie) => cookie.key).toSorted()).toEqual(['SESSION', 'XSRF-TOKEN']);
  expect(cookies.every((cookie) => cookie.secure)).toBe(true);
});

test('phone login refuses external redirects, unaccepted terms, and an access list without a student context', async () => {
  const p = provider();
  p.setTrap();
  await assert.rejects(
    loginWithElectronicId('5550000', () => {}, { fetch: p.fetcher }),
    /unexpected destination/,
  );
  expect(p.calls).toHaveLength(1);

  for (const reason of ['terms', 'schools']) {
    const q = provider();

    if (reason === 'terms') q.setTerms(false);
    else
      q.setAccess([
        { system: 2, user_id: 7, status: 1, is_access: true },
        { system: 1, user_id: 8, status: 1, is_access: false },
      ]);
    await assert.rejects(
      loginWithElectronicId('5550000', () => {}, { fetch: q.fetcher, wait: async () => {} }),
      reason === 'terms' ? /accept Inna terms yourself/ : /Select the intended school/,
    );
    expect(q.calls.some((call) => call.method === 'POST' && call.url.hostname === 'inna.is')).toBe(
      false,
    );
  }
});

test('phone login with several student contexts picks the first or the preferred one by its original index', async () => {
  const access = [
    { system: 2, user_id: 7, status: 1, is_access: true },
    { system: 1, user_id: 8, status: 1, is_access: false },
    { system: 1, user_id: 2, status: 3, is_access: true },
    { system: 1, user_id: 5, status: 4, is_access: true },
  ];

  const first = { i: '2', system: '1', user_id: '2', status: '3' };

  for (const [preferredUserId, selection] of [
    [undefined, first],
    [5, { i: '3', system: '1', user_id: '5', status: '4' }],
    [2, first],
    // Absent, without access, or another application: fall back to the first student context.
    [99, first],
    [8, first],
    [7, first],
  ] as const) {
    const p = provider();
    p.setAccess(access);

    const jar = await loginWithElectronicId('5550000', () => {}, {
      fetch: p.fetcher,
      wait: async () => {},
      preferredUserId,
    });

    expect({ preferredUserId, selections: p.selections }).toEqual({
      preferredUserId,
      selections: [selection],
    });
    expect((await jar.getCookies('https://nam.inna.is/')).map((cookie) => cookie.key)).toContain(
      'SESSION',
    );
  }
});
