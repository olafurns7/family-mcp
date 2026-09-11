import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { version, packageManager } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

assert.ok(
  ['darwin', 'linux'].includes(process.platform),
  'Binary releases support macOS and Linux.',
);

assert.ok(['arm64', 'x64'].includes(process.arch), 'Binary releases support arm64 and x64.');

const bunVersion = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();

assert.equal(`bun@${bunVersion}`, packageManager, 'Use the pinned Bun version to build releases.');

const directory = await mkdtemp(join(tmpdir(), 'infomentor-binary-'));

const payload = join(directory, 'infomentor-mcp');

const output = join(root, 'release');

try {
  await mkdir(join(payload, 'bin'), { recursive: true });
  const binary = join(payload, 'bin/infomentor-mcp');
  const metadata = join(directory, 'bundle.json');
  execFileSync(
    'bun',
    [
      'build',
      'src/cli.ts',
      '--compile',
      '--minify',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      `--metafile=${metadata}`,
      '--outfile',
      binary,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  assert.equal(
    execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    }).trim(),
    version,
  );
  await copyFile(join(root, 'LICENSE'), join(payload, 'LICENSE'));
  await copyFile(join(root, 'README.md'), join(payload, 'README.md'));
  // Include license notices for the actual bundled packages, not every development dependency.
  const build = JSON.parse(await readFile(metadata, 'utf8'));
  const packages = new Set();

  for (const input of Object.keys(build.inputs)) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);

    if (match) packages.add(match[1]);
  }

  const notices = [await readFile(join(root, 'licenses/Bun.txt'), 'utf8')];

  for (const name of [...packages].toSorted()) {
    const packageRoot = join(root, 'node_modules', name);

    const licenses = (await readdir(packageRoot)).filter((file) =>
      /^(?:licen[sc]e|notice|copying)(?:\.|$)/i.test(file),
    );

    assert.ok(licenses.length > 0, `Missing bundled license: ${name}`);

    for (const file of licenses)
      notices.push(
        `\n\n--- ${name}/${file} ---\n\n` + (await readFile(join(packageRoot, file), 'utf8')),
      );
  }

  await writeFile(join(payload, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
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
  console.log(`Built ${name}: a single executable with Bun ${bunVersion} embedded.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
