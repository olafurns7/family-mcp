import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { DOCUMENTATION_FILES, readPackage } from './package.mjs';
import { renderInstall } from './render-install.mjs';

const { values } = parseArgs({
  options: { package: { type: 'string' }, check: { type: 'boolean' } },
});

const pkg = await readPackage(values.package);

const tag = `${pkg.name}@${pkg.version}`;

const installUrl = `https://raw.githubusercontent.com/olafurns7/family-mcp/${tag}/packages/${pkg.name}/install.sh`;

const files = ['README.md', ...DOCUMENTATION_FILES[pkg.name]].map((file) => join(pkg.root, file));

const outputs = new Map([[join(pkg.root, 'install.sh'), await renderInstall(pkg)]]);

for (const file of files) {
  let text = await readFile(file, 'utf8');
  text = text.replace(
    new RegExp(
      `https://raw\\.githubusercontent\\.com/olafurns7/(?:${pkg.name}/[^/]+|family-mcp/[^/]+/packages/${pkg.name})/install\\.sh`,
      'g',
    ),
    installUrl,
  );
  text = text.replace(
    new RegExp(
      `https://github\\.com/olafurns7/(?:${pkg.name}|family-mcp)/releases/tag/[^\\s)\\x60]+`,
      'g',
    ),
    `https://github.com/olafurns7/family-mcp/releases/tag/${tag}`,
  );
  text = text.replace(
    new RegExp(`${pkg.name}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`, 'g'),
    tag,
  );
  text = text.replace(
    new RegExp(
      `${pkg.name}-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?-(darwin|linux)-(arm64|x64)\\.tar\\.gz`,
      'g',
    ),
    `${pkg.name}-${pkg.version}-$1-$2.tar.gz`,
  );
  outputs.set(file, text);
}

for (const [file, text] of outputs) {
  if (values.check)
    assert.equal(
      await readFile(file, 'utf8'),
      text,
      `Run sync-version for ${pkg.name}: ${relative(pkg.root, file)}`,
    );
  else await writeFile(file, text);
}

console.log(
  `${pkg.name}: installer and documentation pins ${values.check ? 'checked' : 'synchronized'} at ${tag}.`,
);
