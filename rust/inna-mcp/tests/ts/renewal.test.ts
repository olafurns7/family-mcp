import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COOKIES, fresh, startFake, type Seen } from './fake-inna.ts';

const binary = process.env.INNA_RUST_BINARY!;
const USER = '/api/UserData/GetLoggedInUser';
const SCHOOL = '/api/StudentTerms/GetStudentTerms';
const POST = '/api/RegisterAbsence/AddNewLeave';

async function fixture(bound = 1_500, args: string[] = []) {
  const directory = mkdtempSync(join(process.env.TMPDIR!, 'renewal-'));
  const state = fresh();
  const seen: Seen[] = [];
  const fake = await startFake(() => ({ state, seen }));
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'data'),
    INNA_SESSION_FILE: join(directory, 'legacy.json'),
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    INNA_TEST_ORIGIN: fake.origin,
    INNA_TEST_RENEWAL_MS: String(bound),
  };
  mkdirSync(env.XDG_CONFIG_HOME, { mode: 0o700 });
  const source = join(directory, 'cookies.json');
  writeFileSync(source, COOKIES, { mode: 0o600 });
  chmodSync(source, 0o600);
  const cli = async (args: string[]) => {
    const child = Bun.spawn([binary, ...args], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout + stderr).not.toContain('synthetic-');
  };
  await cli(['auth', 'import', source]);
  const child = Bun.spawn([binary, 'serve', ...args], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pending = new Map<number, (value: any) => void>();
  let id = 0;
  let stdout = '';
  const stderr = new Response(child.stderr).text();
  const output = (async () => {
    let buffer = '';
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      stdout += text;
      buffer += text;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
      }
    }
  })();
  const request = (method: string, params: object) => {
    const number = ++id;
    const answer = new Promise<any>((resolve) => pending.set(number, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: number, method, params })}\n`);
    return answer;
  };
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'renewal-test', version: '1' },
  });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const call = (name = 'inna_get_overview', args: object = {}) =>
    request('tools/call', { name, arguments: args });
  const paths = (from = 0) => seen.slice(from).map((request) => new URL(request.url).pathname);
  const close = async () => {
    child.stdin.end();
    await child.exited;
    await output;
    const text = stdout + (await stderr);
    // Every value, including rotations and the second process's import, uses this prefix.
    expect(text).not.toContain('synthetic-');
    expect(text).not.toContain('DO-NOT-RETURN');
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { state, seen, paths, call, close, cli, source };
}

test('idle serve survives several TTLs within the scaled 30-minute bound, including the flag', async () => {
  for (const args of [[], ['--no-keep-alive']]) {
    const f = await fixture(1_500, args);
    try {
      f.state.ttl = 3_000;
      f.state.renewalGaps = [];
      await Bun.sleep(9_300);
      expect(f.state.rotations).toBeGreaterThan(6);
      expect(Math.max(...f.state.renewalGaps)).toBeLessThan(1_500);
      expect(f.paths().every((path) => path === USER)).toBe(true);
      expect((await f.call()).isError).not.toBe(true);
    } finally {
      await f.close();
    }
  }
});

test('401 and 5xx renewals fail closed past the bound without a school request', async () => {
  for (const status of [401, 500]) {
    const f = await fixture(300);
    try {
      expect((await f.call()).isError).not.toBe(true);
      f.state.planted[USER] = { status };
      await Bun.sleep(450);
      const from = f.seen.length;
      const result = await f.call();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        status === 401 ? 'sign-in is required' : 'unavailable or unexpected',
      );
      expect(f.paths(from).every((path) => path === USER)).toBe(true);
      delete f.state.planted[USER];
      expect((await f.call()).isError).not.toBe(true);
    } finally {
      await f.close();
    }
  }
});

test('read 401 refreshes once and retries once; a second 401 has no third school request', async () => {
  for (const [failures, studentKey] of [
    [1, undefined],
    [2, undefined],
    [1, '5'],
  ] as const) {
    const f = await fixture(60_000);
    try {
      f.state.once401 = { [SCHOOL]: failures };
      const from = f.seen.length;
      const result = await f.call('inna_get_overview', { studentKey });
      expect(Boolean(result.isError)).toBe(failures === 2);
      const paths = f.paths(from);
      expect(paths.filter((path) => path === SCHOOL)).toHaveLength(2);
      const first = paths.indexOf(SCHOOL);
      expect(paths.slice(first, first + 3)).toEqual([SCHOOL, USER, SCHOOL]);
      if (failures === 2) expect(JSON.stringify(result)).toContain('sign-in is required');
    } finally {
      await f.close();
    }
  }
});

test('a separate CLI import rotates the stored session used by 401 recovery', async () => {
  const f = await fixture(60_000);
  try {
    await f.call();
    await f.cli(['auth', 'import', f.source]);
    const rotated = `synthetic-rotated-${f.state.rotations}`;
    f.state.once401 = { [USER]: 1 };
    const from = f.seen.length;
    expect((await f.call()).isError).not.toBe(true);
    expect(f.seen[from]?.headers.cookie).toContain(rotated);
    expect(f.paths(from).slice(0, 3)).toEqual([USER, USER, USER]);
  } finally {
    await f.close();
  }
});

test('renewal age is checked again between school requests within one call', async () => {
  const f = await fixture(300);
  try {
    const first = '/api/Announcements/GetStudentAnnouncements';
    f.state.delays[first] = 350;
    f.state.afterUser = () => {
      f.state.planted[USER] = { status: 500 };
    };
    const from = f.seen.length;
    expect((await f.call()).isError).toBe(true);
    expect(f.paths(from).slice(0, 3)).toEqual([USER, first, USER]);
    expect(f.paths(from).filter((path) => path !== USER)).toEqual([first]);
  } finally {
    await f.close();
  }
});

test('401 on absence POST sends once and retains the uncertain outcome', async () => {
  const f = await fixture(60_000, ['--allow-absence-writes']);
  try {
    f.state.planted['/api/RegisterAbsence/GetStudentRegisteredAbsences'] = {
      status: 200,
      body: '[]',
    };
    f.state.planted['/api/RegisterAbsence/GetStudentLeaves'] = { status: 200, body: '[]' };
    const day = new Date().toISOString().slice(0, 10);
    const preview = await f.call('inna_prepare_absence', {
      kind: 'leave',
      dateFrom: day,
      dateTo: day,
      reason: 'Test',
    });
    expect(preview.isError).not.toBe(true);
    f.state.planted[POST] = { status: 401 };
    const result = await f.call('inna_submit_absence', {
      operationId: preview.structuredContent.operationId,
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('outcome is uncertain');
    expect(f.paths().filter((path) => path === POST)).toHaveLength(1);
    const status = await f.call('inna_absence_status');
    expect(status.structuredContent.operation.state).toBe('unknown');
  } finally {
    await f.close();
  }
});
