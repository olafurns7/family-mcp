// TypeScript-versus-Rust parity for inna-mcp, driven by tests/parity.rs. Each scenario runs once
// against the TypeScript CLI and once against the Rust binary (built with `test-origin`), each in
// its own scratch home, and compares outputs, exit codes and the files left behind, with the home
// path written as <home>. Prints mismatches and exits 1 on any.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [rust, only] = process.argv.slice(2);

if (!rust) throw new RangeError('Usage: parity.ts RUST_BINARY [SCENARIO]');

// Both sides keep their store in each scenario's scratch home through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');
const repo = resolve(import.meta.dir, '../../../..');
const cli = join(repo, 'packages/inna-mcp/src/cli.ts');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'inna-parity-'));

type Step =
  | { cli: string[]; stdin?: string }
  | { serve: [string, unknown][]; args?: string[]; surface?: boolean }
  | { file: string; text: string; permissions?: number }
  | { directory: string; permissions: number };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

const storeFile = '.config/inna-mcp/session.enc';

const scenarios: Scenario[] = [
  { name: 'surface', steps: [{ serve: [], surface: true }] },
  { name: 'surface-writes', steps: [{ serve: [], args: ['--allow-absence-writes'], surface: true }] },
  { name: 'surface-no-keep-alive', steps: [{ serve: [], args: ['--no-keep-alive'], surface: true }] },
  {
    name: 'write-tools-hidden',
    steps: [{ serve: [['inna_prepare_absence', {}], ['inna_submit_absence', {}], ['nope', {}]] }],
  },
  {
    name: 'cli',
    steps: [
      ['--help'], ['-h'], ['--version'], ['-v'], ['-hv'], ['--help', 'x', '--google'], ['--nope'], ['-x'],
      ['--help=1'], ['--google=1'], ['--timeout'], ['--timeout', '-5'], ['--keep-alive'], ['auth'], ['x'],
      [''], ['serve', 'x'], ['serve', '--allow-account-change'], ['serve', '--google'], ['--timeout', '5'],
      ['auth', 'login', '--timeout', '5'], ['auth', 'login', '--browser', 'b'], ['auth', 'login', 'x', '--google'],
      ['auth', 'status', '--google'], ['auth', 'login', '--allow-absence-writes'],
      ['auth', 'logout', '--no-keep-alive'], ['auth', 'import'], ['auth', 'import', ''],
      ['auth', 'import', 'a', 'b'], ['auth', 'status', 'x'], ['auth', 'status', '--allow-account-change'],
      // No `--` case: `bun cli.ts -- ...` drops the first `--` before cli.ts sees it, while the
      // released Bun binary passes it on, as the Rust binary reads it (main.rs tests it).
      ['auth', 'bogus'], ['auth', '', 'x'],
    ].map((args) => ({ cli: args })),
  },
  {
    name: 'store-file-open',
    steps: [{ file: storeFile, text: 'x', permissions: 0o644 }, { cli: ['auth', 'status'] }, { cli: ['auth', 'bogus'] }],
  },
  {
    name: 'store-folder-open',
    steps: [
      { file: storeFile, text: 'x' },
      { directory: '.config/inna-mcp', permissions: 0o755 },
      { cli: ['serve'] },
      { cli: ['auth', 'login'] },
    ],
  },
];

function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    ...extra,
  };
}

function command(side: 'ts' | 'rust', args: string[]): string[] {
  return side === 'ts' ? [process.execPath, cli, ...args] : [rust!, ...args];
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

  return { args, code, stdout: stdout.replaceAll(home, '<home>'), stderr: stderr.replaceAll(home, '<home>') };
}

async function runServe(
  side: 'ts' | 'rust',
  home: string,
  env: Record<string, string>,
  step: { serve: [string, unknown][]; args?: string[]; surface?: boolean },
) {
  const [executable, ...args] = command(side, ['serve', ...(step.args ?? [])]);
  const transport = new StdioClientTransport({ command: executable!, args, cwd: home, env: environment(home, env), stderr: 'pipe' });
  const client = new Client({ name: 'inna-parity', version: '1.0.0' });
  const results: unknown[] = [];
  await client.connect(transport);

  if (step.surface) {
    results.push({
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
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

/** Every file and folder under the home with its permissions; contents stay unread. */
function files(home: string, directory = home): unknown[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      const entry = `${path.slice(home.length + 1)} ${(stat.mode & 0o777).toString(8)}`;

      return stat.isDirectory() ? [entry, ...files(home, path)] : [entry];
    });
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
  const steps: unknown[] = [];

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(side, home, scenario.env ?? {}, step.cli, step.stdin));
    else if ('serve' in step) steps.push(await runServe(side, home, scenario.env ?? {}, step));
    else if ('directory' in step) chmodSync(join(home, step.directory), step.permissions);
    else write(home, step);
  }

  return { steps, files: existsSync(home) ? files(home) : [] };
}

const failures: string[] = [];

/** CLI runs and tool lists on the TypeScript side, so parity is not vacuous. */
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
    const text = JSON.stringify(ts.steps);
    coverage.cli += text.split('"code":').length - 1;
    coverage.tools += text.split('"inputSchema"').length - 1;
    compare(scenario.name, ts, await run('rust', scenario));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (!only && (coverage.cli < 37 || coverage.tools < 44)) failures.push(`coverage too low: ${JSON.stringify(coverage)}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify(coverage)}`);
