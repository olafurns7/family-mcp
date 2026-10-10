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

// Every crate shares rust/Cargo.lock, so its entries are written here, once, before the package
// release:sync tasks run in parallel. Each crate follows its package.json version.
const crates = packages.filter((pkg) => pkg.familyMcp.release.rust);

const lockFile = join(root, 'rust', 'Cargo.lock');

const lockBefore = crates.length ? await readFile(lockFile, 'utf8') : '';

let lock = lockBefore;

for (const pkg of crates) {
  const crate = pkg.familyMcp.release.rust;

  const entry = new RegExp(
    `^(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]+(")$`,
    'm',
  );

  assert.match(lock, entry, `No ${crate} entry in rust/Cargo.lock`);
  lock = lock.replace(entry, `$1${pkg.version}$2`);
}

if (values.check) {
  assert.equal(
    await readFile(file, 'utf8'),
    output,
    'Run release:sync to update root README pins.',
  );
  assert.equal(
    lockBefore,
    lock,
    'Run release:sync to update the crate versions in rust/Cargo.lock.',
  );
} else {
  await writeFile(file, output);

  if (crates.length) await writeFile(lockFile, lock);
}

console.log(
  `root README pins and crate lock versions ${values.check ? 'checked' : 'synchronized'}.`,
);
