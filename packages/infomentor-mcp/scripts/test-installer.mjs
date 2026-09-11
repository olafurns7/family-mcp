import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  assert.notEqual(spawnSync('/bin/sh', [join(root, 'install.sh'), '--unknown'], { env }).status, 0);

  if (process.platform === 'linux' && process.arch === 'x64') {
    // Exercise the real installer/wrapper, replacing only administrator commands.
    const calls = join(directory, 'warp-admin-calls');
    await writeFile(
      join(fakeBin, 'sudo'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_WARP_CALLS"\ncat >/dev/null\n',
      { mode: 0o755 },
    );
    await writeFile(join(fakeBin, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
    const warpEnv = { ...env, TEST_WARP_CALLS: calls };
    execFileSync('/bin/sh', [join(root, 'install.sh'), '--with-warp'], {
      env: warpEnv,
      stdio: 'pipe',
    });
    assert.match(await readlink(binary), /\/infomentor-mcp-warp$/);
    assert.equal(
      (await readFile(join(prefix, 'share/infomentor-mcp/network'), 'utf8')).trim(),
      'warp',
    );
    execFileSync('/bin/sh', [join(root, 'install.sh')], { env: warpEnv, stdio: 'pipe' });
    assert.match(await readlink(binary), /\/infomentor-mcp-warp$/);
    execFileSync('/bin/sh', [join(root, 'install.sh'), '--without-warp'], {
      env: warpEnv,
      stdio: 'pipe',
    });
    assert.match(await readlink(binary), /\/bin\/infomentor-mcp$/);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
    assert.ok(
      (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .every((line) => line.includes('/infomentor-install.')),
    );

    const wrapperDirectory = join(directory, 'wrapper with spaces');
    await mkdir(wrapperDirectory);
    const wrapper = join(wrapperDirectory, 'infomentor-mcp-warp');
    await copyFile(join(root, 'scripts/warp-launcher.sh'), wrapper);
    await chmod(wrapper, 0o755);
    await writeFile(
      join(wrapperDirectory, 'infomentor-mcp'),
      '#!/bin/sh\nprintf "%s\\n" "$HTTPS_PROXY" "$https_proxy" "$NO_PROXY" "$no_proxy" "$@"\ncat\n',
      { mode: 0o755 },
    );

    const result = execFileSync(wrapper, ['serve', 'literal $(not-a-command)'], {
      env: { ...warpEnv, HTTPS_PROXY: 'https://old.invalid', NO_PROXY: '*', no_proxy: '*' },
      input: 'MCP initialization preserved\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    assert.deepEqual(result.trimEnd().split('\n'), [
      'http://127.0.0.1:18443',
      'http://127.0.0.1:18443',
      '',
      '',
      'serve',
      'literal $(not-a-command)',
      'MCP initialization preserved',
    ]);
  }

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
    assert.equal((await client.listTools()).tools.length, 11);
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
