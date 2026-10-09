// packages/kronan-mcp/test/startup.test.ts against the Rust binary, run by tests/typescript.rs from
// packages/kronan-mcp. Changed only to start KRONAN_RUST_BINARY; each other change is marked `Rust:`.
import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rustBinary = process.env.KRONAN_RUST_BINARY!;

const E3 = 'Other users can open this store folder.';

/** Run the CLI against a scratch store (through the store test seam); stdin is closed. */
async function run(home: string, args: string[]) {
  const child = Bun.spawn([rustBinary, ...args], {
    env: {
      ...process.env,
      FAMILY_MCP_STORE_TEST_SEAM: '1',
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });

  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, status };
}

test('the CLI refuses to start on an unsafe store and touches nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kronan-mcp-startup-'));

  try {
    for (const directory of [
      join(home, 'config', 'kronan-mcp'),
      join(home, 'data', 'family-mcp', 'keys'),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o755);

      for (const args of [['serve'], ['auth', 'logout']]) {
        const result = await run(home, args);
        expect(result).toEqual({
          stdout: '',
          stderr: `kronan-mcp: cannot start. ${E3}\n  Path: '${directory}'\n  Fix:  chmod 700 '${directory}'\n`,
          status: 1,
        });
        expect(await readdir(directory)).toEqual([]);
      }

      // Help and version never touch the store.
      for (const flag of ['--help', '--version']) expect((await run(home, [flag])).status).toBe(0);
      await chmod(directory, 0o700);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

// Rust: the macOS transition case runs `auth migrate`, which this binary gains with its token
// commands; it is added then.
