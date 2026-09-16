import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readPackage } from './package.mjs';
import { z } from 'zod';

/**
 * @param {string} bin
 * @param {string[]} expectedTools
 * @param {string | undefined} version
 * @param {boolean} standalone
 * @param {string} packageName Selects the package-specific missing-auth assertions.
 */
export async function smoke(bin, expectedTools, version, standalone, packageName) {
  assert.ok(
    ['abler-mcp', 'infomentor-mcp', 'kronan-mcp'].includes(packageName),
    'Unknown package.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'family-mcp-smoke-'));
  const client = new Client({ name: 'family-mcp-smoke', version: '1.0.0' });
  let stderr = '';

  try {
    const executable = standalone ? join(directory, 'standalone') : resolve(bin);

    if (standalone) {
      await copyFile(bin, executable);
      await chmod(executable, 0o755);
      await writeFile(join(directory, '.env'), 'BUN_OPTIONS="--preload ./missing.ts"\n');
      await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./missing.ts"]\n');
    } else await symlink(process.execPath, join(directory, 'node'));

    const env = {
      PATH: directory,
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      ABLER_SESSION_FILE: join(directory, 'missing.json'),
      INFOMENTOR_SESSION_PATH: join(directory, 'missing.json'),
      KRONAN_TOKEN_FILE: join(directory, 'missing.json'),
    };

    const actualVersion = execFileSync(executable, ['--version'], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    }).trim();

    if (version) assert.equal(actualVersion, version);
    assert.match(
      execFileSync(executable, ['--help'], {
        cwd: directory,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      }),
      /stdio MCP server/,
    );

    const transport = new StdioClientTransport({
      command: executable,
      cwd: directory,
      env,
      stderr: 'pipe',
    });

    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, actualVersion);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).toSorted(), [...expectedTools].toSorted());
    assert.ok(tools.every((tool) => tool.outputSchema));

    if (packageName === 'abler-mcp') {
      const status = await client.callTool({ name: 'auth_status', arguments: {} });
      assert.equal(status.isError, true);
      assert.match(JSON.stringify(status), /No saved Abler session/);
      assert.equal(
        (
          await client.callTool({
            name: 'list_child_schedules',
            arguments: { childId: 'misspelled' },
          })
        ).isError,
        true,
      );
    }

    if (packageName === 'kronan-mcp') {
      assert.ok(tools.every((tool) => tool.outputSchema));
      const status = await client.callTool({ name: 'auth_status', arguments: {} });
      assert.equal(status.isError, true);
      assert.match(JSON.stringify(status), /No saved Krónan access token/);
      assert.equal(
        (
          await client.callTool({
            name: 'get_product',
            arguments: { sku: 'x', barcode: '12345' },
          })
        ).isError,
        true,
      );
    }

    if (packageName === 'infomentor-mcp') {
      assert.ok(tools.every((tool) => tool.outputSchema));
      const status = await client.callTool({ name: 'infomentor_session_status', arguments: {} });
      z.object({ authenticated: z.literal(false) }).parse(status.structuredContent);

      if (expectedTools.includes('infomentor_setup_status')) {
        const setup = await client.callTool({ name: 'infomentor_setup_status', arguments: {} });
        z.object({ state: z.literal('idle') }).parse(setup.structuredContent);
      }

      const error = await client.callTool({ name: 'infomentor_get_overview', arguments: {} });
      assert.equal(error.isError, true);
      assert.equal(error.structuredContent, undefined);
    }
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }

  assert.equal(stderr, '');
  console.log(
    `MCP smoke passed: ${expectedTools.length} tools, ${standalone ? 'standalone' : 'Node'} executable, version/help, missing authentication, and clean protocol.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      package: { type: 'string' },
      bin: { type: 'string' },
      'expect-tools': { type: 'string', multiple: true },
      standalone: { type: 'boolean' },
    },
  });

  assert.ok(values.bin, 'Use --bin <executable>.');
  assert.ok(values.package, 'Use --package <directory>.');
  const pkg = await readPackage(values.package);

  const expected = values['expect-tools']
    ? [...values['expect-tools'], ...positionals]
    : pkg.familyMcp.release.tools;

  assert.ok(expected.length, 'Use --expect-tools <names...> or the package tool list.');
  await smoke(resolve(values.bin), expected, pkg.version, values.standalone ?? false, pkg.name);
}
