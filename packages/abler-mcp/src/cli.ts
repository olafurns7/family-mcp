#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { SafeError, startStdio } from '@family-mcp/mcp-runtime';
import { readPrivateFile, SessionStoreError } from '@family-mcp/session-store';
import type { CookieJar } from 'tough-cookie';

import { AblerClient } from './api.js';
import {
  captureCookies,
  checkStoreAtStartup,
  cookieInputSchema,
  importCookies,
  logoutSession,
  migrateSession,
  retryCandidate,
  saveVerifiedSession,
  sessionStorage,
} from './auth.js';
import { loginInBrowser } from './browser-login.js';
import { createServer, VERSION } from './server.js';

// Browser exports can include unrelated cookies; bound both credential input paths.
const COOKIE_EXPORT_MAX_BYTES = 4 * 1024 * 1024;

const help = `abler-mcp — unofficial read-only Abler MCP server

  abler-mcp [serve]                 Start the stdio MCP server
  abler-mcp auth login              Open a temporary browser for Abler sign-in
  abler-mcp auth capture [URL]      Capture a signed-in Chrome tab (default http://127.0.0.1:9222)
  abler-mcp auth import FILE        Import browser cookie JSON; use - for stdin
  abler-mcp auth retry-candidate    Verify and use a session whose verification failed earlier
  abler-mcp auth migrate            Move a session saved by an older version out of its plaintext file
  abler-mcp auth status             Show where the session is saved and verify it against Abler
  abler-mcp auth logout             Remove the saved session and failed-import candidates
  abler-mcp --version               Print the installed version

Login options: --timeout <seconds> (default 300), --browser <path>, --keep-browser
The temporary profile is deleted after login; --keep-browser leaves live credentials in it without a debugging endpoint.
The session is saved encrypted. ABLER_SESSION_FILE names an older version's plaintext session file.
On a headless machine, run auth import there with a browser cookie export.
`;

/** Rotations during verification land in the candidate, which is promoted only if it works. */
const verifyCandidate = () =>
  new AblerClient(undefined, fetch, undefined, 'candidate').status(true);

async function saveVerified(jar: CookieJar): Promise<void> {
  if (await saveVerifiedSession(jar, verifyCandidate))
    console.log('The old Abler session store could not be read without its key and was replaced.');
  console.log('Abler session saved and verified in the encrypted store.');
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 300;

  const seconds = Number(value);

  if (!Number.isSafeInteger(seconds) || seconds < 1)
    throw new SafeError('Provide a positive whole number for --timeout.');

  return seconds;
}

async function main() {
  let parsed;

  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        browser: { type: 'string' },
        timeout: { type: 'string' },
        'keep-browser': { type: 'boolean' },
      },
    });
  } catch {
    throw new SafeError('Invalid command-line options. Run abler-mcp --help for usage.');
  }

  const { positionals, values } = parsed;

  if (values.help) {
    console.log(help);

    return;
  }

  if (values.version) {
    console.log(VERSION);

    return;
  }

  // The store is checked before anything serves or touches it; help and version never do.
  if (!(await checkStoreAtStartup())) {
    process.exitCode = 1;

    return;
  }

  const [command = 'serve', action, argument] = positionals;

  if (command === 'serve' && positionals.length <= 1) {
    const client = new AblerClient();
    startStdio(() => createServer(client), { onClose: () => client.close() });

    return;
  }

  if (command !== 'auth' || positionals.length > 3)
    throw new SafeError('Invalid command. Run abler-mcp --help for usage.');

  if (
    action !== 'login' &&
    (values.browser !== undefined || values.timeout !== undefined || values['keep-browser'])
  )
    throw new SafeError(
      'The browser, timeout, and keep-browser options are only valid with auth login.',
    );

  let jar: CookieJar;

  if (action === 'login') {
    if (argument) throw new SafeError('Invalid command. Run abler-mcp --help for usage.');
    jar = await loginInBrowser({
      browser: values.browser,
      timeoutSeconds: parseTimeout(values.timeout),
      keepBrowser: values['keep-browser'],
    });
  } else if (action === 'capture') jar = await captureCookies(argument || 'http://127.0.0.1:9222');
  else if (action === 'import') {
    if (!argument) throw new SafeError('Provide a cookie JSON file, or - for stdin.');
    let raw = '';

    if (argument === '-') {
      const chunks: Buffer[] = [];
      let bytes = 0;

      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += buffer.length;

        if (bytes > COOKIE_EXPORT_MAX_BYTES)
          throw new SafeError('Cookie JSON input exceeds the 4 MiB limit.');
        chunks.push(buffer);
      }

      raw = Buffer.concat(chunks, bytes).toString('utf8');
    } else {
      try {
        raw = await readPrivateFile(argument, { maxBytes: COOKIE_EXPORT_MAX_BYTES });
      } catch (error) {
        if (error instanceof SessionStoreError && error.code === 'TOO_LARGE')
          throw new SafeError('Cookie JSON input exceeds the 4 MiB limit.');
        throw new SafeError(
          'Cannot read the cookie JSON file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.',
        );
      }
    }

    try {
      jar = await importCookies(cookieInputSchema.parse(JSON.parse(raw)));
    } catch {
      throw new SafeError(
        'Import failed: provide valid browser cookie JSON containing an unexpired Abler refreshToken.',
      );
    }
  } else if (action === 'status' && !argument) {
    const storage = await sessionStorage();
    console.log(JSON.stringify({ ...(await new AblerClient().status()), storage }));

    return;
  } else if (action === 'retry-candidate' && !argument) {
    await retryCandidate(verifyCandidate);
    console.log('Abler session verified and saved in the encrypted store.');

    return;
  } else if (action === 'migrate' && !argument) {
    const outcome = await migrateSession();

    console.log(
      {
        migrated: 'Abler session moved to the encrypted store; the plaintext files were removed.',
        candidate:
          'A failed-import candidate moved to the encrypted store; the plaintext files were removed. Run abler-mcp auth retry-candidate to verify and use it.',
        already: 'Already migrated.',
        'already-removed-legacy': 'Already migrated. Removed leftover plaintext session files.',
      }[outcome],
    );

    return;
  } else if (action === 'logout' && !argument) {
    await logoutSession();
    console.log(
      'Local Abler session and failed-import candidates removed. This does not sign out other devices.',
    );

    return;
  } else throw new SafeError('Invalid command. Run abler-mcp --help for usage.');

  await saveVerified(jar);
}

main().catch((error) => {
  // Only reviewed diagnostics cross the terminal boundary; library messages may contain secrets.
  console.error(error instanceof SafeError ? error.message : 'Abler MCP failed.');
  process.exitCode = 1;
});
