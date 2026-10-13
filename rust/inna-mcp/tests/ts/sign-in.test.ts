// Rust-only explicit sign-in lifecycle. Every host is redirected to a synthetic provider.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  readStored,
  storeAt,
  storeEnvironment,
  updateStored,
} from '../../../../packages/inna-mcp/test/scratch.ts';
import { provider } from './fake-eid.ts';
import { upstream } from './rust-inna.ts';

const PHONE = '5550000';
const binary = process.env.INNA_RUST_BINARY!;
const hosts = ['r.inna.is', 'heimdallur.inna.is', 'innskra.island.is', 'inna.is', 'nam.inna.is'];
const user = {
  userId: 2,
  studentId: '2',
  schoolId: '3',
  studentName: 'Synthetic student',
  name: 'Synthetic guardian',
  schoolLong: 'Synthetic school',
  defaultTermId: '4',
  isGuardian: true,
  logInType: '2',
  access: [],
  olderThan18: false,
  registerAbsenceGuardian: '1',
  registerAbsenceUnder18: '0',
  registerAbsenceOver18: '1',
  registerAbsence: '1',
  student18RegisterAbsence: '1',
  registerLeave: '1',
  student18RegisterLeave: '1',
  registerIllnessTomorrow: '1',
};

async function fixture(timeout = 3000) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'inna-sign-in-'));
  const store = storeAt(home);
  const clock = join(home, 'clock');
  let now = Date.parse('2040-01-02T12:00:00Z');
  const tick = (ms: number) => {
    now += ms;
    writeFileSync(clock, String(now));
  };
  tick(0);
  const p = provider();
  let mode = 'approve';
  let release: (() => void) | undefined;
  let userId = 2;
  let readStatus = 200;
  let starts = 0;
  let polls = 0;
  const served = await upstream(
    async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/UserData/GetLoggedInUser')
        return Response.json({ ...user, userId }, { status: readStatus });
      if (path === '/login/phone') {
        starts += 1;
        return Response.json({
          displayCode: '0123',
          verificationProperties: 'synthetic-verification',
        });
      }
      if (path === '/login/phone/authenticate' && mode === 'reject')
        return new Response(PHONE, { status: 403 });
      if (path === '/login/phone/poll' && mode === 'pending') {
        polls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (path === '/login/phone/poll') {
        // Each attempt has its own polling session in the real provider.
        const body = JSON.parse(String(init.body));
        return Response.json({ ...body, data: 'synthetic-success', isSuccess: true });
      }
      if (path === '/login/phone/signin')
        init = {
          ...init,
          body: JSON.stringify({ session: { data: 'synthetic-success', isSuccess: true } }),
        };
      return p.fetcher(url, init);
    },
    () => {},
    hosts,
  );
  const env = {
    ...(process.env as Record<string, string>),
    ...storeEnvironment(home),
    INNA_SESSION_FILE: join(home, 'legacy.json'),
    INNA_TEST_ORIGIN: served.origin,
    INNA_TEST_NOW: clock,
    INNA_TEST_KEEP_ALIVE: '1',
    INNA_TEST_SIGN_IN_MS: String(timeout),
    INNA_TEST_WAITS: join(home, 'waits'),
  };
  let client: Client | undefined;
  let errors = '';
  let pid: number | null = null;
  const cli = async (args: string[], input = '') => {
    const child = Bun.spawn([binary, ...args], {
      env,
      stdin: new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stdout + stderr).not.toContain(PHONE);
    return { code, stdout, stderr };
  };
  const open = async () => {
    const transport = new StdioClientTransport({
      command: binary,
      args: ['serve'],
      env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (data: Buffer) => {
      errors += data.toString();
    });
    client = new Client({ name: 'sign-in-test', version: '1' });
    await client.connect(transport);
    pid = transport.pid;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client!.callTool({ name, arguments: args });
    expect(JSON.stringify(result) + errors).not.toContain(PHONE);
    return result;
  };
  const status = async () => (await call('inna_sign_in_status')).structuredContent!;
  const until = async (state: string) => {
    const end = performance.now() + 5000;
    for (;;) {
      const current = await status();
      if (current.status === state) return current;
      if (performance.now() > end) throw new Error(`Expected ${state}, got ${current.status}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    home,
    store,
    p,
    cli,
    open,
    call,
    status,
    until,
    tick,
    starts: () => starts,
    errors: () => errors,
    fire: () => {
      if (pid) process.kill(pid, 'SIGUSR1');
    },
    polls: () => polls,
    mode: (value: string) => {
      mode = value;
    },
    user: (id: number) => {
      userId = id;
    },
    read: (status: number) => {
      readStatus = status;
    },
    release: () => release?.(),
    close: async () => {
      release?.();
      await client?.close();
      client = undefined;
    },
    closeOnly: async () => {
      const gone = pid;
      await client?.close();
      client = undefined;
      const end = performance.now() + 5000;
      for (;;) {
        try {
          process.kill(gone!, 0);
        } catch {
          return;
        }
        if (performance.now() > end) throw new Error('serve did not exit');
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    },
    second: async () => {
      const transport = new StdioClientTransport({
        command: binary,
        args: ['serve'],
        env,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (data: Buffer) => {
        errors += data.toString();
      });
      const other = new Client({ name: 'sign-in-test-b', version: '1' });
      await other.connect(transport);
      return other;
    },
    now: () => now,
    dispose: async () => {
      release?.();
      await client?.close();
      await served.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('code reaches MCP immediately; approval saves the default even when the lock wait outlasts the login deadline', async () => {
  const f = await fixture(2000);
  try {
    f.user(5);
    f.p.setAccess([
      { system: 1, user_id: 5, status: 3, is_access: true },
      { system: 1, user_id: 2, status: 3, is_access: true },
    ]);
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    f.p.setAccess([
      { system: 1, user_id: 2, status: 3, is_access: true },
      { system: 1, user_id: 5, status: 3, is_access: true },
    ]);
    expect(JSON.parse(await readStored(f.store)).signIn.phone).toBe(PHONE);
    expect((await f.cli(['auth', 'status'])).stdout).toContain('phone number is stored');
    f.mode('pending');
    await f.open();
    expect((await f.status()).status).toBe('none');
    const first = await f.call('inna_sign_in');
    expect(first.structuredContent?.code).toBe('0123');
    expect(first.structuredContent?.status).toBe('pending');
    const second = await f.call('inna_sign_in');
    expect(second).toEqual(first);
    expect(f.starts()).toBe(2);
    const end = performance.now() + 2000;
    while (!f.polls()) {
      if (performance.now() > end) throw new Error('poll not reached');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    // Hold the same legacy lock used by verified save until approval has reached the provider.
    const { withFileLock } = await import('@family-mcp/session-store');
    let entered: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = withFileLock(join(f.home, 'legacy.json'), {}, async () => {
      entered!();
      // Scaled equivalent of a save lock held beyond the production 180-second login deadline.
      await new Promise<void>((resolve) => setTimeout(resolve, 2800));
    });
    await held;
    f.release();
    // The provider has completed approval, but the shared lock still prevents saving.
    const deadline = performance.now() + 2000;
    while (
      !f.p.calls.some(
        (call) =>
          call.url.pathname === '/Components/Students/Students.html' &&
          f.p.calls.filter((call) => call.url.pathname === '/Components/Students/Students.html')
            .length === 2,
      )
    ) {
      if (performance.now() > deadline) throw new Error('approval did not finish');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect((await f.status()).status).toBe('pending');
    await lock;
    await f.until('approved');
    const saved = JSON.parse(await readStored(f.store));
    expect(saved.account.userId).toBe(5);
    expect(f.p.selections.at(-1)?.user_id).toBe('5');
    expect(saved.signIn.phone).toBe(PHONE);
    expect(saved.signIn.starts).toHaveLength(1);
    expect(readFileSync(f.store.path).includes(Buffer.from(PHONE))).toBe(false);
  } finally {
    await f.dispose();
  }
});

test('rejection and binding mismatch fail with cooldown; cap survives restart and permits a later day', async () => {
  const f = await fixture();
  try {
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    await f.open();
    f.user(99);
    await f.call('inna_sign_in');
    await f.until('failed');
    expect(JSON.parse(await readStored(f.store)).account.userId).toBe(2);
    expect((await f.call('inna_sign_in')).isError).toBe(true);
    expect(f.starts()).toBe(2);
    f.user(2);
    f.mode('reject');
    for (let index = 1; index < 10; index += 1) {
      f.tick(61_000);
      await f.call('inna_sign_in');
      await f.until('failed');
    }
    expect(f.starts()).toBe(11);
    await f.close();
    await f.open();
    f.tick(61_000);
    const refused = await f.call('inna_sign_in');
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain('10 starts');
    expect(f.starts()).toBe(11);
    f.tick(86_400_000);
    f.mode('approve');
    await f.call('inna_sign_in');
    await f.until('approved');
    expect(f.starts()).toBe(12);
  } finally {
    await f.dispose();
  }
});

test('timeout is expired and a failed read never starts eID; signed-out reads direct recovery', async () => {
  const f = await fixture(1000);
  try {
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    await f.open();
    f.read(401);
    f.fire();
    const refusedDeadline = performance.now() + 2000;
    while (!f.errors().includes('keep-alive: signInRequired')) {
      if (performance.now() > refusedDeadline)
        throw new Error('keep-alive never refused the old session');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const before = f.starts();
    for (const tool of ['inna_get_overview', 'inna_session_status', 'inna_list_students']) {
      expect(JSON.stringify(await f.call(tool))).toContain('signed out: call inna_sign_in');
    }
    expect(f.starts()).toBe(before);
    f.read(200);
    await f.call('inna_sign_in');
    await f.until('approved');
    const kept = f.errors().split('keep-alive: kept').length;
    f.fire();
    const keptDeadline = performance.now() + 2000;
    while (f.errors().split('keep-alive: kept').length === kept) {
      if (performance.now() > keptDeadline)
        throw new Error('verified sign-in did not resume keep-alive for reused cookie values');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    f.mode('pending');
    await f.call('inna_sign_in');
    await f.until('expired');
    expect((await f.call('inna_sign_in')).isError).toBe(true);
    f.release();
  } finally {
    await f.dispose();
  }
});

test('old records without a phone and absent sessions do not start eID; inputs are strict', async () => {
  const f = await fixture();
  try {
    await f.open();
    expect(JSON.stringify(await f.call('inna_sign_in'))).toContain('auth login once in a terminal');
    expect(JSON.stringify(await f.call('inna_session_status'))).toContain('call inna_sign_in');
    expect((await f.call('inna_sign_in', { phone: PHONE })).isError).toBe(true);
    await f.close();
    // Import exercises the old schema, without phone metadata.
    const source = join(f.home, 'cookies.json');
    writeFileSync(
      source,
      JSON.stringify([
        { name: 'SESSION', value: 'synthetic', domain: 'nam.inna.is' },
        { name: 'XSRF-TOKEN', value: 'synthetic', domain: 'nam.inna.is' },
      ]),
      { mode: 0o600 },
    );
    expect((await f.cli(['auth', 'import', source])).code).toBe(0);
    await f.open();
    expect(JSON.stringify(await f.call('inna_sign_in'))).toContain('auth login once in a terminal');
    expect(f.starts()).toBe(0);
  } finally {
    await f.dispose();
  }
});

test('saved rate-limit pause and unreadable store fail closed without an eID start', async () => {
  const f = await fixture();
  try {
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    await updateStored(f.store, (text) =>
      JSON.stringify({ ...JSON.parse(text), pauseUntil: Date.parse('2040-01-03T12:00:00Z') }),
    );
    await f.open();
    const paused = await f.call('inna_sign_in');
    expect(paused.isError).toBe(true);
    expect(JSON.stringify(paused)).toContain('pause');
    expect(f.starts()).toBe(1);
    await f.close();
    await updateStored(f.store, () => '{');
    await f.open();
    expect((await f.call('inna_get_overview')).isError).toBe(true);
    expect((await f.call('inna_sign_in')).isError).toBe(true);
    expect(f.starts()).toBe(1);
  } finally {
    await f.dispose();
  }
});

async function polled(f: Awaited<ReturnType<typeof fixture>>) {
  const end = performance.now() + 2000;
  while (!f.polls()) {
    if (performance.now() > end) throw new Error('poll not reached');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('P1 shutdown during a pending sign-in exits and clears its lease with cooldown', async () => {
  const f = await fixture(30_000);
  try {
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    f.mode('pending');
    await f.open();
    await f.call('inna_sign_in');
    await polled(f);
    await f.closeOnly();
    const guard = JSON.parse(await readStored(f.store)).signIn;
    expect(guard.pendingUntil).toBe(0);
    expect(guard.cooldownUntil).toBe(f.now() + 60_000);
    expect(guard.starts).toHaveLength(1);
    await f.open();
    expect((await f.status()).status).toBe('none');
    expect((await f.call('inna_sign_in')).isError).toBe(true);
  } finally {
    await f.dispose();
  }
});

test('P2 second serve reuses a foreign lease and its later lease survives the first process cleanup', async () => {
  const f = await fixture(30_000);
  let b: Client | undefined;
  try {
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    f.mode('pending');
    await f.open();
    await f.call('inna_sign_in');
    await polled(f);
    b = await f.second();
    const pendingMessage =
      'A sign-in started by another inna-mcp process is pending; approve with the code shown there or wait up to 4 minutes.';
    for (const name of ['inna_sign_in', 'inna_sign_in_status']) {
      const pending = (await b.callTool({ name, arguments: {} })).structuredContent!;
      expect(pending.status).toBe('pending');
      expect(pending.code).toBeUndefined();
      expect(pending.message).toBe(pendingMessage);
    }
    expect(f.starts()).toBe(2);
    // Model a suspended first process returning after its saved lease and cooldown elapsed.
    f.tick(301_000);
    const next = await b.callTool({ name: 'inna_sign_in', arguments: {} });
    expect(next.structuredContent?.code).toBe('0123');
    const lease = JSON.parse(await readStored(f.store)).signIn.pendingUntil;
    expect(lease).toBe(f.now() + 240_000);
    expect(f.starts()).toBe(3);
    await f.closeOnly();
    const guard = JSON.parse(await readStored(f.store)).signIn;
    expect(guard.pendingUntil).toBe(lease);
    expect(guard.cooldownUntil).toBeLessThan(f.now());
    f.release();
    const end = performance.now() + 5000;
    for (;;) {
      const current = (await b.callTool({ name: 'inna_sign_in_status', arguments: {} }))
        .structuredContent!;
      if (current.status === 'approved') break;
      if (performance.now() > end) throw new Error('second serve did not approve');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(JSON.parse(await readStored(f.store)).signIn.pendingUntil).toBe(0);
    expect(f.errors()).not.toContain(PHONE);
  } finally {
    f.release();
    await b?.close();
    await f.dispose();
  }
});

test('malformed optional sign-in guard preserves session reads and never starts eID', async () => {
  const f = await fixture();
  try {
    expect((await f.cli(['auth', 'login'], `${PHONE}\n`)).code).toBe(0);
    await updateStored(f.store, (text) =>
      JSON.stringify({ ...JSON.parse(text), signIn: { starts: ['bad'] } }),
    );
    await f.open();
    expect((await f.call('inna_list_students')).isError).not.toBe(true);
    expect((await f.call('inna_session_status')).structuredContent?.authenticated).toBe(true);
    expect(JSON.stringify(await f.call('inna_sign_in'))).toContain('auth login once in a terminal');
    expect(f.starts()).toBe(1);
    const guard = JSON.parse(await readStored(f.store)).signIn;
    expect(guard.phone).toBeUndefined();
    expect(guard.starts).toHaveLength(10);
  } finally {
    await f.dispose();
  }
});
