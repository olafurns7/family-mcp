#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { startStdio } from '@family-mcp/mcp-runtime';

import { KronanClient } from './api.js';
import {
  TOKEN_MAX_BYTES,
  loadToken,
  normalizeToken,
  readTokenSource,
  removeToken,
  saveToken,
  tokenPath,
} from './auth.js';
import { createServer, VERSION } from './server.js';

const help = `kronan-mcp — unofficial read-only Krónan MCP server

  kronan-mcp [serve]                Start the stdio MCP server
  kronan-mcp auth set [FILE]        Save an access token read from FILE, or from stdin (hidden prompt on a terminal)
  kronan-mcp auth status            Verify the saved token against Krónan
  kronan-mcp auth logout            Remove the saved token file
  kronan-mcp --version              Print the installed version

Create the access token in Krónan's settings (User or Customer group page; Auðkenni login required).
Never pass the token as a command-line argument. Set KRONAN_TOKEN_FILE to choose the private token file.
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

  if (command !== 'auth' || positionals.length > 3) throw new Error(help);
  const path = tokenPath();

  if (action === 'set') {
    const token = normalizeToken(await readTokenInput(argument));
    const client = new KronanClient(() => Promise.resolve(token));

    try {
      // Verify before saving, so a saved token is always one that Krónan accepted.
      await client.status();
    } finally {
      await client.close();
    }

    await saveToken(path, token);
    console.log(`Krónan access token verified and saved: ${path}`);

    if (argument !== undefined && argument !== '-')
      console.log('Remove the source file now; it holds the same credential.');
  } else if (action === 'status' && argument === undefined) {
    const client = new KronanClient(() => loadToken(path));

    try {
      console.log(JSON.stringify(await client.status()));
    } finally {
      await client.close();
    }
  } else if (action === 'logout' && argument === undefined) {
    await removeToken(path);
    console.log(
      'Local Krónan token file removed. The token itself stays valid until revoked in Krónan settings.',
    );
  } else throw new Error(help);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Krónan MCP failed.');
  process.exitCode = 1;
});
