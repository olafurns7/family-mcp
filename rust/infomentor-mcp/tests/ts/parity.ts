// TypeScript-versus-Rust parity for infomentor-mcp, driven by tests/parity.rs. Each scenario runs
// once against the TypeScript CLI (with rewrite.ts preloaded) and once against the Rust binary
// (built with `test-origin`), each in its own scratch home and against the same local fake
// upstream, and compares outputs and exit codes. Prints mismatches and exits 1 on any.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [rust, only] = process.argv.slice(2);

if (!rust) throw new RangeError('Usage: parity.ts RUST_BINARY [SCENARIO]');

// Both sides keep their store in each scenario's scratch home through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError(
    'Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.',
  );
const repo = resolve(import.meta.dir, '../../../..');
const cli = join(repo, 'packages/infomentor-mcp/src/cli.ts');
const rewrite = join(import.meta.dir, 'rewrite.ts');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'infomentor-parity-'));

type Seen = { method: string; url: string };

const fake = { seen: [] as Seen[] };

function reset(): void {
  fake.seen = [];
}

/** The fake upstream: `<origin>/<host><path>` stands for `https://<host><path>`. */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const [, host = ''] = url.pathname.split('/');

  // Other processes probe loopback ports; only InfoMentor's hosts are recorded.
  if (!host.endsWith('infomentor.is')) return new Response(null, { status: 404 });
  fake.seen.push({
    method: request.method,
    url: `https://${host}${url.pathname.slice(host.length + 1)}${url.search}`,
  });

  return new Response('Not found', { status: 404 });
}

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
const origin = `http://127.0.0.1:${server.port}`;

type Step = { cli: string[] } | { serve: [string, unknown][]; args?: string[]; surface?: boolean };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

// No `--` cases: `bun cli.ts -- x` drops the `--` before the CLI sees it, while the released
// executable (and the Rust binary) passes it to parseArgs; main.rs's unit tests cover it.
const cliCases = [
  ['--help'],
  ['-h'],
  ['--version'],
  ['-v'],
  ['-hv'],
  ['--nope'],
  ['--help=1'],
  ['--allow-setup-tools=yes'],
  ['--local-form'],
  ['--local-form=1'],
  ['--session'],
  ['--session', '-x'],
  ['--timeout', '-1'],
  ['-x'],
  ['auth'],
  ['auth', 'login', 'x'],
  ['a', 'b'],
  ['nope'],
  ['auth', 'nope'],
  ['auth', 'serve', 'x'],
  ['status', '--timeout', '5'],
  ['migrate', '--import', 'x'],
  ['logout', '--allow-account-change'],
  ['nope', '--timeout', '5'],
  ['login', '--allow-setup-tools'],
  ['status', '--allow-setup-tools', '--timeout', '5'],
  ['login', '--import', 'a', '--credentials', 'b'],
  ['auth', 'login', '--import=a', '--credentials=b', '--timeout=1'],
  ['login', '--timeout', '0'],
  ['login', '--timeout=1.5'],
  ['login', '--timeout='],
  ['login', '--timeout', '3601'],
  ['login', '--timeout', 'abc'],
  ['login', '--timeout', 'Infinity'],
  ['auth', 'login', '--timeout', '0x0'],
];

const scenarios: Scenario[] = [
  {
    name: 'surface',
    steps: [
      { serve: [], surface: true },
      { serve: [], args: ['--allow-setup-tools'], surface: true },
      { serve: [], args: ['auth', 'serve'], surface: true },
    ],
  },
  { name: 'cli', steps: cliCases.map((args) => ({ cli: args })) },
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
    INFOMENTOR_TEST_ORIGIN: origin,
    ...extra,
  };
}

function command(side: 'ts' | 'rust', args: string[]): string[] {
  return side === 'ts' ? [process.execPath, '--preload', rewrite, cli, ...args] : [rust!, ...args];
}

async function runCli(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  args: string[],
) {
  const child = Bun.spawn(command(side, args), {
    cwd: home,
    env: environment(home, env),
    stdin: 'ignore',
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

async function runServe(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  step: { serve: [string, unknown][]; args?: string[]; surface?: boolean },
) {
  const [executable, ...args] = command(side, step.args ?? ['serve']);
  const transport = new StdioClientTransport({
    command: executable!,
    args,
    cwd: home,
    env: environment(home, env),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'infomentor-parity', version: '1.0.0' });
  const results: unknown[] = [];
  await client.connect(transport);

  if (step.surface) {
    const { tools } = await client.listTools();
    surfaces.push(tools.length);
    results.push({
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools,
    });
  }

  for (const [name, args] of step.serve) {
    try {
      results.push(await client.callTool({ name, arguments: args as Record<string, unknown> }));
    } catch (error) {
      results.push({ protocolError: error instanceof Error ? error.message : String(error) });
    }
  }
  await client.close();

  return results;
}

async function run(side: 'ts' | 'rust', scenario: Scenario) {
  const home = join(scratch, scenario.name, side);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  reset();
  const steps: unknown[] = [];

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(side, home, scenario.env ?? {}, step.cli));
    else steps.push(await runServe(side, home, scenario.env ?? {}, step));
  }

  return { steps, requests: fake.seen };
}

const failures: string[] = [];

/** Tool counts the servers listed, so the surface comparison is not vacuous. */
const surfaces: number[] = [];

/** CLI runs on the TypeScript side. */
let commands = 0;

function compare(name: string, ts: unknown, rs: unknown, path = ''): void {
  if (JSON.stringify(ts) === JSON.stringify(rs)) return;

  if (
    ts &&
    rs &&
    typeof ts === 'object' &&
    typeof rs === 'object' &&
    Array.isArray(ts) === Array.isArray(rs)
  ) {
    const keys = [...new Set([...Object.keys(ts), ...Object.keys(rs)])];

    if (JSON.stringify(Object.keys(ts)) !== JSON.stringify(Object.keys(rs)))
      failures.push(
        `${name}${path}: keys ${JSON.stringify(Object.keys(ts))} != ${JSON.stringify(Object.keys(rs))}`,
      );

    for (const key of keys)
      compare(
        name,
        (ts as Record<string, unknown>)[key],
        (rs as Record<string, unknown>)[key],
        `${path}.${key}`,
      );

    return;
  }
  const clip = (value: unknown) => String(JSON.stringify(value)).slice(0, 600);
  failures.push(`${name}${path}:\n  ts:   ${clip(ts)}\n  rust: ${clip(rs)}`);
}

try {
  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const ts = await run('ts', scenario);
    commands += scenario.steps.filter((step) => 'cli' in step).length;
    compare(scenario.name, ts, await run('rust', scenario));
  }
} finally {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

// Each side listed the 7 default tools, and all 11 with --allow-setup-tools.
if (!only && (JSON.stringify(surfaces) !== '[7,11,7,7,11,7]' || commands !== cliCases.length))
  failures.push(`coverage too low: ${JSON.stringify({ surfaces, commands })}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify({ surfaces, commands })}`);
