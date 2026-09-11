import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const directory = await mkdtemp(join(tmpdir(), 'infomentor-installer-'));

const archive = `infomentor-mcp-${version}-${process.platform}-${process.arch}.tar.gz`;

const prefix = join(directory, 'prefix with spaces');

const fakeBin = join(directory, 'download-fixture');

try {
  await mkdir(fakeBin);
  await copyFile(join(root, 'release', archive), join(directory, archive));
  await copyFile(join(root, 'release', archive + '.sha256'), join(directory, archive + '.sha256'));
  // Only replace HTTPS downloads with local release bytes; run the real shell installer and binary.
  await writeFile(
    join(fakeBin, 'curl'),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url=$1 ;; -o) shift; output=$1 ;; esac
  shift
done
cp "$TEST_ASSETS/\${url##*/}" "$output"
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    TEST_ASSETS: directory,
    INFOMENTOR_PREFIX: prefix,
    INFOMENTOR_VERSION: version,
  };

  execFileSync('/bin/sh', [join(root, 'install.sh')], { env, stdio: 'pipe' });
  const binary = join(prefix, 'bin/infomentor-mcp');
  assert.equal(execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(), version);
  // Reinstalling is safe and an invalid download must preserve the working installation.
  execFileSync('/bin/sh', [join(root, 'install.sh')], { env, stdio: 'pipe' });
  await writeFile(
    join(directory, archive + '.sha256'),
    `0000000000000000000000000000000000000000000000000000000000000000  ${archive}\n`,
  );
  assert.notEqual(spawnSync('/bin/sh', [join(root, 'install.sh')], { env }).status, 0);
  assert.equal(execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(), version);

  const standalone = join(directory, 'standalone');
  await copyFile(binary, standalone);

  const transport = new StdioClientTransport({
    command: standalone,
    args: ['--session', join(directory, 'missing.json')],
    env: { PATH: '/usr/bin:/bin' },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'binary-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 9);
    const status = await client.callTool({ name: 'infomentor_session_status', arguments: {} });
    assert.equal(status.structuredContent?.authenticated, false);
  } finally {
    await client.close();
  }

  console.log(
    'Installer passed without system Node/Bun: spaced prefix, reinstall, checksum rejection, preservation of the working command, and binary MCP handshake.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
