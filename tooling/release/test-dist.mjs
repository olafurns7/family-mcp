import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readPackage } from './package.mjs';
import { smoke } from './mcp-smoke.mjs';

const { values } = parseArgs({ options: { package: { type: 'string' } } });

const pkg = await readPackage(values.package);

const directory = await mkdtemp(join(tmpdir(), `${pkg.name}-consumer-`));

const tarball = join(pkg.root, `${pkg.name}-${pkg.version}.tgz`);

/** @param {string} command @param {string[]} args */
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
  });

try {
  execFileSync('npm', ['pack', '--ignore-scripts'], { cwd: pkg.root, stdio: 'pipe' });

  const packed = z
    .array(z.object({ files: z.array(z.object({ path: z.string() })) }))
    .parse(JSON.parse(run('npm', ['pack', tarball, '--dry-run', '--json', '--ignore-scripts'])))[0];

  assert.ok(packed);
  assert.ok(packed.files.some(({ path }) => path === 'dist/cli.js'));
  const library = pkg.name === 'infomentor-mcp';

  if (library) assert.ok(packed.files.some(({ path }) => path === 'dist/index.d.ts'));

  for (const { path } of packed.files) {
    assert.match(
      path,
      library
        ? /^(?:dist\/|src\/|README\.md$|LICENSE$|package\.json$)/
        : /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/,
      `Unexpected packed file: ${path}`,
    );
    assert.ok(
      !/(?:session\.json|\.env|node_modules|\.auth)/.test(path),
      `Private file in package: ${path}`,
    );
  }

  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'family-mcp-consumer', private: true, type: 'module' }),
  );
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);

  const installed = z
    .object({ version: z.string(), scripts: z.record(z.string(), z.string()).optional() })
    .parse(
      JSON.parse(await readFile(join(directory, 'node_modules', pkg.name, 'package.json'), 'utf8')),
    );

  assert.equal(installed.version, pkg.version);
  assert.equal(installed.scripts?.install, undefined);
  assert.equal(installed.scripts?.postinstall, undefined);
  const bin = join(directory, 'node_modules/.bin', pkg.name);
  await smoke(bin, pkg.familyMcp.release.tools, pkg.version);

  if (library) {
    assert.match(run(bin, ['--help']), /--credentials/);
    await writeFile(
      join(directory, 'check.mjs'),
      `
      import assert from 'node:assert/strict';
      import { InfoMentorClient } from 'infomentor-mcp';
      const api = new InfoMentorClient({ sessionFile: new URL('./missing.json', import.meta.url).pathname });
      assert.equal(api.getSetupStatus().state, 'idle');
      assert.equal((await api.getSessionStatus()).authenticated, false);
      await api.close();
    `,
    );
    run(process.execPath, ['check.mjs']);
    await writeFile(
      join(directory, 'check.ts'),
      `
    import { InfoMentorClient, loginRequestSchema } from 'infomentor-mcp';
    import type { SessionOptions, Overview, SetupStatus, LoginRequest, SelectChildRequest, CollectRequest, Collection, Messages, Message, Notifications } from 'infomentor-mcp';
    const options: SessionOptions = { sessionFile: '/tmp/infomentor-consumer-session.json' };
    const client = new InfoMentorClient(options);
    const request: LoginRequest = { timeoutSeconds: 300 };
    const status: SetupStatus = client.startLogin(loginRequestSchema.parse(request));
    const overview: Promise<Overview> = client.getOverview();
    const childRequest: SelectChildRequest = { childId: 'child-from-overview' };
    const selected: Promise<Overview> = client.selectChild(childRequest);
    const collectionRequest: CollectRequest = { includeExisting: true };
    const collection: Promise<Collection> = client.collectUpdates(collectionRequest);
    void collection;
    const messages: Promise<Messages> = client.getMessages({ folder: 'inbox', page: 1 });
    const message: Promise<Message> = client.getMessage({ id: 1 });
    const notifications: Promise<Notifications> = client.getNotifications();
    void [status, overview, selected, messages, message, notifications, client.logout(), client.cancelSetup()];
  `,
    );
    run(process.execPath, [
      fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json'))),
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
  }

  run('npm', ['publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public']);

  const digest = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');

  await writeFile(`${tarball}.sha256`, `${digest}  ${pkg.name}-${pkg.version}.tgz\n`);
  console.log(
    `${pkg.name}: package allowlist, isolated installation, MCP smoke, consumer types (when exported), and publication dry-run passed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
