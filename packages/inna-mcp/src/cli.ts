#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { SafeError, startStdio } from '@family-mcp/mcp-runtime';
import { loginInBrowser } from './browser-login.js';
import { InnaClient, checkStoreAtStartup, type SavedSession } from './client.js';
import { createServer } from './server.js';
import { startKeepAlive } from './keep-alive.js';
import { loginWithElectronicId } from './login.js';
import manifest from '../package.json' with { type: 'json' };

const help = `inna-mcp — unofficial Inna school MCP (preview)

  inna-mcp [serve]                    Start the read-only stdio MCP server
  inna-mcp serve --allow-absence-writes Also expose confirmed whole-day illness/leave requests
  inna-mcp serve --no-keep-alive      Do not touch the saved session every 10 minutes while serving
  inna-mcp auth login                 Electronic ID: hidden phone prompt; approve on your phone
  inna-mcp auth login --google        Google: sign in in the browser window that opens
  inna-mcp auth import FILE           Fallback without a desktop: save a private cookie export
  inna-mcp auth status                Verify the saved session and say where it is saved
  inna-mcp auth migrate               Move an older version's plaintext session into the encrypted store
  inna-mcp auth logout                Remove the local session; retain absence evidence
  inna-mcp --version                  Print the executable version

auth login --google opens Google Chrome or Chromium on Inna's Google sign-in, saves the
session when you finish, and closes the window. The Google account must be linked in Inna.
It needs a desktop; nothing is copied or pasted. Options: --timeout <seconds> (default 300),
--browser <path> or INNA_BROWSER to choose the browser.
auth import is for a machine without a desktop: export only nam.inna.is cookies to an
owner-only local JSON file. Never paste cookies or passwords in chat.
The session is saved encrypted. INNA_SESSION_FILE names an older version's absolute plaintext
session path; the private absence record stays in a plaintext file beside that path.
Login/import refuse a changed account/student/school unless --allow-account-change is given.
`;

function reportSaved(saved: SavedSession): void {
  if (saved.replaced)
    process.stdout.write(
      'The old Inna session store could not be read without its key and was replaced.\n',
    );
  process.stdout.write(`Signed in. ${saved.storage}\n`);
}

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

    // A fresh login keeps the saved default student unless the owner asked to replace it.
    const preferredUserId = allowAccountChange ? undefined : await client.defaultUserId();

    const jar = await loginWithElectronicId(
      phone.value.trim(),
      (code) =>
        process.stderr.write(
          `Security code ${code}: verify the match and approve on your phone. Enter your PIN only on your phone.\n`,
        ),
      { signal: controller.signal, preferredUserId },
    );

    reportSaved(await client.saveVerifiedSession(jar, allowAccountChange, controller.signal));
  } catch (error) {
    if (controller.signal.aborted) throw new SafeError('Inna login cancelled.');
    throw error;
  } finally {
    input.close();
    sink.end();
    process.removeListener('SIGINT', cancel);
  }
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 300;

  const seconds = Number(value);

  if (!Number.isSafeInteger(seconds) || seconds < 1)
    throw new SafeError('Provide a positive whole number for --timeout.');

  return seconds;
}

async function signInWithGoogle(
  client: InnaClient,
  allowAccountChange: boolean,
  browser: { browser: string | undefined; timeoutSeconds: number },
): Promise<void> {
  // The browser is closed and its profile removed before the session is verified and saved.
  const jar = await loginInBrowser(browser);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    reportSaved(await client.saveVerifiedSession(jar, allowAccountChange, controller.signal));
  } catch (error) {
    if (controller.signal.aborted) throw new SafeError('Inna login cancelled.');
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
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
      'no-keep-alive': { type: 'boolean' },
      google: { type: 'boolean' },
      timeout: { type: 'string' },
      browser: { type: 'string' },
    },
  });

  if (values.help) return void process.stdout.write(help);

  if (values.version) return void process.stdout.write(`${manifest.version}\n`);

  // The store is checked before anything serves or touches it; help and version never do.
  if (!(await checkStoreAtStartup())) {
    process.exitCode = 1;

    return;
  }

  const [command = 'serve', action, source] = positionals;

  const browserOptions = values.timeout !== undefined || values.browser !== undefined;

  if (
    (values.google || browserOptions) &&
    !(values.google && command === 'auth' && action === 'login' && positionals.length === 2)
  )
    throw new SafeError('Invalid command. Run inna-mcp --help.');

  if (command === 'serve' && positionals.length <= 1 && !values['allow-account-change']) {
    const keepAlive = values['no-keep-alive']
      ? undefined
      : startKeepAlive(new InnaClient(), { output: process.stdout });

    startStdio(
      () => {
        const server = createServer({
          allowAbsenceWrites: values['allow-absence-writes'] ?? false,
        });

        return keepAlive ? keepAlive.attach(server) : server;
      },
      { onClose: () => keepAlive?.stop() },
    );

    return;
  }

  if (command !== 'auth' || values['allow-absence-writes'] || values['no-keep-alive'])
    throw new SafeError('Invalid command. Run inna-mcp --help.');
  const client = new InnaClient();

  if (action === 'login' && positionals.length === 2) {
    await client.checkStore();

    if (values.google)
      await signInWithGoogle(client, values['allow-account-change'] ?? false, {
        browser: values.browser,
        timeoutSeconds: parseTimeout(values.timeout),
      });
    else await signIn(client, values['allow-account-change'] ?? false);

    return;
  }

  if (action === 'import' && source && positionals.length === 3) {
    reportSaved(await client.importSession(source, values['allow-account-change'] ?? false));

    return;
  }

  if (positionals.length !== 2 || values['allow-account-change'])
    throw new SafeError('Invalid command. Run inna-mcp --help.');

  if (action === 'status') {
    const result = await client.status();
    process.stdout.write(
      'storage' in result
        ? `Inna session is authenticated. ${result.storage}\n`
        : 'No saved Inna session.\n',
    );

    return;
  }

  if (action === 'migrate') {
    const outcome = await client.migrate();

    process.stdout.write(
      {
        migrated: 'Inna session moved to the encrypted store; the plaintext file was removed.\n',
        already: 'Already migrated.\n',
        'already-removed-legacy':
          'Already migrated. Removed the leftover plaintext session file.\n',
      }[outcome],
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
