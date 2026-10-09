// Drop-ins that run copies of packages/kronan-mcp/test files against the Rust binary in
// KRONAN_RUST_BINARY. The TypeScript cases inject a fetch stand-in into `KronanClient`; here that
// same function answers the binary's requests on a loopback upstream (KRONAN_TEST_ORIGIN). Client
// methods are MCP tool calls to a fresh `kronan-mcp serve` over stdio, and schemas are checked by
// the binary's own input validation.
import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
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
 * `KronanClient(token, request)`: each method is one tool call to a fresh `serve`, so its input
 * is validated as the server validates it. Without a token source the binary uses the saved
 * token under this process's environment, as `loadToken` would.
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
  close = async () => {};

  // oxlint-disable-next-line typescript/no-explicit-any -- Each method returns its tool's output.
  async #call(name: string, args: object): Promise<any> {
    const env = this.token ? tokenEnvironment(await this.token()) : {};
    const result = await callTool(name, args, env, this.request);
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

/** `kronan-mcp serve` as the stdio executable, in place of `bun src/cli.ts`. */
export function serveCommand(): { command: string; args: string[] } {
  return { command: rustBinary!, args: ['serve'] };
}
