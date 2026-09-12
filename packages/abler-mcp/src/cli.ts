#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { startStdio } from '@family-mcp/mcp-runtime';

import { AblerClient } from './api.js';
import {
  captureCookies,
  cookieInputSchema,
  importCookies,
  prunePendingCandidates,
  removeSession,
  saveSession,
  sessionPath,
  withSessionLock,
} from './auth.js';
import { createServer, VERSION } from './server.js';

const help = `abler-mcp — unofficial read-only Abler MCP server

  abler-mcp [serve]                 Start the stdio MCP server
  abler-mcp auth capture [URL]      Capture a signed-in Chrome tab (default http://127.0.0.1:9222)
  abler-mcp auth import FILE        Import browser cookie JSON; use - for stdin
  abler-mcp auth status             Verify the saved session against Abler
  abler-mcp auth logout             Remove this machine's saved session
  abler-mcp --version               Print the installed version

Set ABLER_SESSION_FILE to choose the private session file.
Sign in at https://www.abler.io/sign-on/login before capturing.
Transfer the saved session file securely to use it on a headless machine.
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    console.log(help);

    return;
  }

  if (values.version) {
    console.log(VERSION);

    return;
  }

  const [command = 'serve', action, argument] = positionals;

  if (command === 'serve' && positionals.length <= 1) {
    const client = new AblerClient();
    startStdio(() => createServer(client), { onClose: () => client.close() });

    return;
  }

  if (command !== 'auth' || positionals.length > 3) throw new Error(help);
  const path = sessionPath();

  if (action === 'capture' || action === 'import') {
    let jar;

    if (action === 'capture') jar = await captureCookies(argument || 'http://127.0.0.1:9222');
    else {
      if (!argument) throw new Error('Provide a cookie JSON file, or - for stdin.');
      let raw = '';

      if (argument === '-') {
        for await (const chunk of process.stdin) raw += chunk;
      } else raw = await readFile(argument, 'utf8');

      try {
        jar = await importCookies(cookieInputSchema.parse(JSON.parse(raw)));
      } catch {
        throw new Error(
          'Import failed: provide valid browser cookie JSON containing an unexpired Abler refreshToken.',
        );
      }
    }

    await withSessionLock(path, async () => {
      const pending = `${path}.${randomUUID()}.pending`;
      await saveSession(pending, jar);

      try {
        await new AblerClient(pending).status(true);
        await rename(pending, path);
      } catch {
        // A successful refresh may already have invalidated the imported credential.
        throw new Error(
          `Session verification failed. The previous file was kept; a possibly rotated candidate is retained at ${pending}. Retry with ABLER_SESSION_FILE pointing there and auth status, or capture a fresh session. Treat both files as credentials.`,
        );
      }

      // The verified session supersedes candidates retained by earlier failed imports.
      await prunePendingCandidates(path);
    });
    console.log(`Abler session saved and verified: ${path}`);
  } else if (action === 'status' && !argument) {
    console.log(JSON.stringify(await new AblerClient(path).status()));
  } else if (action === 'logout' && !argument) {
    await removeSession(path);
    console.log('Local Abler session removed. This does not sign out other devices.');
  } else throw new Error(help);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Abler MCP failed.');
  process.exitCode = 1;
});
