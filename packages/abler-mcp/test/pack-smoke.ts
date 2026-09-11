import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { VERSION } from '../src/server.js';

const source = resolve(process.argv[2] || 'dist/cli.js');
const standalone = process.argv.includes('--standalone');
const directory = await mkdtemp(join(tmpdir(), 'abler-installed-'));
const client = new Client({ name: 'abler-package-check', version: '1.0.0' });
const executable = standalone ? join(directory, 'abler-mcp') : source;
if (standalone) {
  await copyFile(source, executable);
  await chmod(executable, 0o755);
  // Standalone startup must ignore unrelated working-directory configuration.
  await writeFile(join(directory, '.env'), 'BUN_OPTIONS="--preload ./missing.ts"\n');
  await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./missing.ts"]\n');
} else {
  const node = Bun.which('node');
  assert(node, 'Node.js must be installed');
  await symlink(node, join(directory, 'node'));
}
const env = { PATH: directory, ABLER_SESSION_FILE: join(directory, 'missing.json') };
try {
  const version = Bun.spawn([executable, '--version'], {
    cwd: directory,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(await version.exited, 0);
  assert.equal((await new Response(version.stdout).text()).trim(), VERSION);
  const transport = new StdioClientTransport({
    command: executable,
    cwd: directory,
    env,
    stderr: 'pipe',
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, VERSION);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).toSorted(), [
    'auth_status',
    'get_event',
    'get_profile',
    'list_child_schedules',
    'list_groups',
    'list_schedule',
  ]);
  const status = await client.callTool({ name: 'auth_status', arguments: {} });
  assert.equal(status.isError, true);
  assert.match(JSON.stringify(status), /No saved Abler session/);
  const typo = await client.callTool({
    name: 'list_child_schedules',
    arguments: { childId: 'misspelled' },
  });
  assert.equal(typo.isError, true);
  console.log(
    `Installed ${VERSION}: ${standalone ? 'standalone' : 'Node'} executable, MCP handshake, all six tools, missing auth, and strict child filters passed.`,
  );
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
