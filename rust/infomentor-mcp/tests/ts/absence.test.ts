// Native-only opt-in tools. Synthetic loopback upstream; never touches a real account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, chmod, symlink, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CookieJar } from 'tough-cookie';
import { captureSession, writeSession } from '../../../../packages/infomentor-mcp/src/session.js';
import { useScratchStore } from '../../../../packages/infomentor-mcp/test/scratch.js';

const store = useScratchStore();
const binary = process.env['INFOMENTOR_RUST_BINARY'];
if (!binary || process.env['FAMILY_MCP_STORE_TEST_SEAM'] !== '1')
  throw new Error('Isolated native test runner required.');
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const schoolDate = (date: string) => date.split('-').toReversed().join('.');

async function fixture() {
  const legacy = join(store.home, 'session.json');
  const record = join(dirname(store.record), 'absence.json');
  const jar = new CookieJar();
  jar.setCookieSync('IMHome=synthetic; Secure; Path=/', 'https://minn.infomentor.is/');
  await writeSession(
    { ...captureSession(jar), accountId: 'parent-1', selectedChildId: 'child-1' },
    legacy,
  );
  const state = {
    selected: 'child-1',
    account: 'parent-1',
    posts: 0,
    loginRequests: 0,
    reads: 0,
    mode: 'success',
    allowed: true,
    locked: false,
    partial: false,
    missing: false,
    url: '/attendance/attendance/registerAttendance',
    date: '',
    onRead: () => {},
    onParent: () => {},
    onPost: () => {},
    absent: new Set<string>(),
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(
      /^\/minn\.infomentor\.is/,
      '',
    );
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (path.includes('authentication') || path.includes('Mentor')) state.loginRequests++;
    if (path === '/authentication/authentication/isauthenticated/') {
      res.setHeader('Content-Type', 'application/json');
      res.end('true');
    } else if (path === '/') {
      state.onParent();
      const data = {
        account: {
          currentUser: { id: state.account },
          pupils: ['child-1', 'child-2'].map((id, i) => ({
            id,
            name: `Synthetic child ${i + 1}`,
            selected: state.selected === id,
            switchPupilUrl: `/Account/PupilSwitcher/SwitchPupil/${i + 1}`,
          })),
        },
        apps: [{ codeName: 'attendance' }],
      };
      res.end(
        `<script>IMHome.home.homeData = ${JSON.stringify(data)}; IMHome.home.init(IMHome.home.homeData);</script>`,
      );
    } else if (path.startsWith('/Account/PupilSwitcher/')) {
      state.selected = `child-${path.split('/').at(-1)}`;
      res.writeHead(302, { Location: 'https://minn.infomentor.is/' });
      res.end();
    } else if (path === '/attendance/attendance/appData') {
      state.reads++;
      state.onRead();
      const data: Record<string, unknown> = {
        isParent: true,
        isIcelandic: true,
        canRegisterDayAbsence: state.allowed,
        urls: { registerAttendance: state.url },
      };
      for (const [suffix, date] of [
        ['Today', today()],
        ['Tomorrow', tomorrow()],
      ]) {
        const day = suffix.toLowerCase();
        Object.assign(data, {
          [`absence${suffix}Date`]: state.date || schoolDate(date!),
          [`absent${suffix}`]: state.absent.has(`${state.selected}/${day}`),
          [`absence${suffix}Locked`]: state.locked,
          [`canAddSickness${suffix}`]: false,
          [`absence${suffix}Sessions`]: [{ isAbsent: state.partial, readOnly: false }],
          [`partOfDayAbsenceRegistrations${suffix}`]: [],
        });
      }
      if (state.missing) delete data['absenceTomorrowLocked'];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    } else if (path === '/attendance/attendance/registerAttendance') {
      state.posts++;
      state.onPost();
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(req.headers['origin'], 'https://minn.infomentor.is');
      const payload = JSON.parse(body);
      assert.deepEqual(payload, {
        present: false,
        day: payload.day,
        canAddSicknessToTimeRegistration: false,
        RegType: 'day',
      });
      assert.ok(['today', 'tomorrow'].includes(payload.day));
      if (state.mode !== 'unverified') state.absent.add(`${state.selected}/${payload.day}`);
      if (state.mode === 'lost') {
        req.socket.destroy();
        return;
      }
      if (state.mode === 'crash') {
        await new Promise(() => {});
        return;
      }
      if (/^30[12378]$/.test(state.mode)) {
        res.writeHead(Number(state.mode), {
          Location: 'https://minn.infomentor.is/attendance/attendance/registerAttendance',
        });
        res.end();
        return;
      }
      if (state.mode === '401' || state.mode === '429' || state.mode === '500') {
        res.writeHead(Number(state.mode));
        res.end('synthetic private error');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    } else {
      res.writeHead(500);
      res.end('unexpected synthetic request');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connections: { client: Client; transport: StdioClientTransport }[] = [];
  async function connect(writes = true) {
    const client = new Client({ name: 'absence-test', version: '1' });
    const transport = new StdioClientTransport({
      command: binary!,
      args: ['serve', '--session', legacy, ...(writes ? ['--allow-absence-writes'] : [])],
      env: {
        ...(process.env as Record<string, string>),
        INFOMENTOR_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
        INFOMENTOR_USERNAME: 'synthetic',
        INFOMENTOR_PASSWORD: 'synthetic',
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    connections.push({ client, transport });
    return client;
  }
  async function prepare(client: Client, childId = 'child-2', date = today()) {
    const reply = await client.callTool({
      name: 'infomentor_prepare_absence',
      arguments: { childId, date },
    });
    assert.ok(!reply.isError, JSON.stringify(reply));
    return reply.structuredContent as { operationId: string; child: { id: string }; date: string };
  }
  async function submit(client: Client, operationId: string) {
    return client.callTool({
      name: 'infomentor_submit_absence',
      arguments: { operationId, confirm: true },
    });
  }
  async function editRecord(edit: (data: Record<string, unknown>) => void) {
    const data = JSON.parse(await readFile(record, 'utf8'));
    edit(data);
    await writeFile(record, JSON.stringify(data), { mode: 0o600 });
  }
  return {
    state,
    record,
    legacy,
    connect,
    prepare,
    submit,
    editRecord,
    restore: () =>
      writeSession(
        { ...captureSession(jar), accountId: 'parent-1', selectedChildId: 'child-1' },
        legacy,
      ),
    relogin: async () => {
      const transfer = join(store.home, 'transfer.json');
      await writeSession(
        { ...captureSession(jar), accountId: 'parent-1', selectedChildId: 'child-1' },
        transfer,
      );
      const child = Bun.spawn([binary!, 'login', '--import', transfer, '--session', legacy], {
        env: { ...process.env, INFOMENTOR_TEST_ORIGIN: `http://127.0.0.1:${address.port}` },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(await child.exited, 0, await new Response(child.stderr).text());
    },
    kill: (client: Client) => {
      const connection = connections.find((c) => c.client === client);
      assert.ok(connection?.transport.pid);
      process.kill(connection.transport.pid, 'SIGKILL');
    },
    close: async () => {
      await Promise.all(connections.map(({ client }) => client.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('write tools are absent by default, present only with explicit opt-in', async () => {
  const f = await fixture();
  try {
    const reader = await f.connect(false);
    const writer = await f.connect();
    assert.equal((await reader.listTools()).tools.length, 7);
    const tools = (await writer.listTools()).tools;
    assert.equal(tools.length, 9);
    assert.ok(
      tools
        .filter((t) => t.name.includes('absence'))
        .every((t) => t.annotations?.readOnlyHint === false),
    );
    await assert.rejects(
      reader.callTool({
        name: 'infomentor_submit_absence',
        arguments: { confirm: true, operationId: '00000000-0000-4000-8000-000000000000' },
      }),
    );
    assert.equal(f.state.posts, 0);
  } finally {
    await f.close();
  }
});

for (const date of ['today', 'tomorrow'])
  test(`confirmed ${date} sickness selects the preview child, verifies state and is idempotent across restart`, async () => {
    const f = await fixture();
    try {
      const client = await f.connect();
      const preview = await f.prepare(client, 'child-2', date === 'today' ? today() : tomorrow());
      assert.equal(preview.child.id, 'child-2');
      assert.equal(f.state.posts, 0);
      assert.equal((await stat(f.record)).mode & 0o777, 0o600);
      f.state.selected = 'child-1';
      const reply = await f.submit(client, preview.operationId);
      assert.equal(reply.structuredContent?.['outcome'], 'submitted');
      assert.equal(reply.structuredContent?.['stateVerified'], true);
      assert.ok(f.state.absent.has(`child-2/${date}`));
      assert.equal(f.state.posts, 1);
      await client.close();
      const restarted = await f.connect();
      assert.equal(
        (await f.submit(restarted, preview.operationId)).structuredContent?.['outcome'],
        'submitted',
      );
      const duplicate = await restarted.callTool({
        name: 'infomentor_prepare_absence',
        arguments: { childId: 'child-2', date: preview.date },
      });
      assert.ok(duplicate.isError);
      assert.equal(f.state.posts, 1);
    } finally {
      await f.close();
    }
  });

for (const mode of ['lost', 'unverified', '301', '302', '303', '307', '308', '401', '429', '500'])
  test(`${mode} after send is unknown, never redirected/renewed/replayed, and survives restart`, async () => {
    const f = await fixture();
    try {
      const client = await f.connect();
      const preview = await f.prepare(client);
      f.state.mode = mode;
      const reply = await f.submit(client, preview.operationId);
      assert.equal(reply.structuredContent?.['outcome'], 'unknown');
      assert.equal(f.state.posts, 1);
      assert.equal(f.state.loginRequests, 0);
      await client.close();
      let restarted = await f.connect();
      if (mode === '429') {
        // Normal session backoff still applies before an existing outcome can be read.
        assert.ok((await f.submit(restarted, preview.operationId)).isError);
        await restarted.close();
        await f.restore(); // test-only end of the simulated cooldown; never resets the guard
        restarted = await f.connect();
      }
      assert.equal(
        (await f.submit(restarted, preview.operationId)).structuredContent?.['outcome'],
        'unknown',
      );
      assert.ok(
        (
          await restarted.callTool({
            name: 'infomentor_prepare_absence',
            arguments: { childId: 'child-1', date: tomorrow() },
          })
        ).isError,
      );
      assert.equal(f.state.posts, 1);
      assert.equal(f.state.loginRequests, 0);
    } finally {
      await f.close();
    }
  });

for (const failure of [
  'permission',
  'locked',
  'partial',
  'existing',
  'missing',
  'url',
  'date',
  'selection',
  'account',
  'expiry',
  'rollover',
  'record',
  'symlink',
  'record-permissions',
])
  test(`preflight blocks ${failure} without a write`, async () => {
    const f = await fixture();
    try {
      const client = await f.connect();
      const preview = await f.prepare(client);
      if (failure === 'permission') f.state.allowed = false;
      if (failure === 'locked') f.state.locked = true;
      if (failure === 'partial') f.state.partial = true;
      if (failure === 'existing') f.state.absent.add('child-2/today');
      if (failure === 'missing') f.state.missing = true;
      if (failure === 'url') f.state.url = 'https://untrusted.invalid/write';
      if (failure === 'date') f.state.date = '31.02.2026';
      if (failure === 'selection')
        f.state.onRead = () => {
          f.state.selected = 'child-1';
        };
      if (failure === 'account') f.state.account = 'another-parent';
      if (failure === 'expiry')
        await f.editRecord((data) => {
          data['expiresAt'] = Date.now() - 1;
        });
      if (failure === 'rollover')
        await f.editRecord((data) => {
          data['day'] = 'tomorrow';
        });
      if (failure === 'record') await writeFile(f.record, 'corrupt');
      if (failure === 'record-permissions') await chmod(f.record, 0o644);
      if (failure === 'symlink') {
        const target = f.record + '.target';
        await writeFile(target, await readFile(f.record), { mode: 0o600 });
        await unlink(f.record);
        await symlink(target, f.record);
      }
      assert.ok((await f.submit(client, preview.operationId)).isError);
      assert.equal(f.state.posts, 0);
    } finally {
      await f.close();
    }
  });

test('strict inputs and explicit confirmation are checked before any request', async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    for (const args of [
      { childId: 'child-1', date: '2026-02-31' },
      { childId: 'child-1', date: today(), extra: true },
      { childId: '', date: today() },
    ])
      assert.ok(
        (await client.callTool({ name: 'infomentor_prepare_absence', arguments: args })).isError,
      );
    const preview = await f.prepare(client);
    for (const args of [
      { operationId: preview.operationId },
      { operationId: preview.operationId, confirm: false },
      { operationId: preview.operationId, confirm: true, extra: true },
      { operationId: 'invalid', confirm: true },
    ])
      assert.ok(
        (await client.callTool({ name: 'infomentor_submit_absence', arguments: args })).isError,
      );
    assert.equal(f.state.posts, 0);
  } finally {
    await f.close();
  }
});

test('submitting marker survives a killed process and logout; no new child may bypass it', async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    const preview = await f.prepare(client);
    let posted!: () => void;
    const didPost = new Promise<void>((resolve) => {
      posted = resolve;
    });
    f.state.onPost = () => posted();
    f.state.mode = 'crash';
    const pending = f.submit(client, preview.operationId).catch(() => undefined);
    await didPost;
    f.kill(client);
    await pending;
    const restarted = await f.connect();
    assert.equal(
      (await f.submit(restarted, preview.operationId)).structuredContent?.['outcome'],
      'unknown',
    );
    const child = Bun.spawn([binary!, 'logout', '--session', f.legacy], {
      env: { ...process.env, INFOMENTOR_TEST_ORIGIN: 'http://127.0.0.1:9' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(await child.exited, 0);
    assert.equal(JSON.parse(await readFile(f.record, 'utf8')).state, 'submitting');
    const alias = Bun.spawn([binary!, 'logout', '--session', f.record], {
      env: { ...process.env, INFOMENTOR_TEST_ORIGIN: 'http://127.0.0.1:9' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.notEqual(await alias.exited, 0);
    assert.match(await new Response(alias.stderr).text(), /overlaps the private absence record/);
    await f.relogin();
    const relogged = await f.connect();
    assert.equal(
      (await relogged.callTool({ name: 'infomentor_session_status', arguments: {} }))
        .structuredContent?.['authenticated'],
      true,
    );
    const blocked = await relogged.callTool({
      name: 'infomentor_prepare_absence',
      arguments: { childId: 'child-1', date: tomorrow() },
    });
    assert.match(JSON.stringify(blocked), /submission is uncertain/);
    assert.ok(blocked.isError);
    assert.equal(f.state.posts, 1);
  } finally {
    await f.close();
  }
});

test('two MCP processes cannot submit the same preview twice', async () => {
  const f = await fixture();
  try {
    const first = await f.connect();
    const second = await f.connect();
    const preview = await f.prepare(first);
    const replies = await Promise.all([
      f.submit(first, preview.operationId),
      f.submit(second, preview.operationId),
    ]);
    assert.ok(replies.every((reply) => reply.structuredContent?.['outcome'] === 'submitted'));
    assert.equal(f.state.posts, 1);
  } finally {
    await f.close();
  }
});
