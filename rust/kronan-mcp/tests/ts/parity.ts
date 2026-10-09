// TypeScript-versus-Rust parity for kronan-mcp, driven by tests/parity.rs. Each scenario runs once
// against the TypeScript CLI (with rewrite.ts preloaded) and once against the Rust binary (built
// with `test-origin`), each in its own scratch home and against the same local fake upstream, and
// compares outputs, exit codes, upstream requests, the stored token and the files left behind.
// Prints mismatches and exits 1 on any.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  defaultKeyProvider,
  defaultSecretRecordPath,
  withSecretStore,
} from '../../../../packages/session-store/src/index.ts';

import { ORDER_TOKEN, LIST_TOKEN, UPSTREAM_EXTRA, fixtureResponse, product, recipe } from './fixtures.ts';

const [rust, only] = process.argv.slice(2);

if (!rust) throw new RangeError('Usage: parity.ts RUST_BINARY [SCENARIO]');

// Both sides keep their store in each scenario's scratch home through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');
const repo = resolve(import.meta.dir, '../../../..');
const cli = join(repo, 'packages/kronan-mcp/src/cli.ts');
const rewrite = join(import.meta.dir, 'rewrite.ts');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'kronan-parity-'));

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };

const fake = { mode: 'ok', seen: [] as Seen[] };

function reset(): void {
  fake.mode = 'ok';
  fake.seen = [];
}

const TOKEN = 'synthetic-token-0123456789';

/** The default legacy token file under a scratch home, as versions before the store wrote it. */
const LEGACY = { file: '.config/kronan-mcp/session.json', text: JSON.stringify({ version: 1, token: TOKEN }) + '\n' };

const MAX_BODY = 4 * 1024 * 1024;

/** A JSON document of exactly `bytes` bytes: a product whose description pads it out. */
function sized(bytes: number): string {
  const base = JSON.stringify({ ...product, description: '' });

  return JSON.stringify({ ...product, description: 'x'.repeat(bytes - base.length) });
}

/** Upstream values that only exact JavaScript number, key order and string handling reproduce. */
function edge(pathname: string): Response | undefined {
  switch (pathname) {
    case '/api/v1/products/SKU-1/':
      return new Response(
        JSON.stringify({ ...product, nutrition: { b: 1, 10: 'x', 2: null, a: 2.50, energy: 1e21 } })
          .replace('"price":499', '"price":499.0')
          .replace('"discountPercent":10', '"discountPercent":-0')
          .replace('"pricePerKilo":499', '"pricePerKilo":1e-7')
          .replace('"name":"Synthetic milk"', '"name":"Mj\\u00f3lk \\ud83d\\ude00 \\u2028 \\"q\\" </script>"')
          .replace('"nutrition":{', '"nutrition":{"__proto__":7,'),
        { headers: { 'content-type': 'application/json' } },
      );
    case '/api/v1/products/SKU-2/':
      // Nested nutrition is outside the documented schema.
      return Response.json({ ...product, nutrition: { energy: { kcal: 1 } } });
    case '/api/v1/products/SKU-3/':
      // A fractional price where the schema has an integer.
      return Response.json({ ...product, qtyInSalesUnit: 0.30000000000000004, price: 1.5 });
    case '/api/v1/products/SKU-4/':
      return Response.json({ ...product, price: 9007199254740992 });
    case '/api/v1/products/SKU-5/':
      // Missing optional fields stay missing; nullish ones keep null.
      return Response.json({ ...product, brand: undefined, baseComparisonUnit: null, countryOfOrigin: undefined });
    case '/api/v1/products/SKU-6/':
      return new Response(sized(MAX_BODY), { headers: { 'content-type': 'application/json' } });
    case '/api/v1/products/SKU-7/':
      return new Response(sized(MAX_BODY + 1), { headers: { 'content-type': 'application/json' } });
    case '/api/v1/products/SKU-8/':
      return new Response('{"sku":', { headers: { 'content-type': 'application/json' } });
    case '/api/v1/products/SKU-9/':
      return new Response('', { status: 200 });
    case '/api/v1/products/SKU-10/':
      return new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } });
    case '/api/v1/products/SKU-11/':
      return new Response(null, { status: 302, headers: { location: `${origin}/api/v1/products/SKU-1/` } });
    case '/api/v1/products/SKU-12/':
      return new Response(null, { status: 204 });
    case '/api/v1/products/SKU-13/':
      return new Response(`\ufeff${JSON.stringify(product)}`, { headers: { 'content-type': 'application/json' } });
    case '/api/v1/products/SKU-14/':
      return new Response(` \n${JSON.stringify(product)}\n\t`, { headers: { 'content-type': 'application/json' } });
    case '/api/v1/products/SKU-15/':
      return new Response(JSON.stringify(product).replace('"price":499', '"price":499,"price":500'));
    case '/api/v1/products/SKU-16/':
      return Response.json(product, { status: 299 });
    case '/api/v1/orders/currently-active/':
      return new Response(null, { status: 404 });
    case '/api/v1/recipes/':
      return Response.json({ count: 60, next: 'https://api.kronan.is/api/v1/recipes/?limit=50&offset=50', previous: null, results: [recipe, recipe] });
    case '/api/v1/recipes/favorites/':
      return Response.json({ count: 2, next: null, previous: null, results: [recipe] });
    case '/api/v1/product-lists/':
      return Response.json({ count: 0, next: undefined, previous: null, results: [] });
    default:
      return undefined;
  }
}

/** The fake answers every documented path; modes change what it answers. */
function handle(request: Request, body: string): Response {
  const url = new URL(request.url);
  const status = /^status(\d{3})$/.exec(fake.mode);

  if (status) return Response.json({ detail: 'secret detail', path: url.pathname, body }, { status: Number(status[1]) });

  switch (fake.mode) {
    case 'ok':
      return fixtureResponse(url.pathname);
    case 'edge':
      return edge(url.pathname) ?? fixtureResponse(url.pathname);
    case 'mismatch':
      return Response.json({ unexpected: UPSTREAM_EXTRA, count: 'one' });
    case 'array':
      return Response.json([]);
    default:
      return Response.json({ path: url.pathname, body }, { status: 404 });
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    // Other processes probe loopback ports; only Krónan's API paths are recorded.
    if (!url.pathname.startsWith('/api/v1/')) return new Response(null, { status: 404 });
    const body = await request.text();
    const headers: Record<string, string> = {};

    for (const name of ['authorization', 'accept', 'content-type', 'content-length']) {
      const value = request.headers.get(name);

      if (value !== null) headers[name] = value;
    }
    fake.seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers, body });

    return handle(request, body);
  },
});
const origin = `http://127.0.0.1:${server.port}`;

type Step =
  | { cli: string[]; stdin?: string }
  | { serve: [string, unknown][]; surface?: boolean }
  | { mode: string }
  | { save: string | null }
  | { file: string; text: string; permissions?: number };

type Scenario = { name: string; env?: Record<string, string>; steps: Step[] };

/** Every read tool with documented arguments, defaults left to the schema. */
const reads: [string, unknown][] = [
  ['auth_status', {}],
  ['search_products', { query: 'milk' }],
  ['search_products', { query: 'mjólk', page: 2, pageSize: 50, sortBy: 'price', withDetail: true, includePurchaseHistory: true }],
  ['get_product', { sku: 'SKU-1' }],
  ['get_product', { barcode: '12345678' }],
  ['lookup_products', { skus: ['SKU-1', 'SKU-2'] }],
  ['list_categories', {}],
  ['list_category_products', { slug: 'dairy' }],
  ['list_category_products', { slug: 'dairy', page: 2 }],
  ['list_product_tags', {}],
  ['list_products_by_tag', { slug: 'vegan', page: 3 }],
  ['list_products_on_sale', {}],
  ['list_favorite_products', { page: 5 }],
  ['list_orders', {}],
  ['list_orders', { limit: 100, offset: 1_000_000, year: 2025, month: 8, type: 'delivery' }],
  ['get_order', { token: ORDER_TOKEN }],
  ['get_active_order', {}],
  ['summarize_order_lines', { fromYear: 2025, fromMonth: 1, toYear: 2025, toMonth: 6, skus: ['SKU-1', 'SKU-2'] }],
  ['summarize_order_lines', { nameContains: 'mjólk & co/+?' }],
  ['list_purchase_stats', {}],
  ['list_purchase_stats', { limit: 7, offset: 3, sort: 'most_quantity', includeIgnored: true }],
  ['get_shopping_note', {}],
  ['list_archived_shopping_note_lines', {}],
  ['list_product_lists', {}],
  ['get_product_list', { token: LIST_TOKEN }],
  ['list_recipes', { limit: 1 }],
  ['search_recipes', {}],
  ['search_recipes', { query: 'oats', tags: [1, 0], ingredientTags: [2], cuisineTags: [], occasionTags: [3], page: 2, orderBy: 'cooking_time' }],
  ['get_recipe', { slug: 'oat-cakes' }],
  ['list_favorite_recipes', { offset: 1 }],
  ['list_addresses', {}],
  ['get_delivery_slots', { addressId: 11 }],
  ['get_pickup_slots', {}],
  ['get_pickup_slots', { chain: 'pikkolo' }],
  ['get_checkout', {}],
  ['preview_checkout_lines', { lines: [{ sku: 'SKU-1', quantity: 2 }, { sku: 'SKU-2' }] }],
];

/** Invalid arguments: zod's issues, their order and abort rules, and the refinements. */
const invalid: [string, unknown][] = [
  ['auth_status', { x: 1 }],
  ['search_products', {}],
  ['search_products', { query: '' }],
  ['search_products', { query: 'x'.repeat(65), page: 0, pageSize: 51, sortBy: 'Price', withDetail: 'yes' }],
  ['search_products', { query: 1, page: 1.5, pageSize: '2', extra: true, other: null }],
  ['search_products', { query: 'milk', page: 10001, sortBy: 'x'.repeat(33) }],
  ['search_products', { query: 'milk', page: 9007199254740992 }],
  ['search_products', { query: 'milk', page: -9007199254740992 }],
  ['search_products', { query: 'milk', page: null, sortBy: null }],
  ['search_products', { query: '😀'.repeat(33) }],
  ['search_products', { query: '😀'.repeat(32) }],
  ['get_product', {}],
  ['get_product', { sku: 'SKU-1', barcode: '12345678' }],
  ['get_product', { sku: '.' }],
  ['get_product', { sku: '..' }],
  ['get_product', { sku: '...' }],
  ['get_product', { sku: 'a/b' }],
  ['get_product', { sku: '' }],
  ['get_product', { sku: 'x'.repeat(41), barcode: 'abc' }],
  ['get_product', { barcode: '123' }],
  ['get_product', { barcode: '1'.repeat(21) }],
  ['get_product', { sku: undefined, barcode: undefined }],
  ['get_product', { sku: null }],
  ['lookup_products', { skus: [] }],
  ['lookup_products', { skus: Array(31).fill('A') }],
  ['lookup_products', { skus: ['A', 1, '.', '', 'a b'] }],
  ['lookup_products', { skus: 'SKU-1' }],
  ['list_category_products', { slug: 'mjólk-ð_1.2', page: 1 }],
  ['list_category_products', { slug: '.' }],
  ['list_category_products', { slug: '..', page: 0 }],
  ['list_category_products', { slug: 'a b' }],
  ['list_category_products', { slug: '٣' }],
  ['list_category_products', { slug: 'x'.repeat(129) }],
  ['list_products_by_tag', { page: 2 }],
  ['list_products_on_sale', { page: '1' }],
  ['list_orders', { year: 2025 }],
  ['list_orders', { month: 13 }],
  ['list_orders', { year: 1999, month: 0, type: 'other', limit: 0, offset: -1 }],
  ['list_orders', { limit: 101, offset: 1_000_001 }],
  ['get_order', { token: '' }],
  ['get_order', { token: 'a.b' }],
  ['get_order', { token: 'x'.repeat(65) }],
  ['get_order', {}],
  ['summarize_order_lines', {}],
  ['summarize_order_lines', { fromYear: 2025 }],
  ['summarize_order_lines', { fromYear: 2025, nameContains: 'ab', skus: ['A'] }],
  ['summarize_order_lines', { nameContains: 'a' }],
  ['summarize_order_lines', { nameContains: 'ab', skus: [] }],
  ['summarize_order_lines', { fromYear: 2025, fromMonth: 1, toYear: 2025 }],
  ['summarize_order_lines', { skus: Array(11).fill('A') }],
  ['list_purchase_stats', { sort: 'newest', includeIgnored: 1 }],
  ['list_product_lists', { limit: 1.5 }],
  ['get_product_list', { token: 'ü' }],
  ['list_recipes', { offset: '0' }],
  ['search_recipes', { query: 'x'.repeat(65), tags: [-1, 1.5, 'a'], orderBy: 'best' }],
  ['search_recipes', { tags: Array(21).fill(1), ingredientTags: 'a' }],
  ['get_recipe', { slug: '' }],
  ['list_favorite_recipes', { limit: 101 }],
  ['get_delivery_slots', {}],
  ['get_delivery_slots', { addressId: -1 }],
  ['get_delivery_slots', { addressId: 1.5 }],
  ['get_pickup_slots', { chain: 'bonus' }],
  ['preview_checkout_lines', { lines: [] }],
  ['preview_checkout_lines', { lines: [{ sku: 'SKU-1', quantity: 0, extra: 1 }, { quantity: 501 }, 'x'] }],
  ['preview_checkout_lines', { lines: Array(101).fill({ sku: 'A' }) }],
  ['preview_checkout_lines', { lines: [{ sku: '.', quantity: 1.5 }] }],
  // Rust: non-object `arguments` are a protocol error in the TypeScript SDK; rmcp words the
  // array case differently and reads null as no arguments (the shared runtime's decision).
  ['no_such_tool', {}],
];

/** Each upstream product the edge mode answers with, by SKU. */
const edges = Array.from({ length: 16 }, (_, index): [string, unknown] => ['get_product', { sku: `SKU-${index + 1}` }]);

/** Every failure status, on a tool with a not-found message and on one without. */
const statuses = [400, 401, 403, 404, 409, 429, 500, 502].flatMap((status) => [
  { mode: `status${status}` },
  { serve: [['get_recipe', { slug: 'oat-cakes' }], ['list_recipes', {}], ['get_active_order', {}], ['search_products', { query: 'milk' }]] as [string, unknown][] },
]);

const scenarios: Scenario[] = [
  { name: 'surface', steps: [{ serve: [], surface: true }] },
  {
    name: 'cli',
    steps: [
      ['--help'], ['-h'], ['--version'], ['-v'], ['-hv'], ['-vh'], ['--nope'], ['--nope=1'], ['--help=1'],
      ['--version='], ['-x'], ['-vx'], ['-h=1'], ['--='], ['---x'], ['-h', '--nope'], ['-h', '--', 'x'],
      ['auth'], ['auth', 'nope'], ['auth', 'status', 'x'], ['auth', 'migrate', ''], ['auth', 'logout', 'x'],
      ['auth', 'set', 'a', 'b'], ['serve', 'x'], ['x'], ['-'], ['orders'], ['orders', 'clear-attempts', 'x'],
      ['orders', 'nope'], ['auth', '--', '--help'],
    ].map((args) => ({ cli: args })),
  },
  { name: 'reads', steps: [LEGACY, { mode: 'ok' }, { serve: reads }] },
  // Invalid input is refused before the token is read, so no token is needed.
  { name: 'inputs', steps: [{ serve: invalid }] },
  { name: 'edge', steps: [LEGACY, { mode: 'edge' }, { serve: [...edges, ['get_active_order', {}], ['list_recipes', { limit: 100, offset: 10 }], ['list_favorite_recipes', { offset: 1 }], ['list_product_lists', {}]] }] },
  { name: 'mismatch', steps: [LEGACY, { mode: 'mismatch' }, { serve: reads }, { mode: 'array' }, { serve: reads }] },
  { name: 'statuses', steps: [LEGACY, ...statuses] },
  // The encrypted store the TypeScript CLI writes is what the binary reads, and after logout it
  // holds no token; a marker means the legacy file is never read.
  { name: 'store', steps: [LEGACY, { save: TOKEN.replace('0', 'x') }, { mode: 'ok' }, { serve: [['auth_status', {}], ['get_order', { token: ORDER_TOKEN }]] }, { save: null }, { serve: [['auth_status', {}]] }] },
  {
    name: 'tokens',
    steps: [
      { mode: 'ok' },
      { serve: [['auth_status', {}], ['get_product', { sku: 'SKU-1' }]] },
      { file: LEGACY.file, text: '{"version":1,"token":"short"}' },
      { serve: [['auth_status', {}]] },
      { file: LEGACY.file, text: '{"version":2,"token":"synthetic-token-0123456789"}' },
      { serve: [['auth_status', {}]] },
      { file: LEGACY.file, text: 'not json' },
      { serve: [['auth_status', {}]] },
      { file: LEGACY.file, text: LEGACY.text, permissions: 0o644 },
      { serve: [['auth_status', {}]] },
      { file: LEGACY.file, text: ' '.repeat(16_385) },
      { serve: [['auth_status', {}]] },
      { file: LEGACY.file, text: JSON.stringify({ version: 1, token: 'other-synthetic-token-42', extra: 1 }) },
      { serve: [['auth_status', {}]] },
    ],
  },
  { name: 'token-file', env: { KRONAN_TOKEN_FILE: 'nested/../token.json' }, steps: [{ file: 'token.json', text: LEGACY.text }, { mode: 'ok' }, { serve: [['auth_status', {}]] }] },
];

function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    FAMILY_MCP_STORE_TEST_SEAM: '1',
    KRONAN_TEST_ORIGIN: origin,
    ...extra,
  };
}

function command(side: 'ts' | 'rust', args: string[]): string[] {
  return side === 'ts' ? [process.execPath, '--preload', rewrite, cli, ...args] : [rust!, ...args];
}

async function runCli(side: 'ts' | 'rust', home: string, env: Record<string, string>, args: string[], stdin?: string) {
  const child = Bun.spawn(command(side, args), {
    cwd: home,
    env: environment(home, env),
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { args, code, stdout, stderr };
}

async function runServe(side: 'ts' | 'rust', home: string, env: Record<string, string>, calls: [string, unknown][], surface = false) {
  const [executable, ...args] = command(side, ['serve']);
  const transport = new StdioClientTransport({ command: executable!, args, cwd: home, env: environment(home, env), stderr: 'pipe' });
  const client = new Client({ name: 'kronan-parity', version: '1.0.0' });
  const results: unknown[] = [];
  await client.connect(transport);

  if (surface) {
    results.push({
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    });
  }

  for (const [name, args] of calls) {
    try {
      results.push(await client.callTool({ name, arguments: args as Record<string, unknown> }));
    } catch (error) {
      results.push({ protocolError: error instanceof Error ? error.message : String(error) });
    }
  }
  await client.close();

  return results;
}

/** Run `work` with the store options of `home`'s environment. */
async function inHome<T>(home: string, work: (options: Parameters<typeof withSecretStore>[0]) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, environment(home));

  try {
    return await work({
      path: defaultSecretRecordPath('kronan-mcp'),
      server: 'kronan-mcp',
      profile: 'default',
      purpose: 'token',
      schema: 1,
      maxBytes: 16_384,
      keys: defaultKeyProvider({ server: 'kronan-mcp', profile: 'default' }),
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function stored(home: string): Promise<unknown> {
  return inHome(home, async (options) => {
    try {
      if (!existsSync(options.path) && !existsSync(`${options.path}.marker`)) return 'no store';
      const text = await withSecretStore(options, (store) => store.read());

      return text === null ? null : JSON.parse(text);
    } catch (error) {
      return `error: ${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'}`;
    }
  });
}

/** The record the TypeScript CLI saves (`null`: logged out), with the key the store creates. */
async function save(home: string, token: string | null): Promise<void> {
  await inHome(home, (options) =>
    withSecretStore(options, async (store) => {
      if (!(await store.exists())) await store.createKey();
      await store.write(JSON.stringify({ version: 1, token }));
    }),
  );
}

function files(home: string): unknown {
  const directory = join(home, '.config/kronan-mcp');

  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .sort()
    .map((name) => (name.endsWith('.json') ? { name, text: readFileSync(join(directory, name), 'utf8') } : name));
}

function write(home: string, step: { file: string; text: string; permissions?: number }): void {
  const path = join(home, step.file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, step.text, { mode: step.permissions ?? 0o600 });
  chmodSync(path, step.permissions ?? 0o600);
}

async function run(side: 'ts' | 'rust', scenario: Scenario) {
  const home = join(scratch, scenario.name, side);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  reset();
  const steps: unknown[] = [];

  for (const step of scenario.steps) {
    if ('cli' in step) steps.push(await runCli(side, home, scenario.env ?? {}, step.cli, step.stdin));
    else if ('serve' in step) steps.push(await runServe(side, home, scenario.env ?? {}, step.serve, step.surface));
    else if ('mode' in step) fake.mode = step.mode;
    else if ('save' in step) await save(home, step.save);
    else write(home, step);
  }

  return { steps, requests: fake.seen, store: await stored(home), files: files(home) };
}

const failures: string[] = [];

/** CLI runs and tool results on the TypeScript side, so parity is not vacuous. */
const coverage = { cli: 0, tools: 0, succeeded: 0 };

function compare(name: string, ts: unknown, rs: unknown, path = ''): void {
  if (JSON.stringify(ts) === JSON.stringify(rs)) return;

  if (ts && rs && typeof ts === 'object' && typeof rs === 'object' && Array.isArray(ts) === Array.isArray(rs)) {
    const keys = [...new Set([...Object.keys(ts), ...Object.keys(rs)])];

    if (JSON.stringify(Object.keys(ts)) !== JSON.stringify(Object.keys(rs)))
      failures.push(`${name}${path}: keys ${JSON.stringify(Object.keys(ts))} != ${JSON.stringify(Object.keys(rs))}`);

    for (const key of keys)
      compare(name, (ts as Record<string, unknown>)[key], (rs as Record<string, unknown>)[key], `${path}.${key}`);

    return;
  }
  const clip = (value: unknown) => String(JSON.stringify(value)).slice(0, 600);
  failures.push(`${name}${path}:\n  ts:   ${clip(ts)}\n  rust: ${clip(rs)}`);
}

try {
  for (const scenario of scenarios) {
    if (only && scenario.name !== only) continue;
    const ts = await run('ts', scenario);
    coverage.cli += scenario.steps.filter((step) => 'cli' in step).length;
    coverage.tools += JSON.stringify(ts.steps).split('"content"').length - 1;
    coverage.succeeded += JSON.stringify(ts.steps).split('"structuredContent"').length - 1;
    compare(scenario.name, ts, await run('rust', scenario));
  }
} finally {
  await server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

if (!only && (coverage.cli < 30 || coverage.tools < 230 || coverage.succeeded < 55)) failures.push(`coverage too low: ${JSON.stringify(coverage)}`);

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`parity ok: ${JSON.stringify(coverage)}`);
