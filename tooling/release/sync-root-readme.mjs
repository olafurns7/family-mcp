import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PACKAGE_NAMES, readPackage } from './package.mjs';

const { values } = parseArgs({ options: { check: { type: 'boolean' } } });

const root = process.cwd();

const file = join(root, 'README.md');

const packages = await Promise.all(
  PACKAGE_NAMES.map((name) => readPackage(join(root, 'packages', name))),
);

let output = await readFile(file, 'utf8');

for (const pkg of packages) {
  const tag = `${pkg.name}@${pkg.version}`;

  const installUrlPattern = new RegExp(
    `https://raw\\.githubusercontent\\.com/olafurns7/family-mcp/${pkg.name}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?/packages/${pkg.name}/install\\.sh`,
    'g',
  );

  output = output.replaceAll(
    installUrlPattern,
    `https://raw.githubusercontent.com/olafurns7/family-mcp/${tag}/packages/${pkg.name}/install.sh`,
  );
}

if (values.check)
  assert.equal(
    await readFile(file, 'utf8'),
    output,
    'Run release:sync to update root README pins.',
  );
else await writeFile(file, output);

console.log(`root README pins ${values.check ? 'checked' : 'synchronized'}.`);
