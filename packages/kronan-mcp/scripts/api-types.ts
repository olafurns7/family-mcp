// Maintains api/kronan-api.d.ts from api/openapi.json without loading a TypeScript compiler at check time.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const specification = join(root, 'api', 'openapi.json');

const types = join(root, 'api', 'kronan-api.d.ts');

const digestFile = join(root, 'api', 'openapi.sha256');

async function digest(): Promise<string> {
  return createHash('sha256')
    .update(await readFile(specification))
    .digest('hex');
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (command === 'generate') {
    // openapi-typescript needs the TypeScript 5 compiler API, which the workspace's TypeScript 7 lacks;
    // npx installs both into an isolated sandbox so the workspace never carries the old compiler.
    execFileSync(
      'npx',
      [
        '--yes',
        '--package=typescript@5.9.3',
        '--package=openapi-typescript@7.13.0',
        'openapi-typescript',
        specification,
        '-o',
        types,
      ],
      { cwd: root, stdio: 'inherit' },
    );
    await writeFile(digestFile, `${await digest()}  api/openapi.json\n`);
    process.stdout.write('Generated api/kronan-api.d.ts and recorded the specification digest.\n');

    return;
  }

  if (command !== 'check') throw new Error('Usage: bun scripts/api-types.ts generate|check');
  const recorded = (await readFile(digestFile, 'utf8')).split(/\s+/)[0];

  if (recorded !== (await digest()))
    throw new Error(
      'api/openapi.json changed since api/kronan-api.d.ts was generated. Run bun run api:generate.',
    );

  if (!(await readFile(types, 'utf8')).includes('export interface components'))
    throw new Error('api/kronan-api.d.ts is missing or incomplete. Run bun run api:generate.');
  process.stdout.write('api/kronan-api.d.ts matches the vendored specification digest.\n');
}

await main();
