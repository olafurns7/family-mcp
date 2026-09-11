#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { importSession, login } from './login.js';
import { InfoMentorClient } from './client.js';
import { createServer, packageInfo } from './server.js';
import { InfoMentorError, sessionPath } from './session.js';
import type { SessionOptions } from './session.js';

const help = [
  'Usage: infomentor-mcp [command] [options]',
  '',
  'Commands:',
  '  login              Sign in over HTTPS using privately injected secrets or a credentials file',
  '  status             Verify the saved session without opening a window',
  '  logout             Delete the local session (does not revoke it on InfoMentor)',
  '  serve              Start the stdio MCP server (default)',
  '',
  'Options:',
  '  --session FILE     Session file (default: ~/.infomentor-mcp/session.json)',
  '  --credentials FILE Private JSON file with username/password (login and automatic renewal)',
  '  --local-form       login: opt into a browser form on this same computer',
  '  --import FILE      login: validate and import a session on a headless machine',
  '  --timeout SECONDS  login: maximum wait (default: 300)',
  '  -h, --help         Show help',
  '  -v, --version      Show version',
  '',
  'Environment: INFOMENTOR_SESSION_PATH, INFOMENTOR_CREDENTIALS_FILE,',
  '             INFOMENTOR_USERNAME (kennitala or username), INFOMENTOR_PASSWORD',
].join('\n');

async function main(): Promise<void> {
  let parsed;

  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        session: { type: 'string' },
        credentials: { type: 'string' },
        'local-form': { type: 'boolean' },
        import: { type: 'string' },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch {
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Invalid arguments. Run infomentor-mcp --help.',
    );
  }

  const { values, positionals } = parsed;

  if (values.help) {
    console.log(help);

    return;
  }

  if (values.version) {
    console.log(packageInfo.version);

    return;
  }

  if (positionals.length > 1)
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Unexpected arguments. Run infomentor-mcp --help.',
    );
  const command = positionals[0] ?? 'serve';

  if (command !== 'login' && (values.import || values.timeout || values['local-form'])) {
    throw new InfoMentorError('INVALID_CONFIGURATION', 'Login options only apply to login.');
  }

  if (values.import && (values.credentials || values['local-form']))
    throw new InfoMentorError('INVALID_CONFIGURATION', 'Choose session import or login, not both.');

  const options: SessionOptions = {};

  if (values.session) options.sessionFile = resolve(values.session);

  if (values.credentials) options.credentialsFile = resolve(values.credentials);

  if (command === 'serve') {
    const server = createServer(options);

    const stop = (): void => {
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    };

    // Stdio EOF and process termination cancel network requests and local login setup.
    process.stdin.once('end', stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await server.connect(new StdioServerTransport());

    return;
  }

  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  try {
    switch (command) {
      case 'login': {
        if (values.import) {
          await importSession(values.import, options, controller.signal);
          console.error('Session imported and verified.');

          return;
        }

        const timeout = z.coerce
          .number()
          .int()
          .positive()
          .max(3600)
          .safeParse(values.timeout ?? '300');

        if (!timeout.success)
          throw new InfoMentorError(
            'INVALID_CONFIGURATION',
            'Timeout must be between 0 and 3600 seconds, excluding 0.',
          );

        const loginOptions = {
          ...options,
          signal: controller.signal,
          localForm: values['local-form'] ?? false,
          timeoutMs: timeout.data * 1000,
          onProgress(stage: 'waiting' | 'saved', url?: string): void {
            console.error(
              stage === 'saved'
                ? 'Signed in. Session saved to ' + sessionPath(options.sessionFile)
                : 'Open the private sign-in form: ' + url,
            );
          },
        };

        await login(
          values.credentials
            ? { ...loginOptions, credentialsFile: resolve(values.credentials) }
            : loginOptions,
        );

        return;
      }

      case 'status': {
        const client = new InfoMentorClient(options);

        try {
          const status = await client.getSessionStatus(controller.signal);
          console.error(status.authenticated ? 'InfoMentor session is active.' : status.nextStep);

          if (!status.authenticated) process.exitCode = 1;
        } finally {
          await client.close();
        }

        return;
      }

      case 'logout': {
        const client = new InfoMentorClient(options);

        try {
          await client.logout();
        } finally {
          await client.close();
        }

        console.error('Local InfoMentor session removed.');

        return;
      }

      default:
        throw new InfoMentorError(
          'INVALID_CONFIGURATION',
          'Unknown command. Run infomentor-mcp --help.',
        );
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

void main().catch((cause: unknown) => {
  console.error(
    cause instanceof InfoMentorError
      ? cause.message
      : 'InfoMentor operation failed. Check the network and session-file permissions.',
  );
  process.exitCode = cause instanceof InfoMentorError && cause.code === 'CANCELLED' ? 130 : 1;
});
