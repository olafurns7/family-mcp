// Enumerates every test case the TypeScript retirement deletes, and checks that the coverage
// ledger (docs/analysis/ts-retire-ledger.md) has exactly one row per case.
//
//   node tooling/ts-freeze/ledger.mjs list     one tab-separated line per case
//   node tooling/ts-freeze/ledger.mjs check    the ledger's case rows equal the enumeration
//
// Run from the repository root. Cases are found statically, so a test defined in a loop is one
// source site; its `variants` column names the loop. PR 3 deletes this script with the sources.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const LEDGER = 'docs/analysis/ts-retire-ledger.md';

function walk(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.name === 'node_modules') return [];

    return entry.isDirectory() ? walk(path) : [path];
  });
}

const packages = readdirSync(join(root, 'packages')).sort();
const crates = readdirSync(join(root, 'rust'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'target')
  .map((entry) => entry.name)
  .sort();

const STRING = /^\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)")/;
const TEST =
  /^(\s*)(?:\((process\.platform [^?]+)\? test : \(\) => undefined\)|test|it)((?:\.[A-Za-z]+(?:\([^)]*\))?)*)\(/;
const GUARD = /^if \((process\.platform [^)]+)\)$/;

/** The test() sites of a Bun test file, with the first argument as the name. */
function bunCases(suite, file) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');

  return lines.flatMap((line, index) => {
    const match = TEST.exec(line);

    if (!match) return [];
    let rest = line.slice(match[0].length);
    let next = index + 1;

    while (!rest.trim() && next < lines.length) rest = lines[next++];
    const name = STRING.exec(rest);
    assert.ok(name, `${file}:${index + 1}: no literal test name`);
    const variants = [];
    const guard = GUARD.exec(lines[index - 1] ?? '');

    if (match[2]) variants.push(`only if ${match[2].trim()}`);
    else if (guard) variants.push(`only if ${guard[1]}`);

    if (match[3].includes('skipIf')) variants.push(`skipIf${match[3].replace(/^\.skipIf/, '')}`);
    else if (match[3]) variants.push(match[3].slice(1));

    // Any other indented test() is inside a loop or helper: each iteration is a run-time case.
    if (match[1] && !guard) variants.push('loop site');

    return [{ suite, site: `${file}:${index + 1}`, name: name[1] ?? name[2] ?? name[3], variants }];
  });
}

/** The scenario names of a parity.ts `scenarios` array (entries two or four spaces deep). */
function parityScenarios(suite, file) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^const scenarios\b/.test(line));

  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line === '];');

  return lines.slice(start, end).flatMap((line, offset) => {
    const match = /^(?: {2}\{ | {4}| {6}\.\.\.[^{]*\{ )name: (.*)$/.exec(line);

    if (!match) return [];
    const name = STRING.exec(match[1]);
    assert.ok(name, `${file}:${start + offset + 1}: no literal scenario name`);
    const value = name[1] ?? name[2] ?? name[3];

    return [
      {
        suite,
        site: `${file}:${start + offset + 1}`,
        name: value,
        variants: value.includes('${') ? ['loop site'] : [],
      },
    ];
  });
}

/**
 * Domino's parity has no named scenarios: argument lists, the tool surface, an invalid-input list
 * and three sub-harnesses, counted at run time. One case per list or sub-harness scenario.
 */
function dominosParity(suite) {
  const directory = 'rust/dominos-mcp/tests/ts';
  const cases = [];
  const parity = readFileSync(join(root, directory, 'parity.ts'), 'utf8').split('\n');
  const at = (pattern) => parity.findIndex((line) => pattern.test(line)) + 1;

  for (const [name, pattern] of [
    ['cli argument list', /for \(const args of \[/],
    ['tool surface and instructions', /surfaces\.push\(/],
    ['invalid tool input list', /const invalid: /],
    ['unsafe config folder refusal', /const unsafe = /],
  ])
    cases.push({ suite, site: `${directory}/parity.ts:${at(pattern)}`, name, variants: [] });

  for (const file of ['reads-parity.ts', 'auth-parity.ts', 'money-parity.ts']) {
    const lines = readFileSync(join(root, directory, file), 'utf8').split('\n');
    const named = lines.flatMap((line, index) => {
      const match = /^\s*\{ name: '([^']+)'/.exec(line) ?? /^\s{4,}name: '([^']+)'/.exec(line);

      return match ? [{ suite, site: `${directory}/${file}:${index + 1}`, name: match[1] }] : [];
    });
    const entry = lines.findIndex((line) => /^export async function/.test(line)) + 1;

    if (named.length) cases.push(...named.map((scenario) => ({ ...scenario, variants: [] })));
    else
      cases.push({
        suite,
        site: `${directory}/${file}:${entry}`,
        name: file.replace('.ts', ''),
        variants: [],
      });
  }

  return cases;
}

/** `#[test]` functions of a Rust test file that drives Bun, ignored helpers included. */
function rustCases(suite, file) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const feature = /#!\[cfg\(feature = "([^"]+)"\)\]/.exec(lines.join('\n'));

  return lines.flatMap((line, index) => {
    if (line.trim() !== '#[test]') return [];
    let next = index + 1;
    const variants = feature ? [`feature ${feature[1]}`] : [];

    while (!/^\s*fn /.test(lines[next])) {
      if (lines[next].includes('#[ignore')) variants.push('ignored helper');
      next++;
    }

    return [
      {
        suite,
        site: `${file}:${next + 1}`,
        name: /fn (\w+)/.exec(lines[next])[1],
        variants,
      },
    ];
  });
}

function enumerate() {
  const cases = [];

  for (const name of packages) {
    const files = walk(`packages/${name}`)
      .filter((path) => /\/test\/.*\.test\.ts$/.test(path))
      .sort();

    for (const file of files) cases.push(...bunCases(`package ${name}`, file));
  }

  for (const crate of crates) {
    const tests = `rust/${crate}/tests`;
    let entries;

    try {
      entries = walk(tests);
    } catch {
      continue;
    }

    for (const file of entries.filter((path) => /\/ts\/.*\.test\.ts$/.test(path)).sort())
      cases.push(...bunCases(`drop-in ${crate}`, file));

    if (crate === 'dominos-mcp') cases.push(...dominosParity(`parity ${crate}`));
    else if (entries.includes(`${tests}/ts/parity.ts`))
      cases.push(...parityScenarios(`parity ${crate}`, `${tests}/ts/parity.ts`));

    for (const file of entries
      .filter((path) => /^[^/]+\/[^/]+\/tests\/[^/]+\.rs$/.test(path))
      .sort())
      if (readFileSync(join(root, file), 'utf8').includes('FAMILY_MCP_BUN'))
        cases.push(...rustCases(`bun runner ${crate}`, file));
  }

  return cases;
}

/** Test-tree files with no test() site: harnesses, fakes and helpers the cases import. */
function harnesses() {
  return [
    ...packages.flatMap((name) => walk(`packages/${name}`).filter((path) => /\/test\//.test(path))),
    ...crates.flatMap((crate) => {
      try {
        return walk(`rust/${crate}/tests/ts`);
      } catch {
        return [];
      }
    }),
  ]
    .filter((path) => !path.endsWith('.test.ts'))
    .map((path) => relative(root, join(root, path)))
    .sort();
}

const key = (entry) => `${entry.site.replace(/:\d+$/, '')}\t${entry.name}`;

function ledgerRows() {
  const text = readFileSync(join(root, LEDGER), 'utf8');
  const rows = [];

  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line
      .slice(2, -2)
      .split(/(?<!\\) \| /)
      .map((cell) => cell.replaceAll('\\|', '|').trim());
    const site = /^`([^`]+:\d+)`$/.exec(cells[1] ?? '');

    if (!site) continue;
    rows.push({ suite: cells[0], site: site[1], name: cells[2].replace(/^`|`$/g, ''), cells });
  }

  return rows;
}

const [command] = process.argv.slice(2);

if (command === 'list') {
  for (const entry of enumerate())
    process.stdout.write(
      `${entry.suite}\t${entry.site}\t${entry.name}\t${entry.variants.join('; ')}\n`,
    );
  for (const file of harnesses()) process.stdout.write(`harness\t${file}\t\t\n`);
} else if (command === 'check') {
  const cases = enumerate();
  const rows = ledgerRows();
  const expected = new Map(cases.map((entry) => [key(entry), entry]));
  const seen = new Set();
  const problems = [];

  for (const row of rows) {
    const id = key(row);

    if (seen.has(id)) problems.push(`duplicate row: ${row.site} ${row.name}`);
    seen.add(id);
    const entry = expected.get(id);

    if (!entry) problems.push(`row with no case: ${row.site} ${row.name}`);
    else if (entry.site !== row.site) problems.push(`moved: ${row.site} is now ${entry.site}`);

    if (row.cells.length < 7 || row.cells.slice(4, 7).some((cell) => !cell || cell === 'TODO'))
      problems.push(`incomplete row: ${row.site} ${row.name}`);
  }
  for (const [id, entry] of expected)
    if (!seen.has(id)) problems.push(`case with no row: ${entry.site} ${entry.name}`);

  const text = readFileSync(join(root, LEDGER), 'utf8');

  for (const file of harnesses())
    if (!text.includes(`\`${file}\``)) problems.push(`harness not listed: ${file}`);

  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`ledger ok: ${rows.length} cases, ${harnesses().length} harness files\n`);
} else {
  process.stderr.write('Usage: node tooling/ts-freeze/ledger.mjs list|check\n');
  process.exit(2);
}
