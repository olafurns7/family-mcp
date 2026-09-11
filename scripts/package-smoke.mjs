import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const tarball = resolve(process.argv[2] ?? join(root, `infomentor-mcp-${manifest.version}.tgz`));

const directory = await mkdtemp(join(tmpdir(), 'infomentor-package-'));

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
  });

try {
  const [packed] = JSON.parse(
    run('npm', ['pack', tarball, '--dry-run', '--json', '--ignore-scripts']),
  );

  assert.ok(packed.files.some(({ path }) => path === 'dist/cli.js'));
  assert.ok(packed.files.some(({ path }) => path === 'dist/index.d.ts'));

  for (const { path } of packed.files) {
    assert.match(
      path,
      /^(?:dist\/|src\/|README\.md$|LICENSE$|package\.json$)/,
      `Unexpected packed file: ${path}`,
    );
    assert.ok(
      !/(?:session\.json|\.env|node_modules|\.auth)/.test(path),
      `Private file in package: ${path}`,
    );
  }

  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'infomentor-consumer', private: true, type: 'module' }),
  );
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);

  const installed = JSON.parse(
    await readFile(join(directory, 'node_modules/infomentor-mcp/package.json'), 'utf8'),
  );

  assert.equal(installed.version, manifest.version);
  assert.equal(installed.scripts?.install, undefined);
  assert.equal(installed.scripts?.postinstall, undefined);
  const bin = join(directory, 'node_modules/.bin/infomentor-mcp');
  assert.equal(run(bin, ['--version']).trim(), manifest.version);
  assert.match(run(bin, ['--help']), /--credentials/);
  await writeFile(
    join(directory, 'check.mjs'),
    `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
    import { InfoMentorClient, setupStatusSchema } from 'infomentor-mcp';
    const api = new InfoMentorClient({ sessionFile: new URL('./missing.json', import.meta.url).pathname });
    assert.equal(api.getSetupStatus().state, 'idle');
    assert.equal((await api.getSessionStatus()).authenticated, false);
    await api.close();
    const client = new Client({ name: 'packed-consumer', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['node_modules/infomentor-mcp/dist/cli.js', '--session', new URL('./missing.json', import.meta.url).pathname], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += chunk; });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 6);
      assert.ok(tools.every((tool) => tool.outputSchema));
      const status = await client.callTool({ name: 'infomentor_setup_status', arguments: {} });
      assert.equal(setupStatusSchema.parse(status.structuredContent).state, 'idle');
    } finally { await client.close(); }
    assert.equal(stderr, '');
  `,
  );
  run(process.execPath, ['check.mjs']);
  await writeFile(
    join(directory, 'check.ts'),
    `
    import { InfoMentorClient, loginRequestSchema } from 'infomentor-mcp';
    import type { SessionOptions, Overview, SetupStatus, LoginRequest } from 'infomentor-mcp';
    const options: SessionOptions = { sessionFile: '/tmp/infomentor-consumer-session.json' };
    const client = new InfoMentorClient(options);
    const request: LoginRequest = { timeoutSeconds: 300 };
    const status: SetupStatus = client.startLogin(loginRequestSchema.parse(request));
    const overview: Promise<Overview> = client.getOverview();
    void [status, overview, client.logout(), client.cancelSetup()];
  `,
  );
  run(process.execPath, [
    join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--noUncheckedIndexedAccess',
    '--exactOptionalPropertyTypes',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--target',
    'ES2023',
    '--lib',
    'ES2023,DOM',
    'check.ts',
  ]);
  run('npm', ['publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public']);

  const digest = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');

  await writeFile(tarball + '.sha256', `${digest}  ${tarball.split(/[\\/]/).at(-1)}\n`);
  console.log(
    'Prebuilt package passed: contents, npm installation without build scripts, executable CLI, MCP handshake, strict consumer types, and npm publication dry-run.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
