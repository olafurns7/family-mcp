#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { SafeError, startStdio } from '@family-mcp/mcp-runtime';

import manifest from '../package.json' with { type: 'json' };
import {
  checkStoreAtStartup,
  login,
  logout,
  migrate,
  requestCode,
  sessionStorage,
} from './auth.js';

const help = `dominos-mcp — unofficial Domino’s Iceland MCP

  dominos-mcp [serve]       Start the stdio MCP server
  dominos-mcp auth login    Sign in with a phone number and SMS code (hidden input)
  dominos-mcp auth migrate  Move a session saved by an older version out of its plaintext file
  dominos-mcp auth status   Show where the session is saved and verify it
  dominos-mcp auth logout   Remove the local login
  dominos-mcp --version     Print the installed version

The session is saved encrypted. DOMINOS_SESSION_FILE names an older version's plaintext
session file; quotes and checkouts stay beside it.
Payments require an explicit pay_saved_card confirmation for the quoted amount.
`;

async function signIn(): Promise<void> {
  // readline handles editing and Ctrl-C, while the sink keeps both inputs out of scrollback.
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  const input = createInterface({
    input: process.stdin,
    output: sink,
    terminal: process.stdin.isTTY,
  });

  const lines = input[Symbol.asyncIterator]();

  try {
    process.stderr.write('Icelandic phone number (input hidden): ');
    const phone = await lines.next();

    if (phone.done) throw new SafeError('Sign-in cancelled.');
    await requestCode(phone.value);
    process.stderr.write('\nSMS sent. Six-digit code (input hidden): ');
    const pin = await lines.next();

    if (pin.done) throw new SafeError('Sign-in cancelled.');
    const replaced = await login(phone.value, pin.value.trim());
    process.stderr.write('\n');

    if (replaced)
      process.stdout.write(
        'The old Domino’s session store could not be read without its key and was replaced.\n',
      );
    process.stdout.write('Signed in. Session saved encrypted.\n');
  } finally {
    input.close();
    sink.end();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) return void process.stdout.write(help);

  if (values.version) return void process.stdout.write(`${manifest.version}\n`);

  // The store is checked before anything serves or touches it; help and version never do.
  if (!(await checkStoreAtStartup())) {
    process.exitCode = 1;

    return;
  }

  const [command = 'serve', action] = positionals;

  if (command === 'auth' && positionals.length === 2) {
    if (action === 'login') return signIn();

    if (action === 'logout') {
      await logout();
      process.stdout.write('Local Domino’s login removed.\n');

      return;
    }

    if (action === 'migrate') {
      const outcome = await migrate();

      process.stdout.write(
        outcome === 'migrated'
          ? 'Domino’s session moved to the encrypted store; the plaintext file was removed.\n'
          : outcome === 'already'
            ? 'Already migrated.\n'
            : 'Already migrated. Removed a leftover plaintext session file.\n',
      );

      return;
    }

    if (action === 'status') {
      process.stdout.write(`${await sessionStorage()}\n`);
      const { DominosClient } = await import('./client.js');
      const client = new DominosClient();

      try {
        process.stdout.write(`${JSON.stringify(await client.status())}\n`);
      } finally {
        await client.close();
      }

      return;
    }
  }

  if (command === 'serve' && positionals.length <= 1) {
    const { DominosClient } = await import('./client.js');
    const { createServer } = await import('./server.js');
    const client = new DominosClient();
    startStdio(() => createServer(client), { onClose: () => client.close() });

    return;
  }

  process.stderr.write(help);
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof SafeError ? error.message : 'Domino’s MCP failed. Check the local configuration.'}\n`,
  );
  process.exitCode = 1;
});
