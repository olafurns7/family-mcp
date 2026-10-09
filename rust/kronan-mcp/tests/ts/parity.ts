// TypeScript-versus-Rust parity for kronan-mcp, driven by tests/parity.rs. Each scenario runs once
// against the TypeScript CLI (with rewrite.ts preloaded) and once against the Rust binary (built
// with `test-origin`), each in its own scratch home and against the same local fake upstream, and
// compares outputs, exit codes, upstream requests, the stored token and the files left behind.
// Prints mismatches and exits 1 on any.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  defaultKeyProvider,
  defaultSecretRecordPath,
  withSecretStore,
} from '../../../../packages/session-store/src/index.ts';

const [rust, only] = process.argv.slice(2);

if (!rust) throw new RangeError('Usage: parity.ts RUST_BINARY [SCENARIO]');

// Both sides keep their store in each scenario's scratch home through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');
const repo = resolve(import.meta.dir, '../../../..');
const cli = join(repo, 'packages/kronan-mcp/src/cli.ts');
const rewrite = join(import.meta.dir, 'rewrite.ts');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'kronan-parity-'));

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

const fake = { mode: 'ok', seen: [] as Seen[] };

function reset(): void {
  fake.mode = 'ok';
  fake.seen = [];
}

/** The fake answers every documented path; modes change what it answers. */
function handle(request: Request, body: string): Response {
  const url = new URL(request.url);

  switch (fake.mode) {
    case 'status401':
      return Response.json({ detail: 'secret detail' }, { status: 401 });
    default:
      return Response.json({ path: url.pathname, body }, { status: 404 });
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    // Other processes probe loopback ports; only Krónan's API paths are recorded.
    if (!url.pathname.startsWith('/api/v1/')) return new Response(null, { status: 404 });
    const body = await request.text();
    const headers: Record<string, string> = {};

    for (const name of ['authorization', 'accept', 'content-type', 'content-length']) {
      const value = request.headers.get(name);

      if (value !== null) headers[name] = value;
    }
    fake.seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers, body });

    return handle(request, body);
  },
});
const origin = `http://127.0.0.1:${server.port}`;

type Step =
  | { cli: string[]; stdin?: string }
  | { serve: [string, unknown][]; surface?: boolean }
  | { mode: string }
  | { file: string; text: string; permissions?: number };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

const scenarios: Scenario[] = [
  { name: 'surface', steps: [{ serve: [], surface: true }] },
  {
    name: 'cli',
    steps: [
      ['--help'], ['-h'], ['--version'], ['-v'], ['-hv'], ['-vh'], ['--nope'], ['--nope=1'], ['--help=1'],
      ['--version='], ['-x'], ['-vx'], ['-h=1'], ['--='], ['---x'], ['-h', '--nope'], ['-h', '--', 'x'],
      ['auth'], ['auth', 'nope'], ['auth', 'status', 'x'], ['auth', 'migrate', ''], ['auth', 'logout', 'x'],
      ['auth', 'set', 'a', 'b'], ['serve', 'x'], ['x'], ['-'], ['orders'], ['orders', 'clear-attempts', 'x'],
      ['orders', 'nope'], ['auth', '--', '--help'],
    ].map((args) => ({ cli: args })),
  },
];

function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    KRONAN_TEST_ORIGIN: origin,
    ...extra,
  };
}

function command(side: 'ts' | 'rust', args: string[]): string[] {
  return side === 'ts' ? [process.execPath, '--preload', rewrite, cli, ...args] : [rust!, ...args];
}

async function runCli(side: 'ts' | 'rust', home: string, env: Record<string, string>, args: string[], stdin?: string) {
  const child = Bun.spawn(command(side, args), {
    cwd: home,
    env: environment(home, env),
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { args, code, stdout, stderr };
}

async function runServe(side: 'ts' | 'rust', home: string, env: Record<string, string>, calls: [string, unknown][], surface = false) {
  const [executable, ...args] = command(side, ['serve']);
  const transport = new StdioClientTransport({ command: executable!, args, cwd: home, env: environment(home, env), stderr: 'pipe' });
  const client = new Client({ name: 'kronan-parity', version: '1.0.0' });
  const results: unknown[] = [];
  await client.connect(transport);

  if (surface) {
    results.push({
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    });
  }

  for (const [name, args] of calls) {
    try {
      results.push(await client.callTool({ name, arguments: args as Record<string, unknown> }));
    } catch (error) {
      results.push({ protocolError: error instanceof Error ? error.message : String(error) });
    }
  }
  await client.close();

  return results;
}

async function stored(home: string): Promise<unknown> {
  const saved = { ...process.env };
  Object.assign(process.env, environment(home));

  try {
    const options = {
      path: defaultSecretRecordPath('kronan-mcp'),
      server: 'kronan-mcp',
      profile: 'default',
      purpose: 'token',
      schema: 1,
      maxBytes: 16_384,
      keys: defaultKeyProvider({ server: 'kronan-mcp', profile: 'default' }),
    };

    if (!existsSync(options.path) && !existsSync(`${options.path}.marker`)) return 'no store';
    const text = await withSecretStore(options, (store) => store.read());

    return text === null ? null : JSON.parse(text);
  } catch (error) {
    return `error: ${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'}`;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function files(home: string): unknown {
  const directory = join(home, '.config/kronan-mcp');

  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .sort()
    .map((name) => (name.endsWith('.json') ? { name, text: readFileSync(join(directory, name), 'utf8') } : name));
}

function write(home: string, step: { file: string; text: string; permissions?: number }): void {
  const path = join(home, step.file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, step.text, { mode: step.permissions ?? 0o600 });
  chmodSync(path, step.permissions ?? 0o600);
}

async function run(side: 'ts' | 'rust', scenario: Scenario) {
  const home = join(scratch, scenario.name, side);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  reset();
  const steps: unknown[] = [];

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(side, home, scenario.env ?? {}, step.cli, step.stdin));
    else if ('serve' in step) steps.push(await runServe(side, home, scenario.env ?? {}, step.serve, step.surface));
    else if ('mode' in step) fake.mode = step.mode;
    else write(home, step);
  }

  return { steps, requests: fake.seen, store: await stored(home), files: files(home) };
}

const failures: string[] = [];

/** CLI runs and tool results on the TypeScript side, so parity is not vacuous. */
const coverage = { cli: 0, tools: 0 };

function compare(name: string, ts: unknown, rs: unknown, path = ''): void {
  if (JSON.stringify(ts) === JSON.stringify(rs)) return;

  if (ts && rs && typeof ts === 'object' && typeof rs === 'object' && Array.isArray(ts) === Array.isArray(rs)) {
    const keys = [...new Set([...Object.keys(ts), ...Object.keys(rs)])];

    if (JSON.stringify(Object.keys(ts)) !== JSON.stringify(Object.keys(rs)))
      failures.push(`${name}${path}: keys ${JSON.stringify(Object.keys(ts))} != ${JSON.stringify(Object.keys(rs))}`);

    for (const key of keys)
      compare(name, (ts as Record<string, unknown>)[key], (rs as Record<string, unknown>)[key], `${path}.${key}`);

    return;
  }
  const clip = (value: unknown) => String(JSON.stringify(value)).slice(0, 600);
  failures.push(`${name}${path}:\n  ts:   ${clip(ts)}\n  rust: ${clip(rs)}`);
}

try {
  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const ts = await run('ts', scenario);
    coverage.cli += scenario.steps.filter((step) => 'cli' in step).length;
    coverage.tools += JSON.stringify(ts.steps).split('"content"').length - 1;
    compare(scenario.name, ts, await run('rust', scenario));
  }
} finally {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

if (!only && coverage.cli < 30) failures.push(`coverage too low: ${JSON.stringify(coverage)}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify(coverage)}`);
