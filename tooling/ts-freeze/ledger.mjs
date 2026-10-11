// Enumerates every test case the TypeScript retirement deletes, and checks that the coverage
// ledger (docs/analysis/ts-retire-ledger.md) has exactly one row per case.
//
//   node tooling/ts-freeze/ledger.mjs list       one tab-separated line per case
//   node tooling/ts-freeze/ledger.mjs check      the self-check, then: the ledger's rows equal the
//                                                enumeration
//   node tooling/ts-freeze/ledger.mjs selfcheck  only the adversarial self-check
//
// Run from the repository root. Cases are found statically, so a test defined in a loop is one
// source site; its `variants` column names the loop. Discovery reads tokens, not lines: a
// registration is found wherever it sits (in a helper, after an `if`, split over lines), and any
// form it cannot read (an aliased or computed registration, a name that is not a literal, a Rust
// test attribute other than `#[test]`) stops the run instead of yielding no case. Cases are keyed
// by their full site and name, and two cases with one identity stop the run. PR 3 deletes this
// script with the sources.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

const LEDGER = 'docs/analysis/ts-retire-ledger.md';

/** @typedef {{ suite: string, site: string, name: string, variants: string[] }} Case */

/** @typedef {{ kind: 'name' | 'string' | 'template' | 'number' | 'regex' | 'punct', text: string, start: number, end: number, line: number }} Token */

/**
 * @param {string} directory
 * @returns {string[]}
 */
function walk(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.name === 'node_modules') return [];

    return entry.isDirectory() ? walk(path) : [path];
  });
}

const packages = readdirSync(join(root, 'packages')).toSorted();

const crates = readdirSync(join(root, 'rust'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'target')
  .map((entry) => entry.name)
  .toSorted();

/** Words after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'else',
  'yield',
  'await',
]);

/**
 * The end of the template literal that starts at `start` (its backtick), past nested `${…}`.
 * @param {string} source
 * @param {number} start
 * @param {string} file
 * @returns {number}
 */
function templateEnd(source, start, file) {
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') index += 2;
    else if (char === '`') return index + 1;
    else if (char === '$' && source[index + 1] === '{')
      index = expressionEnd(source, index + 2, file);
    else index++;
  }

  throw new RangeError(`${file}: unterminated template literal`);
}

/**
 * The index just past the `}` that closes the template expression starting at `start`.
 * @param {string} source
 * @param {number} start
 * @param {string} file
 * @returns {number}
 */
function expressionEnd(source, start, file) {
  let depth = 1;
  let index = start;

  while (index < source.length) {
    const char = source[index] ?? '';

    if (char === '`') index = templateEnd(source, index, file);
    else if (char === "'" || char === '"') index = stringEnd(source, index, file);
    else if (char === '{') {
      depth++;
      index++;
    } else if (char === '}') {
      depth--;
      index++;

      if (depth === 0) return index;
    } else index++;
  }

  throw new RangeError(`${file}: unterminated template expression`);
}

/**
 * @param {string} source
 * @param {number} start
 * @param {string} file
 * @returns {number}
 */
function stringEnd(source, start, file) {
  const quote = source[start];
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') index += 2;
    else if (char === quote) return index + 1;
    else if (char === '\n') break;
    else index++;
  }

  throw new RangeError(`${file}: unterminated string`);
}

/**
 * The end of the regular expression literal that starts at `start`, flags included.
 * @param {string} source
 * @param {number} start
 * @param {string} at
 * @returns {number}
 */
function regexEnd(source, start, at) {
  let end = start + 1;
  let inClass = false;

  while (end < source.length && (inClass || source[end] !== '/')) {
    if (source[end] === '\n') throw new RangeError(`${at}: unterminated regex`);

    if (source[end] === '\\') end++;
    else if (source[end] === '[') inClass = true;
    else if (source[end] === ']') inClass = false;
    end++;
  }

  end++;

  while (/[a-z]/.test(source[end] ?? '')) end++;

  return end;
}

/**
 * The tokens of a TypeScript source: comments dropped, strings, templates and regular expressions
 * whole, so text inside them is never read as code.
 * @param {string} source
 * @param {string} file
 * @returns {Token[]}
 */
function tokenize(source, file) {
  /** @type {Token[]} */
  const tokens = [];
  let index = 0;
  let line = 1;

  /**
   * @param {Token['kind']} kind
   * @param {number} end
   */
  const push = (kind, end) => {
    tokens.push({ kind, text: source.slice(index, end), start: index, end, line });
    line += source.slice(index, end).split('\n').length - 1;
    index = end;
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (char === '\n') {
      line++;
      index++;
    } else if (/\s/.test(char)) index++;
    else if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);

      if (end < 0) throw new RangeError(`${file}: unterminated comment`);
      line += source.slice(index, end).split('\n').length - 1;
      index = end + 2;
    } else if (char === "'" || char === '"') push('string', stringEnd(source, index, file));
    else if (char === '`') push('template', templateEnd(source, index, file));
    else if (/[A-Za-z_$]/.test(char)) {
      const match = /^[\w$]+/.exec(source.slice(index, index + 200));
      push('name', index + (match?.[0].length ?? 1));
    } else if (/\d/.test(char)) {
      const match = /^[\w.]+/.exec(source.slice(index, index + 200));
      push('number', index + (match?.[0].length ?? 1));
    } else if (char === '/') {
      const previous = tokens.at(-1);

      const division =
        previous !== undefined &&
        (['number', 'string', 'template', 'regex'].includes(previous.kind) ||
          (previous.kind === 'name' && !BEFORE_REGEX.has(previous.text)) ||
          [')', ']', '}'].includes(previous.text));

      push(
        division ? 'punct' : 'regex',
        division ? index + 1 : regexEnd(source, index, `${file}:${line}`),
      );
    } else if (source.startsWith('...', index)) push('punct', index + 3);
    else if (char === '?' && next === '.' && !/\d/.test(source[index + 2] ?? ''))
      push('punct', index + 2);
    else if (char === '=' && next === '>') push('punct', index + 2);
    else push('punct', index + 1);
  }

  return tokens;
}

/**
 * The index of the token that closes the group opened at `open`.
 * @param {Token[]} tokens
 * @param {number} open
 * @returns {number}
 */
function closing(tokens, open) {
  const pairs = new Map([
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ]);

  const first = tokens[open]?.text ?? '';
  const closer = pairs.get(first);

  if (!closer) throw new RangeError(`not an opener: ${first}`);
  let depth = 0;

  for (let index = open; index < tokens.length; index++) {
    const text = tokens[index]?.text;

    if (text === first) depth++;
    else if (text === closer && --depth === 0) return index;
  }

  throw new RangeError(`unbalanced ${first}`);
}

/**
 * The index of the unclosed group opener before `index`, or -1 at the top level.
 * @param {Token[]} tokens
 * @param {number} index
 * @returns {number}
 */
function opener(tokens, index) {
  let depth = 0;

  for (let at = index - 1; at >= 0; at--) {
    const text = tokens[at]?.text;

    if (text === ')' || text === ']' || text === '}') depth++;
    else if (text === '(' || text === '[' || text === '{') {
      if (depth === 0) return at;
      depth--;
    }
  }

  return -1;
}

/** Registration functions Bun provides; `describe` and aliases are refused. */
const REGISTRATIONS = new Set(['test', 'it']);

const MODIFIERS = new Set(['skip', 'only', 'todo', 'failing', 'if', 'skipIf', 'todoIf']);

const CALLED_MODIFIERS = new Set(['if', 'skipIf', 'todoIf']);

/**
 * A string or template token's text without its quotes.
 * @param {Token} token
 * @returns {string}
 */
const unquote = (token) => token.text.slice(1, -1);

/**
 * The index past a registration's modifiers (`.skip`, `.skipIf(…)`) that start at `index`.
 * @param {Token[]} tokens
 * @param {number} index
 * @param {string} at
 * @returns {number}
 */
function modifiersEnd(tokens, index, at) {
  let call = index;

  while (tokens[call]?.text === '.') {
    const modifier = tokens[call + 1];

    if (modifier?.kind !== 'name' || !MODIFIERS.has(modifier.text))
      throw new RangeError(`${at}: unsupported modifier ${modifier?.text}`);
    call += 2;

    if (!CALLED_MODIFIERS.has(modifier.text)) continue;

    if (tokens[call]?.text !== '(')
      throw new RangeError(`${at}: ${modifier.text} without its condition`);
    call = closing(tokens, call) + 1;
  }

  return call;
}

/**
 * The test() sites of a Bun test file's source, with the first argument as the name.
 * @param {string} suite
 * @param {string} file
 * @param {string} source
 * @returns {Case[]}
 */
function bunCasesIn(suite, file, source) {
  const tokens = tokenize(source, file);
  /** @type {Set<number>} */
  const imported = new Set();
  /** @type {Case[]} */
  const cases = [];

  // Imports from bun:test: plain `{ test, it, … }` only.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.text !== 'import') continue;
    let end = index + 1;

    while (end < tokens.length && tokens[end]?.text !== 'from' && tokens[end]?.text !== ';') end++;
    const module = tokens[end + 1];

    if (tokens[end]?.text !== 'from' || module?.kind !== 'string' || unquote(module) !== 'bun:test')
      continue;
    const specifiers = tokens.slice(index + 1, end).map((token) => token.text);

    if (specifiers[0] !== '{' || specifiers.at(-1) !== '}')
      throw new RangeError(`${file}:${tokens[index]?.line}: unsupported bun:test import`);

    if (specifiers.includes('as') || specifiers.includes('describe'))
      throw new RangeError(
        `${file}:${tokens[index]?.line}: aliased or describe import from bun:test`,
      );

    for (let at = index; at <= end + 1; at++) imported.add(at);
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token?.kind !== 'name' || imported.has(index)) continue;

    if (token.text === 'describe') {
      const after = tokens[index + 1]?.text;

      if (after === '(' || after === '.')
        throw new RangeError(`${file}:${token.line}: describe() is not supported`);
    }

    if (!REGISTRATIONS.has(token.text)) continue;
    const before = tokens[index - 1]?.text ?? '';
    const after = tokens[index + 1]?.text ?? '';

    // A property (`/x/.test(…)`, `a?.test`) or an object key (`{ test: … }`).
    if (before === '.' || before === '?.') continue;

    if (after === ':' && (before === '{' || before === ',')) continue;
    let start = index;
    let call = index + 1;
    let condition = '';

    if (before === '?' && after === ':') {
      // `(<condition> ? test : () => undefined)(…)`: a platform-conditional registration.
      const open = opener(tokens, index);
      const close = closing(tokens, open);

      const alternative = tokens
        .slice(index + 2, close)
        .map((part) => part.text)
        .join(' ');

      if (open < 0 || tokens[close + 1]?.text !== '(' || alternative !== '( ) => undefined')
        throw new RangeError(`${file}:${token.line}: unsupported conditional ${token.text}`);
      start = open;
      call = close + 1;
      condition = source.slice(tokens[open + 1]?.start ?? 0, tokens[index - 1]?.start ?? 0).trim();
    } else {
      call = modifiersEnd(tokens, call, `${file}:${token.line}`);

      if (tokens[call]?.text === '[')
        throw new RangeError(`${file}:${token.line}: computed ${token.text}[…] is not supported`);

      if (tokens[call]?.text !== '(')
        throw new RangeError(`${file}:${token.line}: ${token.text} used other than as a call`);
    }

    const name = tokens[call + 1];
    const separator = tokens[call + 2]?.text;

    if (!name || (name.kind !== 'string' && name.kind !== 'template'))
      throw new RangeError(`${file}:${token.line}: no literal test name`);

    if (separator !== ',' && separator !== ')')
      throw new RangeError(`${file}:${token.line}: the test name is not one literal`);
    /** @type {string[]} */
    const variants = [];
    // The modifiers between the name and the call (`.skip`, `.skipIf(…)`), as written.

    const chain =
      condition || call === index + 1
        ? ''
        : source.slice(tokens[index + 1]?.start ?? 0, tokens[call - 1]?.end ?? 0);
    // A guard `if (<condition>)` right before the registration.

    const previous = tokens[start - 1];
    const guardOpen = previous?.text === ')' ? opener(tokens, start - 1) : -1;
    const guarded = guardOpen > 0 && tokens[guardOpen - 1]?.text === 'if';
    const looped = guardOpen > 0 && ['for', 'while'].includes(tokens[guardOpen - 1]?.text ?? '');

    if (condition) variants.push(`only if ${condition}`);
    else if (guarded)
      variants.push(
        `only if ${source.slice(tokens[guardOpen + 1]?.start ?? 0, previous?.start ?? 0).trim()}`,
      );

    if (chain) variants.push(chain.slice(1));

    // A registration in a loop, or inside any block or call (a loop or helper), is a site whose
    // every run is a case.
    if (looped || (opener(tokens, start) >= 0 && !guarded)) variants.push('loop site');
    cases.push({ suite, site: `${file}:${tokens[start]?.line}`, name: unquote(name), variants });
  }

  return cases;
}

/**
 * @param {string} suite
 * @param {string} file
 * @returns {Case[]}
 */
function bunCases(suite, file) {
  return bunCasesIn(suite, file, readFileSync(join(root, file), 'utf8'));
}

/**
 * The scenarios of a `scenarios` array literal: every `name` key in it. A literal name is the
 * case's name; any other value (a mapped or interpolated name) is a loop site named by its source.
 * @param {string} suite
 * @param {string} file
 * @param {string} source
 * @returns {Case[] | undefined} undefined when the file has no scenarios array
 */
function scenariosIn(suite, file, source) {
  const tokens = tokenize(source, file);

  const declared = tokens.findIndex(
    (token, index) => token.text === 'scenarios' && tokens[index - 1]?.text === 'const',
  );

  if (declared < 0) return undefined;
  let open = declared + 1;

  while (open < tokens.length && tokens[open]?.text !== '=') open++;
  open++;

  if (tokens[open]?.text !== '[')
    throw new RangeError(`${file}: scenarios is not an array literal`);
  const close = closing(tokens, open);
  /** @type {Case[]} */
  const cases = [];

  for (let index = open + 1; index < close; index++) {
    const token = tokens[index];
    const before = tokens[index - 1]?.text;
    const after = tokens[index + 1]?.text;

    if (token?.text !== 'name' || (before !== '{' && before !== ',')) continue;

    // Only a scenario's own `name`: its object is an element of the array, or the result of a
    // mapping in a spread element (only parentheses between it and the array). A `name` key of an
    // object nested in a scenario (a cookie, a call) is data.
    let enclosing = opener(tokens, index);

    if (tokens[enclosing]?.text !== '{') continue;
    enclosing = opener(tokens, enclosing);

    while (enclosing > open && tokens[enclosing]?.text === '(')
      enclosing = opener(tokens, enclosing);

    if (enclosing !== open) continue;

    if (after !== ':')
      throw new RangeError(`${file}:${token.line}: a scenario name that is not \`name: value\``);
    let end = index + 2;

    while (end < close && ![',', '}'].includes(tokens[end]?.text ?? '')) {
      const text = tokens[end]?.text ?? '';
      end = ['(', '[', '{'].includes(text) ? closing(tokens, end) + 1 : end + 1;
    }

    const value = tokens.slice(index + 2, end);
    const only = value.length === 1 ? value[0] : undefined;

    const literal =
      only?.kind === 'string' || (only?.kind === 'template' && !only.text.includes('${'));

    const name = only && (only.kind === 'string' || only.kind === 'template') ? unquote(only) : '';
    const text = source.slice(value[0]?.start ?? 0, value.at(-1)?.end ?? 0);

    cases.push({
      suite,
      site: `${file}:${token.line}`,
      name: name || text,
      variants: literal ? [] : ['loop site'],
    });
  }

  return cases;
}

/**
 * The scenario names of a parity.ts `scenarios` array.
 * @param {string} suite
 * @param {string} file
 * @returns {Case[]}
 */
function parityScenarios(suite, file) {
  return scenariosIn(suite, file, readFileSync(join(root, file), 'utf8')) ?? [];
}

/**
 * Domino's parity has no named scenarios: argument lists, the tool surface, an invalid-input list
 * and three sub-harnesses, counted at run time. One case per list, and one per sub-harness
 * scenario (or one for a sub-harness without a scenarios array).
 * @param {string} suite
 * @returns {Case[]}
 */
function dominosParity(suite) {
  const directory = 'rust/dominos-mcp/tests/ts';
  /** @type {Case[]} */
  const cases = [];
  const parity = readFileSync(join(root, directory, 'parity.ts'), 'utf8').split('\n');

  for (const [name, pattern] of /** @type {const} */ ([
    ['cli argument list', /for \(const args of \[/],
    ['tool surface and instructions', /surfaces\.push\(/],
    ['invalid tool input list', /const invalid: /],
    ['unsafe config folder refusal', /const unsafe = /],
  ])) {
    const lines = parity.flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
    assert.equal(lines.length, 1, `${directory}/parity.ts: ${name} must be found exactly once`);
    cases.push({ suite, site: `${directory}/parity.ts:${lines[0]}`, name, variants: [] });
  }

  for (const file of ['reads-parity.ts', 'auth-parity.ts', 'money-parity.ts']) {
    const source = readFileSync(join(root, directory, file), 'utf8');
    const named = scenariosIn(suite, `${directory}/${file}`, source);
    const entry = source.split('\n').findIndex((line) => line.startsWith('export async function'));
    assert.ok(named !== undefined || entry >= 0, `${directory}/${file}: no scenarios and no entry`);

    if (named?.length) cases.push(...named);
    else
      cases.push({
        suite,
        site: `${directory}/${file}:${entry + 1}`,
        name: file.replace('.ts', ''),
        variants: [],
      });
  }

  return cases;
}

/**
 * `#[test]` functions of a Rust test file's source, ignored helpers included. Any other test
 * attribute stops the run.
 * @param {string} suite
 * @param {string} file
 * @param {string} source
 * @returns {Case[]}
 */
function rustCasesIn(suite, file, source) {
  const feature = /#!\[cfg\(feature = "([^"]+)"\)\]/.exec(source);
  const lineOf = (/** @type {number} */ offset) => source.slice(0, offset).split('\n').length;
  /** @type {Case[]} */
  const cases = [];

  for (const attribute of source.matchAll(/#\[\s*([\w:]*test[\w:]*)\b[^\]]*\]/g)) {
    if (attribute[0] !== '#[test]')
      throw new RangeError(`${file}:${lineOf(attribute.index)}: unsupported ${attribute[0]}`);
    const rest = source.slice(attribute.index + attribute[0].length);
    const declared = /^(?:\s|#\[[^\]]*\])*fn\s+(\w+)/.exec(rest);
    assert.ok(declared, `${file}:${lineOf(attribute.index)}: no fn after #[test]`);
    const head = rest.slice(0, declared.index + declared[0].length);
    const variants = feature ? [`feature ${feature[1]}`] : [];

    if (head.includes('#[ignore')) variants.push('ignored helper');
    const offset = attribute.index + attribute[0].length + declared[0].lastIndexOf('fn');
    cases.push({ suite, site: `${file}:${lineOf(offset)}`, name: declared[1] ?? '', variants });
  }

  return cases;
}

/**
 * @param {string} suite
 * @param {string} file
 * @returns {Case[]}
 */
function rustCases(suite, file) {
  return rustCasesIn(suite, file, readFileSync(join(root, file), 'utf8'));
}

/**
 * @param {{ site: string, name: string }} entry
 * @returns {string}
 */
const key = (entry) => `${entry.site}\t${entry.name}`;

/**
 * `cases`, refusing two with one identity.
 * @param {Case[]} cases
 * @returns {Case[]}
 */
function unique(cases) {
  /** @type {Set<string>} */
  const seen = new Set();

  for (const entry of cases) {
    if (seen.has(key(entry)))
      throw new RangeError(`two cases share one identity: ${entry.site} ${entry.name}`);
    seen.add(key(entry));
  }

  return cases;
}

/** @returns {Case[]} */
function enumerate() {
  /** @type {Case[]} */
  const cases = [];

  for (const name of packages) {
    const files = walk(`packages/${name}`)
      .filter((path) => /\/test\/.*\.test\.ts$/.test(path))
      .toSorted();

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

    for (const file of entries.filter((path) => /\/ts\/.*\.test\.ts$/.test(path)).toSorted())
      cases.push(...bunCases(`drop-in ${crate}`, file));

    if (crate === 'dominos-mcp') cases.push(...dominosParity(`parity ${crate}`));
    else if (entries.includes(`${tests}/ts/parity.ts`))
      cases.push(...parityScenarios(`parity ${crate}`, `${tests}/ts/parity.ts`));

    for (const file of entries
      .filter((path) => /^[^/]+\/[^/]+\/tests\/[^/]+\.rs$/.test(path))
      .toSorted())
      if (readFileSync(join(root, file), 'utf8').includes('FAMILY_MCP_BUN'))
        cases.push(...rustCases(`bun runner ${crate}`, file));
  }

  return unique(cases);
}

/**
 * Test-tree files with no test() site: harnesses, fakes and helpers the cases import.
 * @returns {string[]}
 */
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
    .flatMap((path) => (path.endsWith('.test.ts') ? [] : [relative(root, join(root, path))]))
    .toSorted();
}

/**
 * @param {string} text
 * @returns {{ suite: string, site: string, name: string, cells: string[] }[]}
 */
function ledgerRows(text) {
  /** @type {{ suite: string, site: string, name: string, cells: string[] }[]} */
  const rows = [];

  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) continue;

    const cells = line
      .slice(2, -2)
      .split(/(?<!\\) \| /)
      .map((cell) => cell.replaceAll('\\|', '|').trim());

    const site = /^`([^`]+:\d+)`$/.exec(cells[1] ?? '');

    if (!site) continue;
    rows.push({
      suite: cells[0] ?? '',
      site: site[1] ?? '',
      name: (cells[2] ?? '').replace(/^`|`$/g, ''),
      cells,
    });
  }

  return rows;
}

/**
 * Every difference between the enumerated cases and the ledger's rows.
 * @param {Case[]} cases
 * @param {string} text the ledger
 * @param {string[]} harnessFiles
 * @returns {string[]}
 */
function problemsWith(cases, text, harnessFiles) {
  const rows = ledgerRows(text);
  const expected = new Map(unique(cases).map((entry) => [key(entry), entry]));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const problems = [];

  for (const row of rows) {
    const id = key(row);

    if (seen.has(id)) problems.push(`duplicate row: ${row.site} ${row.name}`);
    seen.add(id);

    if (!expected.has(id)) problems.push(`row with no case: ${row.site} ${row.name}`);

    if (row.cells.length < 7 || row.cells.slice(4, 7).some((cell) => !cell || cell === 'TODO'))
      problems.push(`incomplete row: ${row.site} ${row.name}`);
  }

  for (const [id, entry] of expected)
    if (!seen.has(id)) problems.push(`case with no row: ${entry.site} ${entry.name}`);

  for (const file of harnessFiles)
    if (!text.includes(`\`${file}\``)) problems.push(`harness not listed: ${file}`);

  return problems;
}

/**
 * The adversarial self-check: every registration form a reviewer probed must either be found (so
 * a ledger without its row fails) or stop the run; none may yield no case. Throws on any miss.
 */
function selfcheck() {
  const file = 'packages/probe/test/cases.test.ts';
  /** @type {[string, string, 'found' | 'refused', string[]?][]} */

  const forms = [
    ['plain', "test('lost', () => {});", 'found', []],
    ['it', "it('lost', () => {});", 'found', []],
    ['skip', "test.skip('lost', () => {});", 'found', ['skip']],
    ['only', "test.only('lost', () => {});", 'found', ['only']],
    ['todo', "test.todo('lost');", 'found', ['todo']],
    ['skipIf', "test.skipIf(process.platform === 'win32')('lost', () => {});", 'found'],
    [
      'helper-multiline',
      "function register() {\n  test('lost', () => {});\n}\nregister();",
      'found',
      ['loop site'],
    ],
    [
      'helper-inline',
      "function register() { test('lost', () => {}); }\nregister();",
      'found',
      ['loop site'],
    ],
    ['inline-if', "if (true) test('lost', () => {});", 'found', ['only if true']],
    ['whitespace', "test ('lost', () => {});", 'found', []],
    ['multiline-call', "test\n('lost', () => {});", 'found', []],
    ['comment-between', "test /* c */ (\n  // name next\n  'lost', () => {});", 'found', []],
    [
      'conditional',
      "(process.platform === 'darwin' ? test : () => undefined)('lost', () => {});",
      'found',
    ],
    ['in-loop', 'for (const x of [1]) test(`lost`, () => {});', 'found', ['loop site']],
    ['imported', "import { expect, test } from 'bun:test';\ntest('lost', () => {});", 'found', []],
    ['computed', "const name = 'lost';\ntest(name, () => {});", 'refused'],
    ['concatenated', "test('lo' + 'st', () => {});", 'refused'],
    ['computed-member', "test['skip']('lost', () => {});", 'refused'],
    ['alias', "import { test as check } from 'bun:test';\ncheck('lost', () => {});", 'refused'],
    ['namespace', "import * as bun from 'bun:test';\nbun.test('lost', () => {});", 'refused'],
    ['reference', "const check = test;\ncheck('lost', () => {});", 'refused'],
    ['each', "test.each([1])('lost', () => {});", 'refused'],
    ['describe', "describe('group', () => { test('lost', () => {}); });", 'refused'],
  ];
  /** @type {string[]} */

  const misses = [];

  for (const [form, source, outcome, variants] of forms) {
    /** @type {Case[] | undefined} */
    let found;

    try {
      found = bunCasesIn('package probe', file, source);
    } catch {
      found = undefined;
    }

    if (outcome === 'refused' && found !== undefined)
      misses.push(`${form}: not refused, found ${JSON.stringify(found)}`);
    else if (outcome === 'found') {
      const lost = found?.filter((entry) => entry.name === 'lost') ?? [];

      if (lost.length !== 1) misses.push(`${form}: ${found ? `${lost.length} cases` : 'refused'}`);
      else if (variants && JSON.stringify(lost[0]?.variants) !== JSON.stringify(variants))
        misses.push(`${form}: variants ${JSON.stringify(lost[0]?.variants)}`);

      // An empty ledger must fail on it.
      if (
        found &&
        !problemsWith(found, '', []).some((problem) => problem.startsWith('case with no row'))
      )
        misses.push(`${form}: an empty ledger passes`);
    }
  }

  // Two same-name sites are two cases; a ledger with only the second fails.
  const twice = bunCasesIn(
    'package probe',
    file,
    "test('same', () => {});\ntest('same', () => {});\n",
  );

  const second = `| package probe | \`${file}:2\` | same | bun test | other | obsolete | probe |\n`;

  if (
    twice.length !== 2 ||
    !problemsWith(twice, second, []).some((problem) => problem.includes(`${file}:1`))
  )
    misses.push('same-name sites collapse');

  // Two registrations of one name on one line share an identity and stop the run.
  try {
    unique(bunCasesIn('package probe', file, "test('same', () => {}); test('same', () => {});"));
    misses.push('one-line duplicate: not refused');
  } catch {
    // Refused, as required.
  }

  // Scenario arrays: mapped and interpolated names are loop sites; shorthand names stop the run.
  const mapped = scenariosIn(
    'parity probe',
    'probe.ts',
    "const scenarios = [\n  { name: 'a' },\n  ...['b', 'c'].map((mode) => ({ name: mode })),\n  ...[1].map((n) => ({ name: `d ${n}` })),\n];",
  );

  if (
    JSON.stringify(mapped?.map((entry) => [entry.name, entry.variants])) !==
    JSON.stringify([
      ['a', []],
      ['mode', ['loop site']],
      ['d ${n}', ['loop site']],
    ])
  )
    misses.push(`scenario array: ${JSON.stringify(mapped)}`);

  try {
    scenariosIn('parity probe', 'probe.ts', 'const scenarios = [{ name }];');
    misses.push('shorthand scenario name: not refused');
  } catch {
    // Refused, as required.
  }

  // Rust: a one-line `#[test] fn` is found; another test attribute stops the run.
  const rust = rustCasesIn(
    'bun runner probe',
    'probe.rs',
    '#[test] fn lost() {}\n#[test]\n#[ignore]\nfn helper() {}\n',
  );

  if (
    JSON.stringify(rust.map((entry) => [entry.site, entry.name, entry.variants])) !==
    JSON.stringify([
      ['probe.rs:1', 'lost', []],
      ['probe.rs:4', 'helper', ['ignored helper']],
    ])
  )
    misses.push(`rust: ${JSON.stringify(rust)}`);

  try {
    rustCasesIn('bun runner probe', 'probe.rs', '#[tokio::test]\nasync fn lost() {}\n');
    misses.push('rust tokio::test: not refused');
  } catch {
    // Refused, as required.
  }

  if (misses.length) throw new RangeError(`self-check failed:\n${misses.join('\n')}`);
}

const [command] = process.argv.slice(2);

if (command === 'list') {
  for (const entry of enumerate())
    process.stdout.write(
      `${entry.suite}\t${entry.site}\t${entry.name}\t${entry.variants.join('; ')}\n`,
    );

  for (const file of harnesses()) process.stdout.write(`harness\t${file}\t\t\n`);
} else if (command === 'selfcheck') {
  selfcheck();
  process.stdout.write('self-check ok\n');
} else if (command === 'check') {
  selfcheck();
  const text = readFileSync(join(root, LEDGER), 'utf8');
  const problems = problemsWith(enumerate(), text, harnesses());

  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `ledger ok: ${ledgerRows(text).length} cases, ${harnesses().length} harness files (self-check ok)\n`,
  );
} else {
  process.stderr.write('Usage: node tooling/ts-freeze/ledger.mjs list|check|selfcheck\n');
  process.exit(2);
}
