import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import {
  defaultSessionPath,
  readPrivateFile,
  SessionStoreError,
  sweepTemp,
  withFileLock,
  writePrivateFile,
} from '@family-mcp/session-store';
import * as z from 'zod/v4';

import { API, HttpError, requestJson, requestText, type Request } from './http.js';

const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);

const tokenResponse = z.object({
  access_token: token,
  refresh_token: token,
  expires_in: z.number().int().positive(),
  token_type: z.string().regex(/^bearer$/i),
  username: z.string().min(1),
});

const session = z.object({
  version: z.literal(1),
  accessToken: token,
  refreshToken: token,
  username: z.string().min(1),
  expiresAt: z.number().finite(),
});

export type Session = z.infer<typeof session>;

export const sessionPath = () =>
  resolve(process.env.DOMINOS_SESSION_FILE || defaultSessionPath('dominos-mcp'));

export function phoneNumber(value: string): string {
  const digits = value.replace(/[\s+-]/g, '');
  const normalized = digits.length === 7 ? `354${digits}` : digits;

  if (!/^354\d{7}$/.test(normalized))
    throw new SafeError('Use a seven-digit Icelandic phone number, optionally prefixed with +354.');

  return normalized;
}

export async function loadSession(path: string): Promise<Session> {
  try {
    return session.parse(JSON.parse(await readPrivateFile(path, { maxBytes: 131072 })));
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND')
      throw new SafeError('No saved Domino’s session. Run dominos-mcp auth login first.');

    throw new SafeError(
      'Cannot read the Domino’s session. Use a private regular file owned by you, or sign in again.',
    );
  }
}

export async function saveSession(path: string, value: Session): Promise<void> {
  await writePrivateFile(path, JSON.stringify(session.parse(value)) + '\n');
}

/** Locks include refresh and persistence, so two MCP hosts never consume the same refresh token. */
export async function locked<T>(
  path: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await withFileLock(path, { signal }, async () => {
      await sweepTemp(path);

      return work();
    });
  } catch (error) {
    if (error instanceof SessionStoreError)
      throw new SafeError(
        'Cannot safely access the local Domino’s session. Check file permissions or retry when the other request finishes.',
      );

    throw error;
  }
}

export async function exchangeToken(
  request: Request,
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<Session> {
  try {
    const value = await requestJson(
      request,
      `${API}token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      signal,
      tokenResponse,
    );

    return {
      version: 1,
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      username: value.username,
      expiresAt: Date.now() + value.expires_in * 1000,
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 429)
      throw new SafeError(
        'Domino’s is rate limiting sign-in. Wait before requesting another code.',
      );

    if (error instanceof HttpError)
      throw new SafeError('Domino’s rejected the sign-in code or refresh token. Sign in again.');

    throw error;
  }
}

export async function requestCode(phone: string, request: Request = fetch): Promise<void> {
  await requestText(
    request,
    `${API}login/sendPin?phoneNumber=${phoneNumber(phone)}`,
    { method: 'POST' },
    new AbortController().signal,
  );
}

export async function login(
  phone: string,
  pin: string,
  path = sessionPath(),
  request: Request = fetch,
): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new SafeError('The SMS code must contain six digits.');
  const signal = new AbortController().signal;

  await locked(path, signal, async () => {
    const value = await exchangeToken(
      request,
      new URLSearchParams({
        grant_type: 'password',
        username: phoneNumber(phone),
        password: pin,
        authentication_type: 'sms',
      }),
      signal,
    );

    await requestJson(
      request,
      `${API}user/newuser`,
      {
        headers: { Authorization: `bearer ${value.accessToken}` },
      },
      signal,
      z.object({ id: z.union([z.string(), z.number()]) }),
    );
    await saveSession(path, value);
  });
}

export async function logout(path = sessionPath()): Promise<void> {
  await locked(path, new AbortController().signal, () => rm(path, { force: true }));
}
