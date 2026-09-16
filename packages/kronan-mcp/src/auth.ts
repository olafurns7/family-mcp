import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import {
  SessionStoreError,
  defaultSessionPath,
  readPrivateFile,
  sweepTemp,
  writePrivateFile,
} from '@family-mcp/session-store';
import * as z from 'zod/v4';

export const ORIGIN = 'https://api.kronan.is';

/** One access token of at most 4 KiB fits comfortably; anything larger is not a token file. */
export const TOKEN_MAX_BYTES = 16_384;

/** Printable ASCII only, so the value can never smuggle header separators or line breaks. */
const tokenSchema = z
  .string()
  .min(8)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

const tokenFileSchema = z.object({ version: z.literal(1), token: tokenSchema });

export const tokenPath = () =>
  resolve(process.env.KRONAN_TOKEN_FILE || defaultSessionPath('kronan-mcp'));

/** Accept pasted or piped input with surrounding whitespace; reject anything that is not one token. */
export function normalizeToken(raw: string): string {
  const parsed = tokenSchema.safeParse(raw.trim());

  if (!parsed.success)
    throw new SafeError(
      'Invalid Krónan access token. Paste the token exactly as Krónan shows it, on one line.',
    );

  return parsed.data;
}

/** A pasted-token source file is a credential too; it must meet the same private-file rules. */
export async function readTokenSource(path: string): Promise<string> {
  try {
    return await readPrivateFile(path, { maxBytes: TOKEN_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
      throw new SafeError('The token source file does not exist.');
    }

    if (error instanceof SessionStoreError && error.code === 'TOO_LARGE')
      throw new SafeError('The token source file is too large to hold one access token.');

    throw new SafeError(
      'Cannot read the token source file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
    );
  }
}

export async function loadToken(path: string): Promise<string> {
  let raw: string;

  try {
    raw = await readPrivateFile(path, { maxBytes: TOKEN_MAX_BYTES });
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') {
      throw new SafeError('No saved Krónan access token. Run kronan-mcp auth set first.');
    }

    if (error instanceof SessionStoreError && error.code === 'TOO_LARGE')
      throw new SafeError(
        'The Krónan token file is too large to be a token file. Run kronan-mcp auth set again.',
      );

    throw new SafeError(
      'Cannot read the Krónan token file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
    );
  }

  try {
    return tokenFileSchema.parse(JSON.parse(raw)).token;
  } catch {
    throw new SafeError('Invalid Krónan token file. Run kronan-mcp auth set again.');
  }
}

export async function saveToken(path: string, token: string): Promise<void> {
  const file = tokenFileSchema.parse({ version: 1, token });

  try {
    // A temporary orphaned by an earlier hard crash would hold a verified token; remove old ones.
    await sweepTemp(path);
    await writePrivateFile(path, JSON.stringify(file) + '\n');
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;
    throw new SafeError('Cannot save the Krónan token file. Check the directory permissions.');
  }
}

export async function removeToken(path: string): Promise<void> {
  await rm(path, { force: true });
  await sweepTemp(path);
}
