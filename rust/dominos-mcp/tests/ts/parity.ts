import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [rust] = process.argv.slice(2);
if (!rust) throw new Error('Usage: parity.ts RUST_BINARY');
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1') throw new Error('Scratch store required.');
const root = resolve(import.meta.dir, '../../../..');
const cli = join(root, 'packages/dominos-mcp/src/cli.ts');
const home = mkdtempSync(join(tmpdir(), 'dominos-parity-'));
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), DOMINOS_TEST_ORIGIN: 'http://127.0.0.1:9' };
const ts = [process.execPath, cli];
let cases = 0;
async function run(command: string[], args: string[]) {
  const child = Bun.spawn(command[0] === process.execPath ? [process.execPath, join(import.meta.dir, 'cli.ts'), JSON.stringify(args)] : [...command, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}
try {
  for (const args of [
    ['--help'], ['--version'], ['-hv'], ['-vh'], ['--help', 'bad'], ['--nope'], ['--help=1'], ['--version='], ['-x'], ['-é'], ['-😀'], ['-vx'], ['-h=1'], ['--='], ['---x'], ['--no-help'], ['--', '--help'], ['bad'], ['auth'], ['auth', 'bad'], ['auth', 'status', 'extra'], ['serve', 'extra'],
  ]) {
    assert.deepEqual(await run([rust], args), await run(ts, args), JSON.stringify(args));
    cases++;
  }
  const clients: Client[] = [];
  const surfaces = [];
  for (const command of [ts, [rust]]) {
    const transport = new StdioClientTransport({ command: command[0]!, args: [...command.slice(1), 'serve'], env: env as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'dominos-parity', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    surfaces.push({ instructions: client.getInstructions(), tools: (await client.listTools()).tools });
  }
  assert.deepEqual(surfaces[1], surfaces[0]);
  assert.equal(surfaces[0]!.tools.length, 13);
  await Promise.all(clients.map((client) => client.close()));
  cases++;
  const unsafe = join(env.XDG_CONFIG_HOME, 'dominos-mcp');
  mkdirSync(unsafe, { recursive: true, mode: 0o755 });
  assert.deepEqual(await run([rust], ['bad']), await run(ts, ['bad']));
  cases++;
  console.log(`parity ok: ${cases} scenarios, 13 tools`);
} finally { rmSync(home, { recursive: true, force: true }); }
