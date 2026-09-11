import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readPackage } from './package.mjs';

const { values } = parseArgs({ options: { package: { type: 'string' } } });

const pkg = await readPackage(values.package);

const bunVersion = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();

assert.equal(
  `bun@${bunVersion}`,
  pkg.packageManager,
  'Use the pinned Bun version to build releases.',
);

assert.ok(['darwin', 'linux'].includes(process.platform), 'Supported systems: macOS and Linux.');

assert.ok(['arm64', 'x64'].includes(process.arch), 'Supported CPUs: arm64 and x64.');

const directory = await mkdtemp(join(tmpdir(), `${pkg.name}-binary-`));

const payload = join(directory, pkg.name);

const output = join(pkg.root, 'release');

try {
  await mkdir(join(payload, 'bin'), { recursive: true });
  const binary = join(payload, 'bin', pkg.name);
  const metadata = join(directory, 'bundle.json');
  execFileSync(
    'bun',
    [
      'build',
      'src/cli.ts',
      '--compile',
      '--target',
      `bun-${process.platform}-${process.arch}`,
      '--minify',
      '--sourcemap',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      `--metafile=${metadata}`,
      '--outfile',
      binary,
    ],
    { cwd: pkg.root, stdio: 'inherit' },
  );
  assert.equal(
    execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    }).trim(),
    pkg.version,
  );

  for (const file of ['LICENSE', 'README.md'])
    await copyFile(join(pkg.root, file), join(payload, file));

  for (const file of pkg.familyMcp.release.extraFiles) {
    if (file.platform !== process.platform) continue;
    const destination = join(payload, file.destination);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(pkg.root, file.source), destination);

    if (file.executable) await chmod(destination, 0o755);
  }

  const build = z
    .object({ inputs: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(await readFile(metadata, 'utf8')));

  /** @type {Set<string>} */
  const dependencies = new Set();

  for (const input of Object.keys(build.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(input);

    if (match?.[1]) dependencies.add(resolve(pkg.root, match[1]));
  }

  assert.ok(dependencies.size > 0, 'Expected dependency inputs in Bun metafile.');
  const notices = [await readFile(new URL('./Bun.txt', import.meta.url), 'utf8')];

  for (const packageRoot of [...dependencies].toSorted((a, b) => a.localeCompare(b))) {
    const { name } = z
      .object({ name: z.string() })
      .parse(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));

    const licenses = (await readdir(packageRoot)).filter((file) =>
      /^(?:licen[sc]e|notice|copying)(?:\.|$)/i.test(file),
    );

    assert.ok(licenses.length > 0, `Missing bundled license: ${name}`);

    for (const file of licenses)
      notices.push(
        `\n\n--- ${name}/${file} ---\n\n${await readFile(join(packageRoot, file), 'utf8')}`,
      );
  }

  await writeFile(join(payload, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
  await mkdir(output, { recursive: true });
  const filename = `${pkg.name}-${pkg.version}-${process.platform}-${process.arch}.tar.gz`;
  const archive = join(output, filename);
  execFileSync('tar', ['-czf', archive, '-C', directory, pkg.name], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });

  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');

  await writeFile(`${archive}.sha256`, `${digest}  ${filename}\n`);
  await mkdir(join(output, 'native'), { recursive: true });
  await copyFile(binary, join(output, 'native', pkg.name));
  console.log(
    `Built ${filename} with Bun ${bunVersion}; generated notices for ${dependencies.size} bundled dependencies.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
