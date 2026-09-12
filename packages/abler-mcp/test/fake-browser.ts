import { writeFileSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';

import * as z from 'zod/v4';

import { createCdpMock } from './cdp-mock.js';

const args = process.argv.slice(2);

const profile = args
  .find((argument) => argument.startsWith('--user-data-dir='))
  ?.slice('--user-data-dir='.length);

const address = args
  .find((argument) => argument.startsWith('--remote-debugging-address='))
  ?.slice('--remote-debugging-address='.length);

const portArgument = args.find((argument) => argument.startsWith('--remote-debugging-port='));

const usePipe = args.includes('--remote-debugging-pipe');

const config = z
  .object({
    profile: z.string(),
    address: z.literal('127.0.0.1'),
    stateFile: z.string(),
    exitFile: z.string(),
    signalFile: z.string(),
    decoyRequestFile: z.string(),
  })
  .parse({
    profile,
    address,
    stateFile: process.env.ABLER_FAKE_BROWSER_STATE,
    exitFile: process.env.ABLER_FAKE_BROWSER_EXIT,
    signalFile: process.env.ABLER_FAKE_BROWSER_SIGNAL,
    decoyRequestFile: process.env.ABLER_FAKE_BROWSER_DECOY_REQUEST,
  });

const {
  profile: userDataDir,
  address: debugAddress,
  stateFile,
  exitFile,
  signalFile,
  decoyRequestFile,
} = config;

if (process.env.ABLER_FAKE_LAUNCHER === '1') {
  const command = [process.execPath, resolve(import.meta.path), ...args];
  const env = { ...process.env, ABLER_FAKE_LAUNCHER: '0' };

  const child = usePipe
    ? Bun.spawn(command, {
        env,
        stdio: ['ignore', 'ignore', 'ignore', 3, 4],
      })
    : Bun.spawn(command, { env, stdio: ['ignore', 'ignore', 'ignore'] });

  child.unref();
  process.exitCode = 0;
} else if (process.env.ABLER_FAKE_EXIT_BEFORE_READY === '1') {
  await writeFile(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      profile: userDataDir,
      profileMode: (await stat(userDataDir)).mode & 0o777,
      transport: usePipe ? 'pipe' : 'port',
    }),
  );
  process.exitCode = 23;
} else {
  const requestedPort = portArgument ? Number(portArgument.split('=')[1]) : undefined;

  if (!usePipe && requestedPort === undefined)
    throw new Error('The fake browser received no remote debugging transport.');

  const activePortFile = join(userDataDir, 'DevToolsActivePort');
  const mocks: ReturnType<typeof createCdpMock>[] = [];
  let input: ReturnType<typeof connect> | undefined;
  let output: ReturnType<typeof connect> | undefined;
  let closed = false;
  let polls = 0;

  async function closeFakeBrowser() {
    if (closed) return;
    closed = true;
    await rm(activePortFile, { force: true });
    await writeFile(exitFile, 'closed');
    await Promise.all(mocks.map((mock) => mock.server.stop(true)));
    input?.destroy();
    output?.destroy();
  }

  function markDecoyRequest() {
    writeFileSync(decoyRequestFile, 'used');
  }

  if (usePipe) {
    const decoy = createCdpMock({
      hostname: debugAddress,
      includeIdToken: true,
      refreshToken: 'decoy-refresh',
      idToken: 'decoy-access',
      onRequest: markDecoyRequest,
    });

    mocks.push(decoy);

    input = connect({ fd: 3, port: 0 });
    output = connect({ fd: 4, port: 0 });
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

    function handlePipeCommand(raw: string): void {
      const command = z.object({ id: z.number(), method: z.string() }).parse(JSON.parse(raw));

      let result = {};

      if (command.method === 'Browser.getVersion')
        result = process.env.ABLER_FAKE_BAD_READINESS === '1' ? {} : { product: 'Chrome/1.0' };
      else if (command.method === 'Target.getTargets')
        result = {
          targetInfos: [
            {
              targetId: 'fake-page',
              type: 'page',
              url: 'https://www.abler.io/coach',
            },
          ],
        };
      else if (command.method === 'Target.attachToTarget') result = { sessionId: 'fake-page' };
      else if (command.method === 'Network.getCookies') {
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
      }

      output?.write(`${JSON.stringify({ id: command.id, result })}\0`);

      if (command.method === 'Browser.close' && process.env.ABLER_FAKE_IGNORE_BROWSER_CLOSE !== '1')
        setTimeout(() => {
          closeFakeBrowser().catch(() => {
            process.exitCode = 1;
          });
        }, 10);
    }
  } else {
    const actual = createCdpMock({
      hostname: debugAddress,
      port: 0,
      emptyPolls: Number(process.env.ABLER_FAKE_EMPTY_POLLS),
      includeIdToken: process.env.ABLER_FAKE_ID_TOKEN === '1',
      invalidVersion: process.env.ABLER_FAKE_BAD_READINESS === '1',
      onBrowserClose: () => {
        setTimeout(() => {
          closeFakeBrowser().catch(() => {
            process.exitCode = 1;
          });
        }, 10);
      },
    });

    mocks.push(actual);

    if (requestedPort !== undefined && requestedPort !== 0) {
      mocks.push(
        createCdpMock({
          hostname: debugAddress,
          port: requestedPort,
          includeIdToken: true,
          refreshToken: 'decoy-refresh',
          idToken: 'decoy-access',
          onRequest: markDecoyRequest,
          ignoreBrowserClose: true,
        }),
      );
    } else {
      mocks.push(
        createCdpMock({
          hostname: debugAddress,
          includeIdToken: true,
          refreshToken: 'decoy-refresh',
          idToken: 'decoy-access',
          onRequest: markDecoyRequest,
          ignoreBrowserClose: true,
        }),
      );
    }

    await writeFile(activePortFile, `${actual.server.port}\n/devtools/browser/fake-browser\n`);
  }

  const actualPort = usePipe ? undefined : mocks[0]?.server.port;
  const decoyPort = mocks[usePipe ? 0 : 1]?.server.port;

  await writeFile(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      profile: userDataDir,
      profileMode: (await stat(userDataDir)).mode & 0o777,
      transport: usePipe ? 'pipe' : 'port',
      actualPort,
      decoyPort,
    }),
  );

  process.on('SIGTERM', () => {
    writeFile(signalFile, 'SIGTERM')
      .then(async () => {
        if (process.env.ABLER_FAKE_DELAY_SIGTERM === '1') {
          await rm(activePortFile, { force: true });
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
