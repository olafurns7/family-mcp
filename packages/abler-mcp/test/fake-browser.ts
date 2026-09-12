import { stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import * as z from 'zod/v4';

const args = process.argv.slice(2);

const profile = args
  .find((argument) => argument.startsWith('--user-data-dir='))
  ?.slice('--user-data-dir='.length);

const usePipe = args.includes('--remote-debugging-pipe');

const config = z
  .object({
    profile: z.string(),
    stateFile: z.string(),
    exitFile: z.string(),
    signalFile: z.string(),
  })
  .parse({
    profile,
    stateFile: process.env.ABLER_FAKE_BROWSER_STATE,
    exitFile: process.env.ABLER_FAKE_BROWSER_EXIT,
    signalFile: process.env.ABLER_FAKE_BROWSER_SIGNAL,
  });

const { profile: userDataDir, stateFile, exitFile, signalFile } = config;

if (process.env.ABLER_FAKE_LAUNCHER === '1') {
  const command = [process.execPath, resolve(import.meta.path), ...args];

  const env = {
    ...process.env,
    ABLER_FAKE_LAUNCHER: '0',
    ABLER_FAKE_LAUNCHER_CHILD: '1',
  };

  const detached = process.env.ABLER_FAKE_IGNORE_BROWSER_CLOSE === '1';

  const child = Bun.spawn(command, {
    env,
    stdio: ['ignore', 'ignore', 'ignore', 3, 4],
    detached,
  });

  child.unref();
  process.exitCode = 0;
} else if (process.env.ABLER_FAKE_EXIT_BEFORE_READY === '1') {
  await writeFile(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      profile: userDataDir,
      profileMode: (await stat(userDataDir)).mode & 0o777,
      transport: 'pipe',
    }),
  );
  process.exitCode = 23;
} else {
  if (!usePipe) throw new Error('The fake browser requires a private debugging pipe.');

  let closed = false;
  let polls = 0;
  const keepAlive = setInterval(() => undefined, 1000);

  async function closeFakeBrowser() {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    await writeFile(exitFile, 'closed');
    input.destroy();
    output.destroy();
  }

  const input = connect({ fd: 3, port: 0 });
  const output = connect({ fd: 4, port: 0 });
  let buffer = '';
  input.on('data', (chunk) => {
    buffer += chunk.toString();

    let end = buffer.indexOf('\0');

    while (end >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      handlePipeCommand(raw);
      end = buffer.indexOf('\0');
    }
  });
  input.on('error', () => undefined);
  output.on('error', () => undefined);

  let currentTarget = 'fake-page';

  function handlePipeCommand(raw: string): void {
    const command = z
      .object({
        id: z.number(),
        method: z.string(),
        params: z.object({ targetId: z.string().optional() }).optional(),
        sessionId: z.string().optional(),
      })
      .parse(JSON.parse(raw));

    let result = {};

    if (command.method === 'Browser.getVersion')
      result = process.env.ABLER_FAKE_BAD_READINESS === '1' ? {} : { product: 'Chrome/1.0' };
    else if (command.method === 'Target.getTargets')
      result = {
        targetInfos: [
          {
            targetId: currentTarget,
            type: 'page',
            url: 'https://www.abler.io/coach',
          },
        ],
      };
    else if (command.method === 'Target.attachToTarget')
      result = { sessionId: command.params?.targetId ?? currentTarget };
    else if (command.method === 'Network.getCookies') {
      if (
        process.env.ABLER_FAKE_DETACH_ON_EMPTY_POLL === '1' &&
        command.sessionId !== currentTarget
      ) {
        output.write(
          `${JSON.stringify({
            id: command.id,
            error: { code: -32001, message: 'Session with given id not found.' },
          })}\0`,
        );

        return;
      }

      polls++;
      result = {
        cookies:
          polls <= Number(process.env.ABLER_FAKE_EMPTY_POLLS)
            ? []
            : [
                {
                  name: 'refreshToken',
                  value: 'private-refresh',
                  domain: 'www.abler.io',
                  path: '/',
                  expires: Date.now() / 1000 + 3600,
                },
                ...(process.env.ABLER_FAKE_ID_TOKEN === '1'
                  ? [
                      {
                        name: 'id_token',
                        value: 'private-access',
                        domain: 'www.abler.io',
                        path: '/',
                        expires: Date.now() / 1000 + 3600,
                      },
                    ]
                  : []),
              ],
      };

      if (process.env.ABLER_FAKE_DETACH_ON_EMPTY_POLL === '1' && polls === 1) {
        currentTarget = 'replacement-page';
        output.write(`${JSON.stringify({ id: command.id, result })}\0`);
        output.write(
          `${JSON.stringify({
            method: 'Target.detachedFromTarget',
            params: { sessionId: 'fake-page' },
          })}\0`,
        );

        return;
      }
    }

    output.write(`${JSON.stringify({ id: command.id, result })}\0`);

    if (command.method === 'Browser.close' && process.env.ABLER_FAKE_IGNORE_BROWSER_CLOSE !== '1')
      setTimeout(() => {
        closeFakeBrowser().catch(() => {
          process.exitCode = 1;
        });
      }, 10);
  }

  await writeFile(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      profile: userDataDir,
      profileMode: (await stat(userDataDir)).mode & 0o777,
      transport: 'pipe',
    }),
  );

  process.on('SIGTERM', () => {
    writeFile(signalFile, 'SIGTERM')
      .then(async () => {
        if (process.env.ABLER_FAKE_IGNORE_SIGTERM === '1') return;

        if (process.env.ABLER_FAKE_DELAY_SIGTERM === '1') {
          setTimeout(() => {
            closeFakeBrowser().catch(() => {
              process.exitCode = 1;
            });
          }, 10_000);

          return;
        }

        return closeFakeBrowser();
      })
      .catch(() => {
        process.exitCode = 1;
      });
  });
}
