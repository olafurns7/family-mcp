// Drop-ins that run copies of packages/kronan-mcp/test files against the Rust binary in
// KRONAN_RUST_BINARY. The TypeScript cases inject a fetch stand-in into `KronanClient`; here that
// same function answers the binary's requests on a loopback upstream (KRONAN_TEST_ORIGIN). Client
// methods are MCP tool calls to a fresh `kronan-mcp serve` over stdio, and schemas are checked by
// the binary's own input validation.
import { afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import { LocalKeyFileProvider, type KeyProvider } from '@family-mcp/session-store';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ORIGIN = 'https://api.kronan.is';

const rustBinary = process.env.KRONAN_RUST_BINARY;

if (!rustBinary) throw new RangeError('KRONAN_RUST_BINARY must name the Rust kronan-mcp binary.');

// Rust: the binary keeps its store in scratch directories only through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError('Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.');

/** A closed loopback port: a case without an upstream can never reach Krónan. */
export const NOWHERE = 'http://127.0.0.1:9';

export type Fetch = (url: string, init: RequestInit) => Response | Promise<Response>;

type Upstream = { origin: string; close: () => Promise<void> };

async function body(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

async function answer(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;

  for (const [name, value] of response.headers) out.setHeader(name, value);

  if (!response.body) {
    out.end();

    return;
  }
  const reader = response.body.getReader();
  // A client that stops reading closes the socket; the stream sees `cancel`, as with fetch.
  const closed = new Promise<void>((resolve) => out.once('close', resolve));
  void closed.then(() => !out.writableFinished && reader.cancel().catch(() => {}));

  for (;;) {
    const next = await Promise.race([reader.read(), closed.then(() => undefined)]);

    if (!next || next.done) break;

    if (!out.write(next.value))
      await Promise.race([new Promise((resolve) => out.once('drain', resolve)), closed]);
  }
  out.end();
}

/**
 * Serve `request` on loopback. Each request reaches it as `https://api.kronan.is<path>` with the
 * method, headers, body and an abort signal, and `redirect: 'error'` (the binary never follows
 * one; the loopback case checks that). A thrown error drops the connection, as a failed fetch.
 * A loopback port scanner's `GET /` never reaches it.
 */
export async function upstream(request: Fetch): Promise<Upstream> {
  const server = createServer(async (incoming, out) => {
    if (incoming.url === '/') {
      out.statusCode = 404;
      out.end();

      return;
    }
    const aborted = new AbortController();
    // The binary exiting mid-request aborts it, as fetch's signal would.
    out.once('close', () => aborted.abort());

    const headers = new Headers();

    for (const [name, value] of Object.entries(incoming.headers))
      for (const item of [value ?? []].flat()) headers.append(name, item);

    let response: Response;

    try {
      response = await request(`${ORIGIN}${incoming.url}`, {
        method: incoming.method,
        headers,
        body: await body(incoming),
        redirect: 'error',
        signal: aborted.signal,
      });
    } catch {
      incoming.socket.destroy();

      return;
    }

    await answer(response, out).catch(() => out.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();

  if (!address || typeof address === 'string') throw new RangeError('No upstream port.');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let tokenDirectory: string | undefined;

function tokenRoot(): string {
  tokenDirectory ??= mkdtempSync(join(tmpdir(), 'kronan-tokens-'));

  return tokenDirectory;
}

afterAll(() => {
  if (tokenDirectory) rmSync(tokenDirectory, { recursive: true, force: true });
});

/**
 * The binary reads its token only from the saved token, so a given token becomes a legacy token
 * file of its own beside an empty configuration directory, which the binary reads as the TypeScript
 * client would have used the token.
 */
function tokenEnvironment(token: string): Record<string, string> {
  const directory = mkdtempSync(join(tokenRoot(), 'token-'));
  const file = join(directory, 'session.json');
  writeFileSync(file, JSON.stringify({ version: 1, token }) + '\n', { mode: 0o600 });

  return { KRONAN_TOKEN_FILE: file, XDG_CONFIG_HOME: join(directory, 'config') };
}

/** The binary keeps its order-attempt record beside its token file, named for it. */
const JOURNAL = '.order-attempts.json';

/**
 * A given token with a given record: the token file is the one the record is named for, so every
 * call of one client shares the record, as the TypeScript client's `attempts` argument does.
 */
function journalEnvironment(token: string, attempts: string): Record<string, string> {
  if (!attempts.endsWith(JOURNAL)) throw new RangeError(`The record must end in ${JOURNAL}.`);
  const file = attempts.slice(0, -JOURNAL.length);
  writeFileSync(file, JSON.stringify({ version: 1, token }) + '\n', { mode: 0o600 });

  return { KRONAN_TOKEN_FILE: file, XDG_CONFIG_HOME: `${file}.config` };
}

const UNKNOWN_ERROR = 'The operation failed. Check the server logs for details.';
const ZOD_ERROR = 'Invalid input or unexpected upstream data.';

/** A reviewed message becomes a `SafeError` again; the fixed unknown and input errors do not. */
function failure(message: string): Error {
  return [UNKNOWN_ERROR, ZOD_ERROR, 'Krónan MCP failed.'].includes(message)
    ? new Error(message)
    : new SafeError(message);
}

type Result = { isError?: boolean; content: unknown; structuredContent?: unknown };

/** One tool call to a fresh `serve` whose upstream is `request` (none: a closed port). */
async function callTool(
  name: string,
  args: unknown,
  env: Record<string, string>,
  request?: Fetch,
): Promise<Result> {
  const served = request ? await upstream(request) : undefined;

  try {
    const transport = new StdioClientTransport({
      command: rustBinary!,
      args: ['serve'],
      env: {
        ...(process.env as Record<string, string>),
        ...env,
        KRONAN_TEST_ORIGIN: served?.origin ?? NOWHERE,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'kronan-rust-integration', version: '1.0.0' });
    await client.connect(transport);

    return (await client
      .callTool({ name, arguments: args as Record<string, unknown> })
      .finally(() => client.close())) as Result;
  } finally {
    await served?.close();
  }
}

/**
 * `KronanClient(token, request, attempts)`: each method is one tool call to a fresh `serve`, so
 * its input is validated as the server validates it. Without a token source the binary uses the
 * saved token under this process's environment, as `loadToken` would; with `attempts` (a path
 * ending in `.order-attempts.json`) every call shares that order-attempt record.
 */
export class KronanClient {
  constructor(
    private readonly token?: () => Promise<string>,
    private readonly request?: Fetch,
    readonly attempts?: string,
  ) {}

  status = () => this.#call('auth_status', {});
  searchProducts = (input: object) => this.#call('search_products', input);
  product = (input: object) => this.#call('get_product', input);
  lookupProducts = (input: object) => this.#call('lookup_products', input);
  categories = () => this.#call('list_categories', {});
  categoryProducts = (input: object) => this.#call('list_category_products', input);
  tags = () => this.#call('list_product_tags', {});
  productsByTag = (input: object) => this.#call('list_products_by_tag', input);
  productsOnSale = (input: object = {}) => this.#call('list_products_on_sale', input);
  favoriteProducts = (input: object = {}) => this.#call('list_favorite_products', input);
  orders = (input: object = {}) => this.#call('list_orders', input);
  order = (input: object) => this.#call('get_order', input);
  activeOrder = () => this.#call('get_active_order', {});
  orderLineSummary = (input: object) => this.#call('summarize_order_lines', input);
  purchaseStats = (input: object = {}) => this.#call('list_purchase_stats', input);
  shoppingNote = () => this.#call('get_shopping_note', {});
  archivedShoppingNoteLines = () => this.#call('list_archived_shopping_note_lines', {});
  productLists = (input: object = {}) => this.#call('list_product_lists', input);
  productList = (input: object) => this.#call('get_product_list', input);
  recipes = (input: object = {}) => this.#call('list_recipes', input);
  searchRecipes = (input: object = {}) => this.#call('search_recipes', input);
  recipe = (input: object) => this.#call('get_recipe', input);
  favoriteRecipes = (input: object = {}) => this.#call('list_favorite_recipes', input);
  addresses = () => this.#call('list_addresses', {});
  deliverySlots = (input: object) => this.#call('get_delivery_slots', input);
  pickupSlots = (input: object = {}) => this.#call('get_pickup_slots', input);
  checkout = () => this.#call('get_checkout', {});
  previewCheckoutLines = (input: object) => this.#call('preview_checkout_lines', input);
  addShoppingNoteLines = (input: object) => this.#call('add_shopping_note_lines', input);
  changeShoppingNoteLine = (input: object) => this.#call('change_shopping_note_line', input);
  toggleShoppingNoteLineComplete = (input: object) => this.#call('toggle_shopping_note_line_complete', input);
  deleteShoppingNoteLine = (input: object) => this.#call('delete_shopping_note_line', input);
  clearShoppingNote = (input: object) => this.#call('clear_shopping_note', input);
  setCheckoutLines = (input: object) => this.#call('set_checkout_lines', input);
  reserveDeliverySlot = (input: object) => this.#call('reserve_delivery_slot', input);
  reservePickupSlot = (input: object) => this.#call('reserve_pickup_slot', input);
  completeCheckout = (input: object) => this.#call('complete_checkout', input);
  addCheckoutToOrder = (input: object) => this.#call('add_checkout_to_order', input);
  deleteOrderLines = (input: object) => this.#call('delete_order_lines', input);
  lowerOrderLineQuantities = (input: object) => this.#call('lower_order_line_quantities', input);
  toggleOrderLineSubstitution = (input: object) => this.#call('toggle_order_line_substitution', input);
  close = async () => {};

  /**
   * `createServer(client)` connected through an in-memory pair: one long-lived `serve` with this
   * client's token, record and upstream, and the stdio transport an MCP client connects to.
   */
  async serve(): Promise<{ transport: StdioClientTransport; close: () => Promise<void> }> {
    const served = this.request ? await upstream(this.request) : undefined;
    const transport = new StdioClientTransport({
      command: rustBinary!,
      args: ['serve'],
      env: {
        ...(process.env as Record<string, string>),
        ...(await this.#environment()),
        KRONAN_TEST_ORIGIN: served?.origin ?? NOWHERE,
      },
      stderr: 'pipe',
    });

    return { transport, close: async () => served?.close() };
  }

  async #environment(): Promise<Record<string, string>> {
    if (!this.token) return {};
    const token = await this.token();

    return this.attempts === undefined ? tokenEnvironment(token) : journalEnvironment(token, this.attempts);
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Each method returns its tool's output.
  async #call(name: string, args: object): Promise<any> {
    const result = await callTool(name, args, await this.#environment(), this.request);
    const [content] = result.content as { text: string }[];

    if (result.isError) throw failure(content?.text ?? '');

    return result.structuredContent;
  }
}

type Issue = { code: string };

/**
 * A schema whose `safeParse` asks the binary: the input is refused exactly when the tool reports
 * an input validation error. A valid input runs the tool against a closed port and is discarded.
 */
function schema(tool: string) {
  return {
    async safeParse(
      input: unknown,
    ): Promise<{ success: true } | { success: false; error: { issues: Issue[]; message: string } }> {
      const result = await callTool(tool, input, {});
      const [content] = result.content as { text: string }[];
      const message = content?.text ?? '';

      if (!result.isError || !message.startsWith('Input validation error: ')) return { success: true };
      const issues = message.includes('Unrecognized key') ? [{ code: 'unrecognized_keys' }] : [];

      return { success: false, error: { issues, message } };
    },
  };
}

export const emptyInput = schema('list_categories');
export const searchProductsInput = schema('search_products');
export const getProductInput = schema('get_product');
export const lookupProductsInput = schema('lookup_products');
export const categoryProductsInput = schema('list_category_products');
export const productsByTagInput = schema('list_products_by_tag');
export const pageInput = schema('list_products_on_sale');
export const listOrdersInput = schema('list_orders');
export const orderInput = schema('get_order');
export const summarizeOrderLinesInput = schema('summarize_order_lines');
export const purchaseStatsInput = schema('list_purchase_stats');
export const offsetInput = schema('list_recipes');
export const productListInput = schema('get_product_list');
export const searchRecipesInput = schema('search_recipes');
export const recipeInput = schema('get_recipe');
export const previewCheckoutLinesInput = schema('preview_checkout_lines');
export const addShoppingNoteLinesInput = schema('add_shopping_note_lines');
export const changeShoppingNoteLineInput = schema('change_shopping_note_line');
export const shoppingNoteLineTokenInput = schema('toggle_shopping_note_line_complete');
export const clearShoppingNoteInput = schema('clear_shopping_note');
export const setCheckoutLinesInput = schema('set_checkout_lines');
export const reserveDeliverySlotInput = schema('reserve_delivery_slot');
export const reservePickupSlotInput = schema('reserve_pickup_slot');
export const completeCheckoutInput = schema('complete_checkout');
export const addCheckoutToOrderInput = schema('add_checkout_to_order');
export const deleteOrderLinesInput = schema('delete_order_lines');
export const lowerOrderLineQuantitiesInput = schema('lower_order_line_quantities');
export const toggleOrderLineSubstitutionInput = schema('toggle_order_line_substitution');

/** `kronan-mcp serve` as the stdio executable, in place of `bun src/cli.ts`. */
export function serveCommand(): { command: string; args: string[] } {
  return { command: rustBinary!, args: ['serve'] };
}

type Env = Record<string, string | undefined>;

/**
 * A preload file's `globalThis.fetch`, evaluated here with `env` as its `process.env`; its static
 * imports become dynamic ones. What it writes to stderr reaches `onPreloadOutput`.
 */
async function preloaded(file: string, env: Env): Promise<Fetch | undefined> {
  const sandbox: { fetch?: Fetch } = {};
  const stderr = { write: (text: string) => preloadOutput(text) };
  const source = readFileSync(file, 'utf8').replaceAll(
    /^import (\{[^}]*\}) from ('[^']+');$/gm,
    'const $1 = await import($2);',
  );
  // oxlint-disable-next-line typescript/no-implied-eval -- The suite's own synthetic preload files.
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (
    ...values: unknown[]
  ) => Promise<void>;
  await new AsyncFunction('globalThis', 'process', source)(sandbox, { env, stderr });

  return sandbox.fetch;
}

/** What a preload file writes to stderr (only the SIGTERM case's FETCH_STARTED and FETCH_ABORTED). */
let preloadOutput: (text: string) => void = () => {};

export function onPreloadOutput(listener: (text: string) => void): void {
  preloadOutput = listener;
}

/** The upstream a preload file's fetch would have replaced. */
export async function preloadUpstream(file: string, env: Env = process.env): Promise<Upstream> {
  const fetch = await preloaded(file, env);

  if (!fetch) throw new RangeError('The preload file replaces no fetch.');

  return upstream(fetch);
}

type SpawnOptions = {
  cwd?: string;
  env: Env;
  stdin?: 'ignore' | 'pipe';
  stdout?: 'pipe';
  stderr?: 'pipe';
};

/**
 * In place of `Bun.spawn([bun, '--preload', preload, 'src/cli.ts', ...args], options)`: the binary
 * with `args`, its upstream the preload's fetch (or none).
 */
export async function spawnCli(preload: string | undefined, args: string[], options: SpawnOptions) {
  const served = preload === undefined ? undefined : await preloadUpstream(preload, options.env);

  const child = Bun.spawn([rustBinary!, ...args], {
    ...options,
    env: { ...options.env, KRONAN_TEST_ORIGIN: served?.origin ?? NOWHERE },
  });
  void child.exited.then(() => served?.close());

  return child;
}

/**
 * A key file in its own data home, in place of `FakeKeyProvider` or a `LocalKeyFileProvider`
 * elsewhere: the binary reads only the default key file. Without a key the store key is missing.
 */
export class KeyFile extends LocalKeyFileProvider {
  readonly dataHome: string;

  constructor(key?: Uint8Array) {
    const dataHome = mkdtempSync(join(tokenRoot(), 'data-'));
    super({ path: join(dataHome, 'family-mcp', 'keys', 'kronan-mcp.default.key') });
    this.dataHome = dataHome;

    if (key) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, key, { mode: 0o600 });
    }
  }
}

/**
 * The store failures a key file can give the binary, in place of a provider that throws `code`;
 * codes no key file produces are Rust unit tests.
 */
export function failing(code: 'STORE_UNAVAILABLE' | 'STORE_ERROR'): KeyFile {
  return new KeyFile(code === 'STORE_ERROR' ? new Uint8Array(31) : undefined);
}

function keyEnvironment(keys?: KeyProvider): Record<string, string> {
  if (keys === undefined) return {};

  if (keys instanceof KeyFile) return { XDG_DATA_HOME: keys.dataHome };
  throw new RangeError('The binary reads only a key file; use KeyFile.');
}

/** One CLI command; a failure throws its diagnostic as the TypeScript function would. */
async function cli(
  args: string[],
  { keys, request, stdin }: { keys?: KeyProvider; request?: Fetch; stdin?: string } = {},
): Promise<string> {
  const served = request ? await upstream(request) : undefined;

  try {
    const child = Bun.spawn([rustBinary!, ...args], {
      env: {
        ...process.env,
        ...keyEnvironment(keys),
        KRONAN_TEST_ORIGIN: served?.origin ?? NOWHERE,
      },
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exit !== 0) throw failure(stderr.trim());

    return stdout;
  } finally {
    await served?.close();
  }
}

/** Krónan's `/me/` as the CLI verifies a token, recording the token it was sent. */
function account(seen: string[]): Fetch {
  return (_url, init) => {
    seen.push(new Headers(init.headers).get('authorization')?.replace(/^AccessToken /, '') ?? '');

    return Response.json({ type: 'user', name: 'Synthetic account' });
  };
}

/** `auth status`: the storage line it prints and the token it sends to `/me/`. */
export async function loadSavedToken(keys?: KeyProvider): Promise<{ token: string; storage: string }> {
  const seen: string[] = [];
  const out = await cli(['auth', 'status'], { keys, request: account(seen) });
  const [storage = ''] = out.split('\n');
  const [token] = seen;

  if (token === undefined) throw new RangeError('auth status sent no request.');

  return { token, storage };
}

export async function loadToken(keys?: KeyProvider): Promise<string> {
  return (await loadSavedToken(keys)).token;
}

/** `auth set -` with `token` on standard input; true if a store whose key was lost was replaced. */
export async function saveToken(token: string, keys?: KeyProvider): Promise<boolean> {
  const out = await cli(['auth', 'set', '-'], { keys, request: account([]), stdin: token });

  return out.includes('could not be read without its key and was replaced');
}

export type MigrateResult = 'migrated' | 'already' | 'already-removed-legacy';

const migrated: Record<string, MigrateResult> = {
  'Krónan access token moved to the encrypted store; the plaintext file was removed.\n': 'migrated',
  'Already migrated.\n': 'already',
  'Already migrated. Removed a leftover plaintext token file.\n': 'already-removed-legacy',
};

/** `auth migrate`. */
export async function migrateToken(keys?: KeyProvider): Promise<MigrateResult> {
  const out = await cli(['auth', 'migrate'], { keys });
  const outcome = migrated[out];

  if (!outcome) throw new RangeError(`Unexpected migrate output: ${out}`);

  return outcome;
}

/** `auth logout`. */
export async function logoutToken(keys?: KeyProvider): Promise<void> {
  await cli(['auth', 'logout'], { keys });
}

/**
 * `auth set -` with `raw` on standard input, against an upstream that rejects every token, so
 * nothing is saved: the token the binary normalized is the one it sends.
 */
export async function normalizeToken(raw: string): Promise<string> {
  const seen: string[] = [];
  const rejecting: Fetch = (url, init) => {
    void account(seen)(url, init);

    return new Response(null, { status: 401 });
  };

  try {
    await cli(['auth', 'set', '-'], { request: rejecting, stdin: raw });
  } catch (error) {
    const [token] = seen;

    if (token !== undefined) return token;
    throw error;
  }
  throw new RangeError('A rejected token was saved.');
}

/**
 * The binary's order-attempt record path, as `orders clear-attempts` names it (this process's
 * environment chooses it, as `attemptsPath` reads it). End of input keeps any record.
 */
export function attemptsPath(): string {
  const child = Bun.spawnSync([rustBinary!, 'orders', 'clear-attempts'], {
    env: { ...process.env, KRONAN_TEST_ORIGIN: NOWHERE },
    stdin: 'ignore',
  });
  const [first = ''] = child.stdout.toString().split('\n');
  const named =
    /^No recorded order attempts in (.*)\.$/.exec(first) ??
    /^Recorded order attempts in (.*):$/.exec(first) ??
    /^The order-attempt record (.*) is unreadable or unsafe\.$/.exec(first);

  if (!named?.[1]) throw new RangeError('The binary named no order-attempt record.');

  return named[1];
}
