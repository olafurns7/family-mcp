#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { importSession, login } from './login.js';
import { installBrowser } from './browser-install.js';
import { InfoMentorClient } from './client.js';
import { createServer, packageInfo } from './server.js';
import { browserChoiceSchema, InfoMentorError, sessionPath } from './session.js';
import type { SessionOptions } from './session.js';

const help = [
  'Usage: infomentor-mcp [command] [options]',
  '',
  'Commands:',
  '  login              Open a browser; save automatically after sign-in verifies',
  '  status             Verify the saved session without opening a window',
  '  logout             Delete the local session (does not revoke it on InfoMentor)',
  '  serve              Start the stdio MCP server (default)',
  '  install-browser    Install Chromium, Firefox, or WebKit (default: Chromium)',
  '',
  'Options:',
  '  --session FILE     Session file (default: ~/.infomentor-mcp/session.json)',
  '  --browser NAME     chrome, msedge, chromium, firefox, or webkit; auto-detected by default',
  '  --executable-path FILE  Path to Brave, Vivaldi, or another Chromium-based browser',
  '  --cdp-url URL      Connect to a remote browser via loopback/SSH or TLS',
  '  --import FILE      login: validate and import a session on a headless machine',
  '  --timeout SECONDS  login: maximum wait (default: 300)',
  '  --with-deps        install-browser: also install Linux system dependencies',
  '  -h, --help         Show help',
  '  -v, --version      Show version',
  '',
  'Environment: INFOMENTOR_SESSION_PATH, INFOMENTOR_BROWSER, INFOMENTOR_EXECUTABLE_PATH, INFOMENTOR_CDP_URL',
].join('\n');

async function main(): Promise<void> {
  let parsed;

  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        session: { type: 'string' },
        browser: { type: 'string' },
        'cdp-url': { type: 'string' },
        'executable-path': { type: 'string' },
        import: { type: 'string' },
        timeout: { type: 'string' },
        'with-deps': { type: 'boolean' },
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

  if (
    (command !== 'login' && (values.import || values.timeout)) ||
    (command !== 'install-browser' && values['with-deps'])
  ) {
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'An option does not apply to this command. Run infomentor-mcp --help.',
    );
  }

  const options: SessionOptions = {};

  if (values.session) options.sessionFile = resolve(values.session);

  if (values['cdp-url']) options.cdpUrl = values['cdp-url'];

  if (values['executable-path']) options.executablePath = resolve(values['executable-path']);

  if (values.browser) {
    const browser = browserChoiceSchema.safeParse(values.browser);

    if (!browser.success)
      throw new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Browser must be chrome, msedge, chromium, firefox, or webkit.',
      );
    options.browser = browser.data;
  }

  if (command === 'serve') {
    const server = createServer(options);

    const stop = (): void => {
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    };

    // Stdio EOF and process termination must also close remote browser contexts.
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
    if (command === 'install-browser') {
      const browser = options.browser ?? 'chromium';

      if (
        (browser !== 'chromium' && browser !== 'firefox' && browser !== 'webkit') ||
        options.cdpUrl ||
        options.executablePath
      ) {
        throw new InfoMentorError(
          'INVALID_CONFIGURATION',
          'Install chromium, firefox, or webkit. System Chrome, Edge, and custom executables are selected when running the package.',
        );
      }

      await installBrowser(
        { browser, withDeps: values['with-deps'] ?? false },
        controller.signal,
        (text) => process.stderr.write(text),
      );

      return;
    }

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
        let lastStage = '';
        await login({
          ...options,
          signal: controller.signal,
          timeoutMs: timeout.data * 1000,
          onProgress(stage) {
            if (lastStage === stage) return;
            lastStage = stage;

            const messages = {
              waiting:
                'Sign in directly in the browser. This command will save the session automatically. Ctrl+C cancels.',
              challenge: 'Complete the security check in the browser. This command will wait.',
              saved: 'Signed in. Session saved to ' + sessionPath(options.sessionFile),
            };

            console.error(messages[stage]);
          },
        });

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
      : 'InfoMentor operation failed. Check the browser, network, and session-file permissions.',
  );
  process.exitCode = cause instanceof InfoMentorError && cause.code === 'CANCELLED' ? 130 : 1;
});
