import { stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import { z } from 'zod';

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
    stateFile: process.env.INNA_FAKE_BROWSER_STATE,
    exitFile: process.env.INNA_FAKE_BROWSER_EXIT,
    signalFile: process.env.INNA_FAKE_BROWSER_SIGNAL,
  });

const { profile: userDataDir, stateFile, exitFile, signalFile } = config;

if (process.env.INNA_FAKE_LAUNCHER === '1') {
  const command = [process.execPath, resolve(import.meta.path), ...args];

  const env = {
    ...process.env,
    INNA_FAKE_LAUNCHER: '0',
    INNA_FAKE_LAUNCHER_CHILD: '1',
  };

  const detached = process.env.INNA_FAKE_IGNORE_BROWSER_CLOSE === '1';

  const child = Bun.spawn(command, {
    env,
    stdio: ['ignore', 'ignore', 'ignore', 3, 4],
    detached,
  });

  child.unref();
  process.exitCode = 0;
} else if (process.env.INNA_FAKE_EXIT_BEFORE_READY === '1') {
  await writeFile(
    stateFile,
    JSON.stringify({
      pid: process.pid,
      profile: userDataDir,
      profileMode: (await stat(userDataDir)).mode & 0o777,
      transport: 'pipe',
      args,
    }),
  );
  process.exitCode = 23;
} else {
  if (!usePipe) throw new Error('The fake browser requires a private debugging pipe.');

  let closed = false;
  let polls = 0;
  let targetPolls = 0;
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

  const nextTargetId = { value: 1 };
  const createdTargets: Record<string, { url: string; sessionId: string }> = {};
  let currentTarget = 'fake-page';
  const studentsUrl = 'https://nam.inna.is/Components/Students/Students.html#!/home';
  const session = { path: '/', expires: -1, session: true, secure: true, httpOnly: true };

  // Chrome answers Network.getCookies with far more than the school session; none of these may be saved.
  const decoys = [
    { ...session, name: 'SESSION', value: 'decoy-portal', domain: 'r.inna.is' },
    { ...session, name: 'SESSION', value: 'decoy-parent', domain: '.inna.is' },
    { ...session, name: 'SESSION', value: 'decoy-path', domain: 'nam.inna.is', path: '/api' },
    { ...session, name: 'JSESSIONID', value: 'decoy-google', domain: 'accounts.google.com' },
    { ...session, name: 'SID', value: 'decoy-sid', domain: '.google.com' },
    { ...session, name: 'tracking', value: 'decoy-other', domain: 'nam.inna.is' },
    { ...session, name: 'empty', value: '', domain: 'nam.inna.is' },
  ];

  const cookies = [
    ...decoys,
    { ...session, name: 'SESSION', value: 'synthetic-session', domain: 'nam.inna.is' },
    { ...session, name: 'JSESSIONID', value: 'synthetic-jsession', domain: 'nam.inna.is' },
    ...(process.env.INNA_FAKE_XSRF === '0'
      ? []
      : [
          {
            ...session,
            name: 'XSRF-TOKEN',
            value: 'synthetic-xsrf',
            domain: 'nam.inna.is',
            secure: false,
            httpOnly: false,
          },
        ]),
  ];

  function handlePipeCommand(raw: string): void {
    const command = z
      .object({
        id: z.number(),
        method: z.string(),
        params: z.unknown().optional(),
        sessionId: z.string().optional(),
      })
      .parse(JSON.parse(raw));

    let result = {};

    if (command.method === 'Browser.getVersion')
      result = process.env.INNA_FAKE_BAD_READINESS === '1' ? {} : { product: 'Chrome/1.0' };
    else if (command.method === 'Target.getTargets') {
      targetPolls++;
      result = {
        targetInfos: [
          { targetId: 'fake-worker', type: 'service_worker', url: studentsUrl },
          {
            targetId: currentTarget,
            type: 'page',
            url:
              targetPolls <= Number(process.env.INNA_FAKE_SIGNIN_POLLS ?? 0)
                ? 'https://accounts.google.com/v3/signin/identifier'
                : (process.env.INNA_FAKE_PAGE_URL ?? studentsUrl),
          },
        ],
      };
    } else if (command.method === 'Target.attachToTarget') {
      const targetId = command.params?.targetId ?? currentTarget;

      if (createdTargets[targetId]) {
        createdTargets[targetId].sessionId = `session-${targetId}`;
        result = { sessionId: createdTargets[targetId].sessionId };
      } else {
        result = { sessionId: targetId };
      }
    } else if (command.method === 'Target.createTarget') {
      const params = z
        .object({ url: z.string(), background: z.boolean().optional() })
        .parse(command.params);
      const targetId = `created-target-${nextTargetId.value++}`;

      createdTargets[targetId] = { url: params.url, sessionId: '' };
      result = { targetId };
    } else if (command.method === 'Target.closeTarget') {
      const params = z.object({ targetId: z.string() }).parse(command.params);

      delete createdTargets[params.targetId];
      result = { success: true };
    } else if (command.method === 'Runtime.evaluate') {
      const params = z
        .object({ expression: z.string(), returnByValue: z.boolean().optional() })
        .parse(command.params);

      const targetInfo = Object.values(createdTargets).find(
        (t) => t.sessionId === command.sessionId,
      );
      const url = targetInfo?.url ?? '';

      let value: unknown = null;

      if (params.expression === 'location.origin') {
        if (url.startsWith('https://r.inna.is')) value = 'https://r.inna.is';
        else if (url.startsWith('https://inna.is')) value = 'https://inna.is';
        else value = 'https://unknown';
      } else if (params.expression === "localStorage.getItem('id_token')") {
        if (
          process.env.INNA_FAKE_TOKEN_ORIGIN === 'r.inna.is' &&
          url.startsWith('https://r.inna.is')
        )
          value = process.env.INNA_FAKE_TOKEN_VALUE ?? null;
        else if (
          process.env.INNA_FAKE_TOKEN_ORIGIN === 'inna.is' &&
          url.startsWith('https://inna.is')
        )
          value = process.env.INNA_FAKE_TOKEN_VALUE ?? null;
        else value = null;
      }

      result = { result: { value } };
    } else if (command.method === 'Network.getCookies') {
      if (
        process.env.INNA_FAKE_DETACH_ON_EMPTY_POLL === '1' &&
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
        cookies: polls <= Number(process.env.INNA_FAKE_EMPTY_POLLS ?? 0) ? decoys : cookies,
      };

      if (process.env.INNA_FAKE_DETACH_ON_EMPTY_POLL === '1' && polls === 1) {
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

    if (command.method === 'Browser.close' && process.env.INNA_FAKE_IGNORE_BROWSER_CLOSE !== '1')
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
      args,
    }),
  );

  process.on('SIGTERM', () => {
    writeFile(signalFile, 'SIGTERM')
      .then(async () => {
        if (process.env.INNA_FAKE_IGNORE_SIGTERM === '1') return;

        if (process.env.INNA_FAKE_DELAY_SIGTERM === '1') {
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
