import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

assert.ok(
  ['darwin', 'linux'].includes(process.platform),
  'Binary releases support macOS and Linux.',
);

assert.ok(['arm64', 'x64'].includes(process.arch), 'Binary releases support arm64 and x64.');

const tarball = join(root, `infomentor-mcp-${version}.tgz`);

const directory = await mkdtemp(join(tmpdir(), 'infomentor-binary-'));

const payload = join(directory, 'infomentor-mcp');

const output = join(root, 'release');

try {
  await mkdir(join(payload, 'runtime/bin'), { recursive: true });
  await mkdir(join(payload, 'bin'));
  await writeFile(
    join(payload, 'package.json'),
    JSON.stringify({ private: true, name: 'infomentor-runtime' }),
  );
  execFileSync(
    'npm',
    ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: payload, stdio: 'pipe' },
  );
  await copyFile(process.execPath, join(payload, 'runtime/bin/node'));
  // Official Node distributions include their full third-party license notices.
  await copyFile(
    resolve(dirname(process.execPath), '../LICENSE'),
    join(payload, 'runtime/LICENSE'),
  );
  await chmod(join(payload, 'runtime/bin/node'), 0o755);
  await copyFile(join(root, 'LICENSE'), join(payload, 'LICENSE'));
  await copyFile(join(root, 'README.md'), join(payload, 'README.md'));
  await writeFile(
    join(payload, 'bin/infomentor-mcp'),
    `#!/bin/sh
set -eu
script=$0
if [ -L "$script" ]; then script=$(readlink "$script"); fi
root=$(CDPATH= cd "$(dirname "$script")/.." && pwd)
exec "$root/runtime/bin/node" "$root/node_modules/infomentor-mcp/dist/cli.js" "$@"
`,
    { mode: 0o755 },
  );
  assert.equal(
    execFileSync(join(payload, 'bin/infomentor-mcp'), ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    }).trim(),
    version,
  );
  await mkdir(output, { recursive: true });
  const name = `infomentor-mcp-${version}-${process.platform}-${process.arch}.tar.gz`;
  const archive = join(output, name);
  execFileSync('tar', ['-czf', archive, '-C', directory, 'infomentor-mcp'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });

  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');

  await writeFile(archive + '.sha256', `${digest}  ${name}\n`);
  console.log(`Built ${name} with ${process.version} bundled. No system Node or Bun is needed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
