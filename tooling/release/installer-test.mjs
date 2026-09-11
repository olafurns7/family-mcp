import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readPackage } from './package.mjs';
import { smoke } from './mcp-smoke.mjs';

const { values } = parseArgs({
  options: { package: { type: 'string' }, mode: { type: 'string', default: 'both' } },
});

const pkg = await readPackage(values.package);

assert.ok(['fake', 'real', 'both'].includes(values.mode), 'Use --mode fake|real|both.');

const script = await readFile(join(pkg.root, 'install.sh'), 'utf8');

const directory = await mkdtemp(join(tmpdir(), `${pkg.name}-installer-`));

const fakeBin = join(directory, 'commands');

const temporary = join(directory, 'temporary files');

const prefix = join(directory, 'prefix with spaces');

const binary = join(prefix, 'bin', pkg.name);

const env = {
  ...process.env,
  PATH: `${fakeBin}:/usr/bin:/bin`,
  TMPDIR: temporary,
  TEST_ASSETS: directory,
  TEST_FAILURE: '',
  [pkg.envPrefix + '_PREFIX']: prefix,
  [pkg.envPrefix + '_VERSION']: pkg.version,
};

try {
  await mkdir(fakeBin);
  await mkdir(temporary);
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await writeFile(
    join(fakeBin, 'curl'),
    `#!/bin/sh
set -eu
[ "$TEST_FAILURE" != download ] || exit 22
while [ "$#" -gt 0 ]; do
  case "$1" in https://github.com/olafurns7/family-mcp/releases/download/${pkg.name}@${pkg.version}/*) url=$1 ;; -o) shift; output=$1 ;; esac
  shift
done
cp "$TEST_ASSETS/\${url##*/}" "$output"
`,
    { mode: 0o755 },
  );

  if (values.mode !== 'real') {
    await writeFile(
      join(fakeBin, 'uname'),
      `#!/bin/sh
case "$1:$TEST_FAILURE" in
  -s:platform) printf 'Unsupported\\n' ;;
  -m:arch) printf 'Unsupported\\n' ;;
  -s:*) printf 'Linux\\n' ;;
  -m:*) printf 'x86_64\\n' ;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(fakeBin, 'mv'),
      '#!/bin/sh\n[ "$TEST_FAILURE" != install ] || exit 17\nexec /bin/mv "$@"\n',
      { mode: 0o755 },
    );
    const payload = join(directory, pkg.name);
    await mkdir(join(payload, 'bin'), { recursive: true });

    for (const file of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.txt'])
      await writeFile(join(payload, file), `synthetic ${file}`);

    for (const file of pkg.familyMcp.release.extraFiles) {
      const path = join(payload, file.destination);
      await mkdir(join(path, '..'), { recursive: true });
      await copyFile(join(pkg.root, file.source), path);
    }

    const archive = `${pkg.name}-${pkg.version}-linux-x64.tar.gz`;

    for (const failure of [
      'checksum',
      'filename',
      'download',
      'missing',
      'prefix',
      'platform',
      'arch',
      'version',
      'archive',
      'install',
      'directory',
      'none',
    ]) {
      await writeFile(binary, 'previous installation');

      if (failure === 'directory') {
        await rm(binary);
        await mkdir(binary);
      }

      await writeFile(
        join(payload, 'bin', pkg.name),
        `#!/bin/sh\nprintf '${failure === 'version' ? 'wrong' : pkg.version}\\n'\n`,
      );
      execFileSync('tar', ['-czf', join(directory, archive), '-C', directory, pkg.name]);

      if (failure === 'archive') await writeFile(join(directory, archive), 'not an archive');

      const digest = createHash('sha256')
        .update(await readFile(join(directory, archive)))
        .digest('hex');

      await writeFile(
        join(directory, archive + '.sha256'),
        `${failure === 'checksum' ? '0'.repeat(64) : digest}  ${failure === 'filename' ? 'wrong.tar.gz' : archive}\n`,
      );

      const result = spawnSync('/bin/sh', [], {
        input: script,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...env,
          PATH: failure === 'missing' ? temporary : env.PATH,
          TEST_FAILURE: failure,
          [pkg.envPrefix + '_PREFIX']: failure === 'prefix' ? 'relative/path' : prefix,
        },
      });

      assert.equal(result.status === 0, failure === 'none', `${failure}: ${result.stderr}`);
      assert.deepEqual(await readdir(temporary), [], `Temporary downloads leaked: ${failure}`);
      assert.deepEqual(await readdir(join(prefix, 'bin')), [pkg.name]);

      if (['checksum', 'filename'].includes(failure))
        assert.match(result.stderr, /checksum verification failed/);

      if (failure === 'version') assert.match(result.stderr, /unexpected version/);

      if (failure === 'missing') assert.match(result.stderr, /Required command missing/);

      if (failure === 'prefix') assert.match(result.stderr, /absolute path/);

      if (failure === 'platform') assert.match(result.stderr, /Supported systems/);

      if (failure === 'arch') assert.match(result.stderr, /Supported CPUs/);

      if (failure === 'directory') {
        assert.match(result.stderr, /destination is a directory/);
        assert.deepEqual(await readdir(binary), []);
        await rm(binary, { recursive: true });
      } else if (failure === 'none') {
        assert.match(result.stdout, new RegExp(`Installed ${pkg.name}`));
        assert.ok(result.stdout.includes(prefix));
        assert.equal(
          await readFile(join(await readlink(binary), '../../LICENSE'), 'utf8'),
          'synthetic LICENSE',
        );
        assert.equal(
          await readFile(binary, 'utf8'),
          await readFile(join(payload, 'bin', pkg.name), 'utf8'),
        );
      } else
        assert.equal(
          await readFile(binary, 'utf8'),
          'previous installation',
          `Previous install damaged: ${failure}`,
        );
    }

    // A piped truncation must not begin installation before the final main invocation.
    const truncated = spawnSync('/bin/sh', [], {
      input: script.slice(0, script.lastIndexOf('main "$@"')),
      env,
      encoding: 'utf8',
    });

    assert.equal(truncated.status, 0);
    assert.deepEqual(await readdir(temporary), []);
    await rm(join(fakeBin, 'uname'));
    await rm(join(fakeBin, 'mv'));
    await rm(prefix, { recursive: true });
    console.log(`${pkg.name}: all 12 piped-installer cases and truncated-script check passed.`);
  }

  if (values.mode !== 'fake') {
    const archive = `${pkg.name}-${pkg.version}-${process.platform}-${process.arch}.tar.gz`;

    for (const suffix of ['', '.sha256'])
      await copyFile(
        join(pkg.root, 'release', archive + suffix),
        join(directory, archive + suffix),
      );
    execFileSync('/bin/sh', [], { input: script, env, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(
      execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(),
      pkg.version,
    );
    assert.notEqual(
      spawnSync('/bin/sh', [join(pkg.root, 'install.sh'), '--unknown'], { env }).status,
      0,
    );

    if (pkg.name === 'infomentor-mcp' && process.platform === 'linux' && process.arch === 'x64') {
      // Exercise the real installer/wrapper, replacing only administrator commands.
      const calls = join(directory, 'warp-admin-calls');
      await writeFile(
        join(fakeBin, 'sudo'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_WARP_CALLS"\ncat >/dev/null\n',
        { mode: 0o755 },
      );
      await writeFile(join(fakeBin, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
      const warpEnv = { ...env, TEST_WARP_CALLS: calls };
      execFileSync('/bin/sh', [join(pkg.root, 'install.sh'), '--with-warp'], {
        env: warpEnv,
        stdio: 'pipe',
      });
      assert.match(await readlink(binary), /\/infomentor-mcp-warp$/);
      assert.equal(
        (await readFile(join(prefix, 'share/infomentor-mcp/network'), 'utf8')).trim(),
        'warp',
      );
      execFileSync('/bin/sh', [join(pkg.root, 'install.sh')], { env: warpEnv, stdio: 'pipe' });
      assert.match(await readlink(binary), /\/infomentor-mcp-warp$/);
      execFileSync('/bin/sh', [join(pkg.root, 'install.sh'), '--without-warp'], {
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
      await copyFile(join(pkg.root, 'scripts/warp-launcher.sh'), wrapper);
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

    execFileSync('/bin/sh', [], { input: script, env, stdio: ['pipe', 'pipe', 'pipe'] });
    await writeFile(join(directory, archive + '.sha256'), `${'0'.repeat(64)}  ${archive}\n`);
    assert.notEqual(spawnSync('/bin/sh', [], { input: script, env }).status, 0);
    assert.equal(
      execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim(),
      pkg.version,
    );
    await smoke(binary, pkg.familyMcp.release.tools, pkg.version, true);
    console.log(
      `${pkg.name}: real archive installation, spaced prefix, reinstall, checksum rejection, previous-command preservation, and MCP smoke passed.`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
