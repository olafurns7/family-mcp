// SIGINT and SIGTERM for the binary's migrate and logout, which take no signal: the TypeScript CLI
// listens with `process.once`, so the first signal changes nothing and the second one ends the
// process, which keeps the plaintext session it had not yet moved. Run by tests/typescript.rs from
// packages/infomentor-mcp; TypeScript holds the plaintext session's lock, so the binary waits.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from '../../../../packages/infomentor-mcp/src/lock.js';
import { writeSession } from '../../../../packages/infomentor-mcp/src/session.js';

const rustBinary = process.env.INFOMENTOR_RUST_BINARY!;

const session = {
  version: 2 as const,
  savedAt: '2026-09-01T00:00:00.000Z',
  cookies: [
    {
      key: 'IMHome',
      value: 'synthetic',
      domain: 'minn.infomentor.is',
      path: '/',
      hostOnly: true,
    },
  ],
  accountId: 'parent-1',
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Start `args` while TypeScript holds the plaintext session's lock, send `signals` a second
 * apart, then release the lock after `holdMs`.
 */
async function interrupted(args: string[], signals: NodeJS.Signals[], holdMs: number) {
  const home = await mkdtemp(join(tmpdir(), 'infomentor-mcp-signals-'));
  const file = join(home, 'session.json');
  await writeSession(session, file);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const holder = withSessionLock(file, undefined, async () => {
    locked.resolve();
    await release.promise;
  });

  await locked.promise;

  const child = Bun.spawn([rustBinary, ...args, '--session', file], {
    env: {
      ...process.env,
      FAMILY_MCP_STORE_TEST_SEAM: '1',
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      // The test build needs a local upstream; nothing listens on this one.
      INFOMENTOR_TEST_ORIGIN: 'http://127.0.0.1:9',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const running: boolean[] = [];

  try {
    for (const signal of signals) {
      await Bun.sleep(1000);
      child.kill(signal);
      await Bun.sleep(300);
      running.push(child.exitCode === null && child.signalCode === null);
    }

    await Bun.sleep(holdMs);
    const endedWhileLocked = child.exitCode !== null || child.signalCode !== null;
    release.resolve();
    await holder;
    await child.exited;

    return {
      running,
      endedWhileLocked,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stderr: await new Response(child.stderr).text(),
      legacyKept: await exists(file),
      record: await exists(join(home, 'config/infomentor-mcp/session.enc')),
    };
  } finally {
    release.resolve();
    child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
}

test('a second SIGINT ends a migrate waiting for the lock and keeps the plaintext session', async () => {
  expect(await interrupted(['migrate'], ['SIGINT', 'SIGINT'], 500)).toEqual({
    running: [true, false],
    endedWhileLocked: true,
    exitCode: 130,
    signalCode: null,
    stderr: '',
    legacyKept: true,
    record: false,
  });
}, 30_000);

test('a second SIGTERM ends a logout waiting for the lock and keeps the plaintext session', async () => {
  expect(await interrupted(['logout'], ['SIGTERM', 'SIGTERM'], 500)).toEqual({
    running: [true, false],
    endedWhileLocked: true,
    exitCode: 143,
    signalCode: null,
    stderr: '',
    legacyKept: true,
    record: false,
  });
}, 30_000);

test('one SIGINT changes nothing: migrate still moves the session once the lock frees', async () => {
  expect(await interrupted(['migrate'], ['SIGINT'], 500)).toEqual({
    running: [true],
    endedWhileLocked: false,
    exitCode: 0,
    signalCode: null,
    stderr: 'Moved the InfoMentor session into the encrypted store and removed its file.\n',
    legacyKept: false,
    record: true,
  });
}, 30_000);
