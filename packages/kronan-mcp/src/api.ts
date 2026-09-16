import { readBody, ResponseBodyTooLargeError, SafeError } from '@family-mcp/mcp-runtime';
import * as z from 'zod/v4';

import { ORIGIN, loadToken, tokenPath } from './auth.js';
import {
  activeOrderSchema,
  archivedLinesUpstream,
  categoriesUpstream,
  categoryProductsInput,
  categoryProductsSchema,
  checkoutSchema,
  getProductInput,
  listOrdersInput,
  lookupProductsInput,
  lookupResultSchema,
  meSchema,
  offsetInput,
  orderInput,
  orderLineSummarySchema,
  orderSchema,
  ordersUpstream,
  pageInput,
  productDetailSchema,
  productListDetailSchema,
  productListInput,
  productListsUpstream,
  productPageSchema,
  productsByTagInput,
  purchaseStatsInput,
  purchaseStatsUpstream,
  recipeDetailSchema,
  recipeInput,
  recipeSearchResultSchema,
  recipesUpstream,
  searchProductsInput,
  searchRecipesInput,
  searchResultSchema,
  shoppingNoteSchema,
  summarizeOrderLinesInput,
  tagsUpstream,
} from './schemas.js';

const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;

const TIMEOUT_MS = 20_000;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Request bodies come from parsed inputs; JSON.stringify omits their undefined optionals. */
type JsonBody = { [key: string]: JsonValue | undefined };

/** Query values come from parsed inputs; undefined optionals are omitted from the URL. */
type Query = { [key: string]: string | number | boolean | string[] | undefined };

export type TokenSource = () => Promise<string>;

export type RequestFunction = (url: string, options: RequestInit) => Promise<Response>;

const TOKEN_REJECTED = new SafeError(
  'Krónan rejected the access token. Create a new token in Krónan settings and run kronan-mcp auth set.',
);

const ACCESS_DENIED = new SafeError(
  'Krónan denied this request for the saved token. Use a token for the right user or customer group, or one with the needed permission.',
);

const RESPONSE_TOO_LARGE = new SafeError(
  'Krónan response exceeded the 4 MiB limit. Request a smaller page and retry.',
);

const CANCELLED = new SafeError(
  'The Krónan request was cancelled while the server was shutting down.',
);

const INVALID_RESPONSE = new SafeError('Krónan returned an invalid API response.');

const REQUEST_FAILED = new SafeError(
  'Krónan request failed or timed out. Check the connection and try again.',
);

const RATE_LIMITED = new SafeError(
  'Krónan rate limit reached (200 requests per 200 seconds per account). Wait and retry.',
);

const UNEXPECTED_DATA = new SafeError(
  'Krónan returned data outside the documented schema. The API may have changed; report this with the kronan-mcp version.',
);

/** Limit/offset pages arrive with absolute URLs; the result reports the same information as flags. */
type OffsetWindow = { limit: number; offset: number };

/** A response together with the signal that bounded its request, for the body read. */
type Exchange = { response: Response; signal: AbortSignal };

/**
 * Limit/offset pages arrive with absolute URLs; the result reports the window as flags. The next
 * offset counts the items actually returned, so a clamped or short upstream page cannot skip items.
 */
function offsetPage<T>(
  page: { count: number; next?: string | null | undefined; results: T[] },
  input: OffsetWindow,
) {
  const hasNextPage = page.next !== null && page.next !== undefined;

  return {
    count: page.count,
    limit: input.limit,
    offset: input.offset,
    hasNextPage,
    nextOffset: hasNextPage ? input.offset + page.results.length : null,
    results: page.results,
  };
}

export class KronanClient {
  private readonly lifecycle = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly token: TokenSource = () => loadToken(tokenPath()),
    private readonly request: RequestFunction = fetch,
  ) {}

  async close(): Promise<void> {
    this.lifecycle.abort();
    await Promise.allSettled(this.active);
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    const operation = work();
    this.active.add(operation);

    return operation.finally(() => this.active.delete(operation));
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    query: Query = {},
    body?: JsonBody,
  ): Promise<Exchange> {
    const token = await this.token();
    const url = new URL(`/api/v1${path}`, ORIGIN);

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }

    // Identifiers are validated and encoded, so URL normalization must not have moved the request.
    if (url.pathname !== `/api/v1${path}`)
      throw new SafeError('Invalid identifier in the request.');

    const headers = new Headers({
      Authorization: `AccessToken ${token}`,
      Accept: 'application/json',
    });

    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const options: RequestInit = { method, redirect: 'error', signal, headers };

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(body);
    }

    try {
      return { response: await this.request(url.href, options), signal };
    } catch {
      if (this.lifecycle.signal.aborted) throw CANCELLED;
      throw REQUEST_FAILED;
    }
  }

  /** Maps status codes to fixed messages; a 404 is only meaningful where the caller names it. */
  private static failure(response: Response, notFound?: SafeError): SafeError | undefined {
    if (response.status === 401) return TOKEN_REJECTED;

    if (response.status === 403) return ACCESS_DENIED;

    if (response.status === 429) return RATE_LIMITED;

    if (response.status === 404 && notFound) return notFound;

    if (!response.ok) return new SafeError('Krónan returned an error for the requested operation.');

    return undefined;
  }

  private async json({ response, signal }: Exchange, notFound?: SafeError): Promise<JsonValue> {
    const failure = KronanClient.failure(response, notFound);

    if (failure) {
      // Error bodies may echo request details; they are discarded unread.
      await response.body?.cancel().catch(() => {});
      throw failure;
    }

    let text: string;

    try {
      text = await readBody(response, MAX_RESPONSE_BODY_BYTES, signal);
    } catch (cause) {
      if (cause instanceof ResponseBodyTooLargeError) throw RESPONSE_TOO_LARGE;

      if (this.lifecycle.signal.aborted) throw CANCELLED;

      // The request timer also bounds the body; a stalled stream is a connection problem.
      if (signal.aborted) throw REQUEST_FAILED;
      throw INVALID_RESPONSE;
    }

    try {
      return z.json().parse(JSON.parse(text));
    } catch {
      throw INVALID_RESPONSE;
    }
  }

  private async get<T>(
    path: string,
    query: Query,
    schema: z.ZodType<T>,
    notFound?: SafeError,
  ): Promise<T> {
    const result = schema.safeParse(await this.json(await this.send('GET', path, query), notFound));

    if (!result.success) throw UNEXPECTED_DATA;

    return result.data;
  }

  /** Fetches one limit/offset page and reports its window as flags instead of upstream URLs. */
  private async offsetPaged<T>(
    path: string,
    window: OffsetWindow,
    query: Query,
    schema: z.ZodType<{ count: number; next?: string | null | undefined; results: T[] }>,
  ) {
    return offsetPage(await this.get(path, { ...window, ...query }, schema), window);
  }

  private async post<T>(path: string, body: JsonBody, schema: z.ZodType<T>): Promise<T> {
    const result = schema.safeParse(await this.json(await this.send('POST', path, {}, body)));

    if (!result.success) throw UNEXPECTED_DATA;

    return result.data;
  }

  status() {
    // An authenticated read, so 'authenticated' never means only 'file exists'.
    return this.run(async () => ({
      authenticated: true as const,
      account: await this.get('/me/', {}, meSchema),
    }));
  }

  searchProducts(input: z.input<typeof searchProductsInput>) {
    const body = searchProductsInput.parse(input);

    return this.run(() => this.post('/products/search/', body, searchResultSchema));
  }

  product(input: z.input<typeof getProductInput>) {
    const { sku, barcode } = getProductInput.parse(input);

    const path =
      sku === undefined
        ? `/products/barcode/${encodeURIComponent(barcode ?? '')}/`
        : `/products/${encodeURIComponent(sku)}/`;

    return this.run(() =>
      this.get(path, {}, productDetailSchema, new SafeError('Product not found at Krónan.')),
    );
  }

  lookupProducts(input: z.input<typeof lookupProductsInput>) {
    const body = lookupProductsInput.parse(input);

    return this.run(() => this.post('/products/batch/', body, lookupResultSchema));
  }

  categories() {
    return this.run(async () => ({
      categories: await this.get('/categories/', {}, categoriesUpstream),
    }));
  }

  categoryProducts(input: z.input<typeof categoryProductsInput>) {
    const { slug, page } = categoryProductsInput.parse(input);

    return this.run(() =>
      this.get(
        `/categories/${encodeURIComponent(slug)}/products/`,
        { page },
        categoryProductsSchema,
        new SafeError(
          'Category not found at Krónan. Use a leaf (third-level) slug from list_categories.',
        ),
      ),
    );
  }

  tags() {
    return this.run(async () => ({ tags: await this.get('/products/tags/', {}, tagsUpstream) }));
  }

  productsByTag(input: z.input<typeof productsByTagInput>) {
    const { slug, page } = productsByTagInput.parse(input);

    return this.run(() =>
      this.get(
        `/products/by-tag/${encodeURIComponent(slug)}/`,
        { page },
        productPageSchema,
        new SafeError('Tag not found at Krónan. Use a slug from list_product_tags.'),
      ),
    );
  }

  productsOnSale(input: z.input<typeof pageInput> = {}) {
    const { page } = pageInput.parse(input);

    return this.run(() => this.get('/products/on-sale/', { page }, productPageSchema));
  }

  favoriteProducts(input: z.input<typeof pageInput> = {}) {
    const { page } = pageInput.parse(input);

    return this.run(() => this.get('/products/favorites/', { page }, productPageSchema));
  }

  orders(input: z.input<typeof listOrdersInput> = {}) {
    const { limit, offset, year, month, type } = listOrdersInput.parse(input);

    return this.run(() =>
      this.offsetPaged('/orders/', { limit, offset }, { year, month, type }, ordersUpstream),
    );
  }

  order(input: z.input<typeof orderInput>) {
    const { token } = orderInput.parse(input);

    return this.run(() =>
      this.get(
        `/orders/${encodeURIComponent(token)}/`,
        {},
        orderSchema,
        new SafeError('Order not found at Krónan. Use a token from list_orders.'),
      ),
    );
  }

  activeOrder() {
    return this.run(async () => {
      const exchange = await this.send('GET', '/orders/currently-active/');

      // Krónan documents 404 with no body as 'no active order'; every other failure is an error.
      if (exchange.response.status === 404) {
        await exchange.response.body?.cancel().catch(() => {});

        return { active: false, order: null };
      }

      const result = activeOrderSchema.safeParse(await this.json(exchange));

      if (!result.success) throw UNEXPECTED_DATA;

      return { active: true, order: result.data };
    });
  }

  orderLineSummary(input: z.input<typeof summarizeOrderLinesInput>) {
    const { fromYear, fromMonth, toYear, toMonth, nameContains, skus } =
      summarizeOrderLinesInput.parse(input);

    // Krónan reads snake_case query names; the input validated that the range is all-or-nothing.
    const query = {
      from_year: fromYear,
      from_month: fromMonth,
      to_year: toYear,
      to_month: toMonth,
      name_contains: nameContains,
      skus,
    };

    return this.run(() => this.get('/orders/line-summary/', query, orderLineSummarySchema));
  }

  purchaseStats(input: z.input<typeof purchaseStatsInput> = {}) {
    const { limit, offset, sort, includeIgnored } = purchaseStatsInput.parse(input);

    return this.run(() =>
      this.offsetPaged(
        '/product-purchase-stats/',
        { limit, offset },
        { sort, include_ignored: includeIgnored },
        purchaseStatsUpstream,
      ),
    );
  }

  shoppingNote() {
    return this.run(() => this.get('/shopping-notes/', {}, shoppingNoteSchema));
  }

  archivedShoppingNoteLines() {
    return this.run(async () => ({
      lines: await this.get('/shopping-notes/lines-archived/', {}, archivedLinesUpstream),
    }));
  }

  productLists(input: z.input<typeof offsetInput> = {}) {
    const window = offsetInput.parse(input);

    return this.run(() => this.offsetPaged('/product-lists/', window, {}, productListsUpstream));
  }

  productList(input: z.input<typeof productListInput>) {
    const { token } = productListInput.parse(input);

    return this.run(() =>
      this.get(
        `/product-lists/${encodeURIComponent(token)}/`,
        {},
        productListDetailSchema,
        new SafeError('Product list not found at Krónan. Use a token from list_product_lists.'),
      ),
    );
  }

  recipes(input: z.input<typeof offsetInput> = {}) {
    const window = offsetInput.parse(input);

    return this.run(() => this.offsetPaged('/recipes/', window, {}, recipesUpstream));
  }

  searchRecipes(input: z.input<typeof searchRecipesInput> = {}) {
    const body = searchRecipesInput.parse(input);

    return this.run(() => this.post('/recipes/search/', body, recipeSearchResultSchema));
  }

  recipe(input: z.input<typeof recipeInput>) {
    const { slug } = recipeInput.parse(input);

    return this.run(() =>
      this.get(
        `/recipes/${encodeURIComponent(slug)}/`,
        {},
        recipeDetailSchema,
        new SafeError('Recipe not found at Krónan. Use a slug from list_recipes.'),
      ),
    );
  }

  favoriteRecipes(input: z.input<typeof offsetInput> = {}) {
    const window = offsetInput.parse(input);

    return this.run(() => this.offsetPaged('/recipes/favorites/', window, {}, recipesUpstream));
  }

  checkout() {
    return this.run(() => this.get('/checkout/', {}, checkoutSchema));
  }
}
