import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPackage } from './package.mjs';
import { renderInstall } from './render-install.mjs';

await test('release generation, version tags, and package-specific assets stay consistent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'family-release-test-'));

  try {
    for (const name of ['abler-mcp', 'infomentor-mcp']) {
      const root = join(directory, 'packages', name);
      await mkdir(join(root, 'docs'), { recursive: true });

      const manifest = {
        name,
        version: '9.8.7',
        packageManager: 'bun@1.4.2',
        familyMcp: { release: { tools: ['ping'], extraFiles: [] } },
      };

      await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
      const stale = `https://raw.githubusercontent.com/olafurns7/family-mcp/${name}@0.0.1/packages/${name}/install.sh\nhttps://github.com/olafurns7/family-mcp/releases/download/${name}@0.0.1/${name}-0.0.1.tgz\nCurrent ${name}@0.0.1 archive ${name}-0.0.1.tgz\n`;

      const docs = [
        'README.md',
        ...(name === 'abler-mcp'
          ? ['docs/AGENTS.md', 'docs/PUBLISHING.md']
          : ['docs/RELEASING.md']),
      ];

      for (const file of docs) await writeFile(join(root, file), stale);
      await writeFile(join(root, 'install.sh'), 'stale installer\n');
      const sync = fileURLToPath(new URL('./sync-version.mjs', import.meta.url));
      assert.equal(spawnSync(process.execPath, [sync, '--package', root, '--check']).status, 1);
      const result = spawnSync(process.execPath, [sync, '--package', root], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const generated = await renderInstall(await readPackage(root));
      assert.equal(await readFile(join(root, 'install.sh'), 'utf8'), generated);
      assert.ok(generated.endsWith('main "$@"\n'));
      assert.ok(generated.includes('tar -xOzf'));
      assert.ok(!generated.includes('tar -xzf'));
      assert.ok(generated.includes(`_VERSION:-9.8.7`));
      assert.equal(spawnSync('/bin/sh', ['-n'], { input: generated }).status, 0);

      for (const file of docs)
        assert.equal(await readFile(join(root, file), 'utf8'), stale.replaceAll('0.0.1', '9.8.7'));
      assert.equal(spawnSync(process.execPath, [sync, '--package', root, '--check']).status, 0);
      assert.equal(spawnSync(process.execPath, [sync, '--package', root]).status, 0);
      assert.equal(await readFile(join(root, 'install.sh'), 'utf8'), generated);
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          ...manifest,
          familyMcp: {
            release: {
              tools: ['ping'],
              extraFiles: [{ source: '../escape', destination: 'bin/extra', platform: 'linux' }],
            },
          },
        }),
      );
      await assert.rejects(readPackage(root), /Invalid input/);
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest));

      const workflow = await readFile(
        new URL('../../.github/workflows/release.yml', import.meta.url),
        'utf8',
      );

      const scripts = [
        ...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/g),
      ].map((match) => match[1]);

      assert.equal(scripts.length, 2);
      const output = join(directory, 'outputs');

      const env = {
        ...process.env,
        RELEASE_TAG: `${name}@9.8.7`,
        REF_TYPE: 'tag',
        GITHUB_OUTPUT: output,
      };

      const verify = spawnSync(process.execPath, ['--input-type=module'], {
        input: scripts[0],
        cwd: directory,
        env,
        encoding: 'utf8',
      });

      assert.equal(verify.status, 0, verify.stderr);
      assert.ok((await readFile(output, 'utf8')).includes(`package=${name}\nversion=9.8.7\n`));

      for (const badTag of ['other@9.8.7', `${name}@9.8.8`, `${name}@9.8.7;echo nope`]) {
        assert.notEqual(
          spawnSync(process.execPath, ['--input-type=module'], {
            input: scripts[0],
            cwd: directory,
            env: { ...env, RELEASE_TAG: badTag },
          }).status,
          0,
        );
      }

      assert.notEqual(
        spawnSync(process.execPath, ['--input-type=module'], {
          input: scripts[0],
          cwd: directory,
          env: { ...env, REF_TYPE: 'branch' },
        }).status,
        0,
      );
      const runner = join(directory, name);
      const artifacts = join(runner, 'release-artifacts');
      await mkdir(artifacts, { recursive: true });

      for (const packageName of ['abler-mcp', 'infomentor-mcp']) {
        const assets = [
          '.tgz',
          '-darwin-arm64.tar.gz',
          '-darwin-x64.tar.gz',
          '-linux-arm64.tar.gz',
          '-linux-x64.tar.gz',
        ].map((suffix) => `${packageName}-9.8.7${suffix}`);

        for (const file of assets) {
          const bytes = `synthetic ${file}`;
          await writeFile(join(artifacts, file), bytes);
          await writeFile(
            join(artifacts, file + '.sha256'),
            `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`,
          );
        }
      }

      const releaseEnv = {
        ...env,
        RUNNER_TEMP: runner,
        RELEASE_PACKAGE: name,
        RELEASE_VERSION: '9.8.7',
      };

      const selected = spawnSync(process.execPath, ['--input-type=module'], {
        input: scripts[1],
        cwd: directory,
        env: releaseEnv,
        encoding: 'utf8',
      });

      assert.equal(selected.status, 0, selected.stderr);
      const files = await readdir(join(runner, 'release-assets'));
      assert.equal(files.length, 11);
      assert.ok(files.every((file) => file === 'install.sh' || file.startsWith(`${name}-9.8.7`)));
      await rm(join(runner, 'release-assets'), { recursive: true });
      await writeFile(join(artifacts, `${name}-9.8.7.tgz`), 'corrupt');
      assert.notEqual(
        spawnSync(process.execPath, ['--input-type=module'], {
          input: scripts[1],
          cwd: directory,
          env: releaseEnv,
        }).status,
        0,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
