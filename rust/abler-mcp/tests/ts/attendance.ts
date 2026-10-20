// Offline acceptance: both CLIs, fake Abler, disposable stores. No family data or live requests.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const binary = process.argv[2];
if (!binary) throw new Error('A test-origin binary is required');
const repo = resolve(import.meta.dir, '../../../..');
const home = mkdtempSync(join(tmpdir(), 'abler-attendance-'));
const base = () => ({
  eventId: 'practice',
  name: 'Practice',
  type: 'TRAINING',
  status: 'OPEN',
  from: '2099-01-02T17:00:00Z',
  to: '2099-01-02T18:00:00Z',
  locationDetails: 'Hall',
  registrationEnd: null,
  attendanceLimit: -1,
  paymentRequestInfo: null,
  ageGroup: { id: 'team', guardiansDisabled: false },
  currentPlayerAttendance: [
    {
      player: { id: 'child', displayName: 'Child' },
      status: null,
      statusExt: null,
      comment: 'Keep this comment',
      paymentStatus: null,
      orderId: null,
      waitingListNr: null,
    },
  ],
});
let current: any,
  writes = 0,
  reads = 0,
  mode = 'ok',
  variables: any = {},
  rotated = false;
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const body = await request.json();
    if (rotated)
      assert(
        (request.headers.get('cookie') ?? '').includes('id_token=rotated'),
        'rotation persisted',
      );
    rotated = true;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'id_token=rotated; Path=/; Max-Age=3600; HttpOnly; Secure',
        },
      });
    if (new URL(request.url).pathname === '/oauth/token') return json({ access_token: 'fake' });
    if (body.operationName === 'Profile')
      return json({
        data: {
          me: {
            id: 'parent',
            displayName: 'Parent',
            children: [{ id: 'child', displayName: 'Child' }],
          },
        },
      });
    if (body.operationName === 'PracticeAttendance') {
      reads++;
      if (mode === 'failed-readback' && writes)
        return json({ errors: [{ message: 'private upstream text' }] });
      return json({ data: { event: { edges: [{ node: current }] } } });
    }
    assert.equal(body.operationName, 'SetPracticeAttendance');
    writes++;
    variables = body.variables;
    assert.equal(variables.comment, 'Keep this comment');
    assert.equal(variables.statusExt, null);
    if (!['mismatch', 'unauthenticated'].includes(mode))
      current.currentPlayerAttendance[0].status = variables.status;
    if (mode === 'unauthenticated')
      return json(
        { errors: [{ extensions: { code: 'UNAUTHENTICATED' }, message: 'private upstream text' }] },
        401,
      );
    if (mode === 'ambiguous') return json({ errors: [{ message: 'private upstream text' }] }, 500);
    return json({
      data: {
        setPlayerAttendanceV3: { eventId: 'practice', eventPlayer: { status: variables.status } },
      },
    });
  },
});
const args = {
  childId: 'child',
  eventId: 'practice',
  ageGroupId: 'team',
  attendance: 'attending',
  expectedStatus: null,
};
let scenarios = 0;
async function run(
  side: string,
  name: string,
  change: (event: any) => void = () => {},
  input: any = {},
  expected = 'error',
  responseMode = 'ok',
  enable = true,
) {
  current = base();
  change(current);
  writes = 0;
  reads = 0;
  variables = {};
  mode = responseMode;
  rotated = false;
  const dir = join(home, `${side}-${name}`);
  mkdirSync(dir, { mode: 0o700 });
  const session = join(dir, 'legacy.json');
  writeFileSync(
    session,
    JSON.stringify({
      version: 1,
      cookies: ['id_token', 'refreshToken'].map((name) => ({
        name,
        value: 'offline',
        domain: 'www.abler.io',
        path: '/',
        expires: Date.now() / 1000 + 3600,
      })),
    }),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    ABLER_SESSION_FILE: session,
    ABLER_TEST_ORIGIN: fake.url.origin,
    FAMILY_MCP_STORE_TEST_SEAM: '1',
  } as Record<string, string>;
  const transport = new StdioClientTransport({
    command: side === 'ts' ? process.execPath : binary!,
    args: [
      ...(side === 'ts'
        ? [
            '--preload',
            join(import.meta.dir, 'rewrite.ts'),
            join(repo, 'packages/abler-mcp/src/cli.ts'),
          ]
        : []),
      'serve',
      ...(enable ? ['--allow-attendance-writes'] : []),
    ],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'offline', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'set_practice_attendance');
    assert.equal(!!tool, enable, `${side} ${name}: opt-in surface`);
    if (!enable) {
      assert.equal(writes, 0);
      scenarios++;
      return;
    }
    assert.equal(tool!.annotations!.readOnlyHint, false);
    assert.deepEqual(
      tools,
      JSON.parse(readFileSync(join(repo, 'rust/abler-mcp/src/surface-attendance.json'), 'utf8'))
        .tools,
    );
    const result = await client.callTool({
      name: 'set_practice_attendance',
      arguments: { ...args, ...input },
    });
    const text = JSON.stringify(result);
    assert(!text.includes('private upstream text'));
    if (expected === 'error') {
      assert.equal(result.isError, true, `${side} ${name}: ${text}`);
      assert.equal(writes, 0);
    } else {
      const output = result.structuredContent as Record<string, unknown>;
      assert.equal(output.outcome, expected, `${side} ${name}: ${text}`);
      assert.equal(writes, expected === 'unchanged' ? 0 : 1, `${side} ${name}: never replay`);
      if (expected === 'updated') {
        assert.equal(variables.status, input.attendance === 'not_attending' ? 'N' : 'G');
        assert.equal(output.stateVerified, true);
      }
      if (responseMode === 'ambiguous') assert.equal(output.stateVerified, true);
      if (['failed-readback', 'mismatch', 'unauthenticated'].includes(responseMode))
        assert.equal(output.stateVerified, false);
      if (writes) assert.equal(reads, 2);
    }
    scenarios++;
  } finally {
    await client.close();
  }
}
try {
  for (const side of ['ts', 'rust']) {
    await run(side, 'default', undefined, {}, 'error', 'ok', false);
    await run(side, 'going', undefined, {}, 'updated');
    await run(side, 'not-going', undefined, { attendance: 'not_attending' }, 'updated');
    await run(
      side,
      'no-op',
      (e) => (e.currentPlayerAttendance[0].status = 'G'),
      { expectedStatus: 'G' },
      'unchanged',
    );
    const rejects: [string, (e: any) => void][] = [
      ['stale', (e) => (e.currentPlayerAttendance[0].status = 'N')],
      ['not-on-event', (e) => (e.currentPlayerAttendance[0].player.id = 'other')],
      ['duplicate', (e) => e.currentPlayerAttendance.push(e.currentPlayerAttendance[0])],
      ['wrong-event', (e) => (e.eventId = 'other')],
      ['wrong-group', (e) => (e.ageGroup.id = 'other')],
      ['match', (e) => (e.type = 'MATCH')],
      ['cancelled', (e) => (e.status = 'CANCELED')],
      ['past', (e) => (e.from = '2000-01-01T00:00:00Z')],
      ['unknown-time', (e) => (e.from = 'bad')],
      ['closed-registration', (e) => (e.registrationEnd = '2000-01-01T00:00:00Z')],
      ['unknown-deadline', (e) => (e.registrationEnd = 'bad')],
      ['disabled-guardian', (e) => (e.ageGroup.guardiansDisabled = true)],
      ['missing-guardian', (e) => delete e.ageGroup.guardiansDisabled],
      ['paid', (e) => (e.paymentRequestInfo = { price: 100 })],
      ['missing-payment', (e) => delete e.paymentRequestInfo],
      ['limited', (e) => (e.attendanceLimit = 10)],
      ['missing-limit', (e) => delete e.attendanceLimit],
    ];
    for (const [name, change] of rejects) await run(side, name, change);
    for (const field of ['paymentStatus', 'orderId', 'waitingListNr', 'statusExt']) {
      await run(
        side,
        field,
        (e) => (e.currentPlayerAttendance[0][field] = field === 'waitingListNr' ? 1 : 'value'),
      );
      await run(side, `missing-${field}`, (e) => delete e.currentPlayerAttendance[0][field]);
    }
    for (const failure of ['ambiguous', 'unauthenticated', 'failed-readback', 'mismatch'])
      await run(side, failure, undefined, {}, 'unknown', failure);
    await run(side, 'unknown-status', (e) => (e.currentPlayerAttendance[0].status = 'WAITING'), {
      expectedStatus: 'WAITING',
    });
    await run(side, 'unlinked', undefined, { childId: 'other' });
    await run(side, 'invalid-choice', undefined, { attendance: 'maybe' });
    await run(side, 'extra-field', undefined, { coachStatus: 'P' });
    await run(side, 'missing-precondition', undefined, { expectedStatus: undefined });
  }
  console.log(`attendance ok: ${scenarios} offline scenarios (reference + native)`);
} finally {
  fake.stop(true);
  rmSync(home, { recursive: true, force: true });
}
