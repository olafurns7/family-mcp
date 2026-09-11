import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VERSION } from '../src/server.js';

test('piped installer validates releases and keeps previous installs on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'abler-installer-test-'));
  const bin = join(directory, 'commands');
  const temporary = join(directory, 'temporary files');
  const prefix = join(directory, 'install with spaces');
  const archive = `abler-mcp-${VERSION}-linux-x64.tar.gz`;
  try {
    await mkdir(bin);
    await mkdir(temporary);
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(join(directory, 'LICENSE'), 'synthetic license');
    await writeFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), 'synthetic notices');
    await writeFile(
      join(bin, 'curl'),
      `#!/bin/sh
set -eu
[ "$ABLER_TEST_FAILURE" != download ] || exit 22
source=
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://github.com/olafurns7/abler-mcp/releases/download/v${VERSION}/${archive}) source="$ABLER_TEST_FIXTURES/archive" ;;
    https://github.com/olafurns7/abler-mcp/releases/download/v${VERSION}/${archive}.sha256) source="$ABLER_TEST_FIXTURES/checksums" ;;
    -o) shift; destination=$1 ;;
  esac
  shift
done
[ -n "$source" ] && [ -n "$destination" ]
cp "$source" "$destination"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, 'uname'),
      `#!/bin/sh
case "$1:$ABLER_TEST_FAILURE" in
  -s:platform) printf 'Unsupported\\n' ;;
  -m:arch) printf 'Unsupported\\n' ;;
  -s:*) printf 'Linux\\n' ;;
  -m:*) printf 'x86_64\\n' ;;
esac
`,
      { mode: 0o755 },
    );
    const move = Bun.which('mv');
    assert(move);
    await writeFile(
      join(bin, 'mv'),
      `#!/bin/sh\n[ "$ABLER_TEST_FAILURE" != install ] || exit 17\nexec "${move}" "$@"\n`,
      { mode: 0o755 },
    );
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
      await writeFile(join(prefix, 'bin', 'abler-mcp'), 'previous installation');
      if (failure === 'directory') {
        await rm(join(prefix, 'bin', 'abler-mcp'));
        await mkdir(join(prefix, 'bin', 'abler-mcp'));
      }
      await writeFile(
        join(directory, 'abler-mcp'),
        `#!/bin/sh\nprintf '${failure === 'version' ? 'wrong' : VERSION}\\n'\n`,
      );
      const pack = Bun.spawn(
        [
          'tar',
          '-czf',
          join(directory, 'archive'),
          '-C',
          directory,
          'abler-mcp',
          'LICENSE',
          'THIRD_PARTY_NOTICES.txt',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      assert.equal(await pack.exited, 0);
      if (failure === 'archive') await writeFile(join(directory, 'archive'), 'not an archive');
      const digest = createHash('sha256')
        .update(await readFile(join(directory, 'archive')))
        .digest('hex');
      const checksums = `${failure === 'checksum' ? '0'.repeat(64) : digest}  ${failure === 'filename' ? 'wrong.tar.gz' : archive}\n`;
      await writeFile(join(directory, 'checksums'), checksums);
      const child = Bun.spawn(['/bin/sh'], {
        stdin: Bun.file('install.sh'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          PATH: failure === 'missing' ? temporary : `${bin}:/usr/bin:/bin`,
          TMPDIR: temporary,
          ABLER_PREFIX: failure === 'prefix' ? 'relative/path' : prefix,
          ABLER_TEST_FIXTURES: directory,
          ABLER_TEST_FAILURE: failure,
        },
      });
      const exit = await child.exited;
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      assert.equal(exit === 0, failure === 'none', `${failure}: ${error}`);
      assert.deepEqual(await readdir(temporary), [], `Temporary downloads leaked: ${failure}`);
      assert.deepEqual(await readdir(join(prefix, 'bin')), ['abler-mcp']);
      if (['checksum', 'filename'].includes(failure))
        assert.match(error, /checksum verification failed/);
      if (failure === 'version') assert.match(error, /unexpected version/);
      if (failure === 'missing') assert.match(error, /Required command missing/);
      if (failure === 'prefix') assert.match(error, /absolute path/);
      if (failure === 'platform') assert.match(error, /Supported systems/);
      if (failure === 'arch') assert.match(error, /Supported CPUs/);
      if (failure === 'directory') {
        assert.match(error, /destination is a directory/);
        assert.deepEqual(await readdir(join(prefix, 'bin', 'abler-mcp')), []);
        await rm(join(prefix, 'bin', 'abler-mcp'), { recursive: true });
        continue;
      }
      if (failure === 'none') {
        assert.match(output, /Installed abler-mcp/);
        assert(output.includes(prefix));
        assert.equal(
          await readFile(join(prefix, 'share', 'abler-mcp', 'LICENSE'), 'utf8'),
          'synthetic license',
        );
        assert.equal(
          await readFile(join(prefix, 'bin', 'abler-mcp'), 'utf8'),
          await readFile(join(directory, 'abler-mcp'), 'utf8'),
        );
      } else {
        assert.equal(
          await readFile(join(prefix, 'bin', 'abler-mcp'), 'utf8'),
          'previous installation',
          `Previous install damaged: ${failure}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
