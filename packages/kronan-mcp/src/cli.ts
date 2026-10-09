#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { startStdio } from '@family-mcp/mcp-runtime';

import { KronanClient } from './api.js';
import { attemptsPath, clearAttempts, listAttempts } from './attempts.js';
import {
  TOKEN_MAX_BYTES,
  loadSavedToken,
  logoutToken,
  migrateToken,
  normalizeToken,
  readTokenSource,
  saveToken,
} from './auth.js';
import { createServer, VERSION } from './server.js';

const help = `kronan-mcp — unofficial Krónan MCP server (products, shopping note, basket, and confirmed orders)

  kronan-mcp [serve]                Start the stdio MCP server
  kronan-mcp auth set [FILE]        Save an access token read from FILE, or from stdin (hidden prompt on a terminal)
  kronan-mcp auth migrate           Move a token saved by an older version out of its plaintext file
  kronan-mcp auth status            Show where the token is saved and verify it against Krónan
  kronan-mcp auth logout            Forget the saved token on this computer
  kronan-mcp orders clear-attempts  Show recorded order attempts; clear them after a y/N confirmation
  kronan-mcp --version              Print the installed version

Create the access token in Krónan's settings (User or Customer group page; Auðkenni login required).
Never pass the token as a command-line argument. The token is saved encrypted; its key is in the macOS
Keychain, or in a private key file on Linux.
Order calls are recorded beside KRONAN_TOKEN_FILE (the plaintext token file of older versions); an
unresolved record blocks further order calls for that checkout.
Clear records only after checking your Krónan orders, never to get around an unknown outcome.
`;

/** Ctrl-C and Delete, written as code points so the source holds no raw control bytes. */
const END_OF_TEXT = String.fromCharCode(3);

const END_OF_TRANSMISSION = String.fromCharCode(4);

const DELETE = String.fromCharCode(127);

const BACKSPACE = '\b';

/** Read one line from a terminal without echoing it, so the token stays out of scrollback. */
function readHiddenLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let line = '';

    const finish = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onEnd);

      try {
        stdin.setRawMode(false);
      } catch {
        // The terminal is already gone; the outcome below still settles the prompt.
      }

      stdin.pause();
      process.stderr.write('\n');

      if (error) reject(error);
      else resolve(line);
    };

    const onEnd = () => finish(new Error('Cancelled: the terminal input closed.'));

    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;

      for (const character of text) {
        if (character === END_OF_TEXT || character === END_OF_TRANSMISSION)
          return finish(new Error('Cancelled.'));

        if (character === '\r' || character === '\n') return finish();

        if (character === DELETE || character === BACKSPACE) line = line.slice(0, -1);
        else line += character;
      }

      return undefined;
    };

    process.stderr.write('Paste the Krónan access token (input hidden) and press Enter: ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
  });
}

/** `-` and no argument both mean standard input; a terminal gets the hidden prompt either way. */
async function readTokenInput(source: string | undefined): Promise<string> {
  if (source !== undefined && source !== '-') return readTokenSource(source);

  if (process.stdin.isTTY) return readHiddenLine();
  let raw = '';

  for await (const chunk of process.stdin) {
    raw += chunk;

    if (raw.length > TOKEN_MAX_BYTES)
      throw new Error('Standard input is too large to hold one access token.');
  }

  return raw;
}

/** One answer line from the terminal or standard input; end of input counts as no. */
async function readAnswer(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const input = createInterface({ input: process.stdin, terminal: false });

  try {
    for await (const line of input) return line.trim();

    return '';
  } finally {
    input.close();
  }
}

/** A human-only escape hatch: no MCP tool can clear the order-attempt record. */
async function clearOrderAttempts(): Promise<void> {
  const path = attemptsPath();
  const shown = await listAttempts(path);

  if (shown !== 'invalid' && shown.length === 0) {
    console.log(`No recorded order attempts in ${path}.`);

    return;
  }

  if (shown === 'invalid') console.log(`The order-attempt record ${path} is unreadable or unsafe.`);
  else {
    console.log(`Recorded order attempts in ${path}:`);

    for (const attempt of shown)
      console.log(
        `  ${attempt.createdAt}  ${attempt.tool}  ${attempt.state}  checkout ${attempt.checkoutToken}  total ${attempt.total} ISK  order ${attempt.orderToken ?? '-'}`,
      );
  }

  console.log(
    'Clear these only after you checked your Krónan orders. A submitting or unknown attempt may have placed an order.',
  );

  if ((await readAnswer('Clear the recorded order attempts? [y/N] ')).toLowerCase() !== 'y') {
    console.log('Kept the recorded order attempts.');

    return;
  }

  if (!(await clearAttempts(path, shown)))
    throw new Error('The order-attempt record changed while you answered. Run the command again.');
  console.log('Cleared the recorded order attempts.');
}

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
    const client = new KronanClient();
    startStdio(() => createServer(client), { onClose: () => client.close() });

    return;
  }

  if (command === 'orders' && action === 'clear-attempts' && positionals.length === 2) {
    await clearOrderAttempts();

    return;
  }

  if (command !== 'auth' || positionals.length > 3) throw new Error(help);

  if (action === 'set') {
    const token = normalizeToken(await readTokenInput(argument));
    const client = new KronanClient(() => Promise.resolve(token));

    try {
      // Verify before saving, so a saved token is always one that Krónan accepted.
      await client.status();
    } finally {
      await client.close();
    }

    if (await saveToken(token))
      console.log('The old Krónan token store could not be read without its key and was replaced.');
    console.log('Krónan access token verified and saved encrypted.');

    if (argument !== undefined && argument !== '-')
      console.log('Remove the source file now; it holds the same credential.');
  } else if (action === 'migrate' && argument === undefined) {
    const outcome = await migrateToken();

    console.log(
      outcome === 'migrated'
        ? 'Krónan access token moved to the encrypted store; the plaintext file was removed.'
        : outcome === 'already'
          ? 'Already migrated.'
          : 'Already migrated. Removed a leftover plaintext token file.',
    );
  } else if (action === 'status' && argument === undefined) {
    const saved = await loadSavedToken();
    console.log(saved.storage);
    const client = new KronanClient(() => Promise.resolve(saved.token));

    try {
      console.log(JSON.stringify(await client.status()));
    } finally {
      await client.close();
    }
  } else if (action === 'logout' && argument === undefined) {
    await logoutToken();
    console.log(
      'Saved Krónan access token removed from this computer. The token itself stays valid until revoked in Krónan settings.',
    );
  } else throw new Error(help);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Krónan MCP failed.');
  process.exitCode = 1;
});
