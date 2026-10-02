#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { SafeError, startStdio } from '@family-mcp/mcp-runtime';
import { InnaClient } from './client.js';
import { createServer } from './server.js';
import { loginWithElectronicId } from './login.js';
import manifest from '../package.json' with { type: 'json' };

const help = `inna-mcp — unofficial Inna school MCP (preview)

  inna-mcp [serve]                    Start the read-only stdio MCP server
  inna-mcp serve --allow-absence-writes Also expose confirmed whole-day illness/leave requests
  inna-mcp auth login                 Electronic ID: hidden phone prompt; approve on your phone
  inna-mcp auth import FILE           Verify and save a private nam.inna.is cookie export
  inna-mcp auth status                Verify the saved session (no credentials printed)
  inna-mcp auth logout                Remove the local session; retain absence evidence
  inna-mcp --version                  Print the executable version

Google sign-in uses www.inna.is in your browser; the account must be linked in Inna.
Export only nam.inna.is cookies to an owner-only local JSON file. Never paste cookies in chat.
INNA_SESSION_FILE sets an absolute private session path.
Login/import refuse a changed account/student/school unless --allow-account-change is given.
`;

async function signIn(client: InnaClient, allowAccountChange: boolean): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();

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

  input.once('SIGINT', () => {
    cancel();
    input.close();
  });
  process.once('SIGINT', cancel);

  try {
    process.stderr.write('Icelandic phone number (input hidden): ');
    const phone = await input[Symbol.asyncIterator]().next();
    input.close();
    sink.end();
    process.stderr.write('\n');

    if (phone.done || controller.signal.aborted) throw new SafeError('Inna login cancelled.');

    const jar = await loginWithElectronicId(
      phone.value.trim(),
      (code) =>
        process.stderr.write(
          `Security code ${code}: verify the match and approve on your phone. Enter your PIN only on your phone.\n`,
        ),
      { signal: controller.signal },
    );

    await client.saveVerifiedSession(jar, allowAccountChange, controller.signal);
    process.stdout.write(`Signed in. Session saved to ${client.path}\n`);
  } catch (error) {
    if (controller.signal.aborted) throw new SafeError('Inna login cancelled.');
    throw error;
  } finally {
    input.close();
    sink.end();
    process.removeListener('SIGINT', cancel);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'allow-absence-writes': { type: 'boolean' },
      'allow-account-change': { type: 'boolean' },
    },
  });

  if (values.help) return void process.stdout.write(help);

  if (values.version) return void process.stdout.write(`${manifest.version}\n`);
  const [command = 'serve', action, source] = positionals;

  if (command === 'serve' && positionals.length <= 1 && !values['allow-account-change']) {
    startStdio(() => createServer({ allowAbsenceWrites: values['allow-absence-writes'] ?? false }));

    return;
  }

  if (command !== 'auth' || values['allow-absence-writes'])
    throw new SafeError('Invalid command. Run inna-mcp --help.');
  const client = new InnaClient();

  if (action === 'login' && positionals.length === 2) {
    await signIn(client, values['allow-account-change'] ?? false);

    return;
  }

  if (action === 'import' && source && positionals.length === 3) {
    await client.importSession(source, values['allow-account-change'] ?? false);
    process.stdout.write(`Signed in. Session saved to ${client.path}\n`);

    return;
  }

  if (positionals.length !== 2 || values['allow-account-change'])
    throw new SafeError('Invalid command. Run inna-mcp --help.');

  if (action === 'status') {
    const result = await client.status();
    process.stdout.write(
      result.authenticated ? 'Inna session is authenticated.\n' : 'No saved Inna session.\n',
    );

    return;
  }

  if (action === 'logout') {
    await client.logout();
    process.stdout.write('Local Inna session removed. Absence operation evidence retained.\n');

    return;
  }

  throw new SafeError('Invalid command. Run inna-mcp --help.');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof SafeError ? error.message : 'Inna MCP failed. Check input format, file permissions, and local configuration.'}\n`,
  );
  process.exitCode = 1;
});
