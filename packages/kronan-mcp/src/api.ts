import { readBody, ResponseBodyTooLargeError, SafeError } from '@family-mcp/mcp-runtime';
import * as z from 'zod/v4';

import { attemptsPath, claimAttempt, fingerprint, type MoneyTool } from './attempts.js';
import { ORIGIN, loadToken } from './auth.js';
import {
  activeOrderSchema,
  addCheckoutToOrderInput,
  addShoppingNoteLinesInput,
  addressesUpstream,
  changeShoppingNoteLineInput,
  clearShoppingNoteInput,
  completeCheckoutInput,
  deleteOrderLinesInput,
  lowerOrderLineQuantitiesInput,
  orderTokenResponseSchema,
  previewCheckoutLinesInput,
  previewResponseSchema,
  reserveDeliverySlotInput,
  reservePickupSlotInput,
  reserveResponseSchema,
  setCheckoutLinesInput,
  shoppingNoteLineTokenInput,
  toggleOrderLineSubstitutionInput,
  deliverySlotsInput,
  deliverySlotsUpstream,
  pickupSlotsInput,
  pickupSlotsUpstream,
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
type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonInput[]
  | { [key: string]: JsonInput };

type JsonBody = { [key: string]: JsonInput };

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * One mutation request. With `unconfirmed`, Krónan never refuses it definitively: every failure
 * after the request may have left, 4xx included, throws that error instead.
 */
type WriteRequest = { query?: Query; body?: JsonBody; unconfirmed?: SafeError };

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

/** A sent mutation without a readable confirmation. It is never retried; the caller must re-read. */
const WRITE_UNCONFIRMED = new SafeError(
  'Krónan did not confirm this change (connection failure, timeout, server error, or unreadable response); it may have been applied. Read the current state before trying again.',
);

const ORDER_NOT_FOUND = new SafeError('Order not found at Krónan. Use a token from list_orders.');

/** Any failure after an order-change request was sent; a 4xx does not prove nothing changed. */
const ORDER_CHANGE_UNCONFIRMED = new SafeError(
  'Krónan did not confirm this order change; it may have been applied. Read get_order before anything else, and do not repeat the change until the order shows what happened.',
);

const WRITE_REFUSED = new SafeError(
  'Krónan refused the request; nothing was changed. Check the input against the current state.',
);

// Money-gate refusals. Each is sent before any charge-bearing request, so each says so.

const CHECKOUT_EMPTY = new SafeError(
  'The checkout is empty. Nothing was sent to Krónan: no slot was reserved and no order was placed or changed.',
);

const CHECKOUT_REPLACED = new SafeError(
  'The checkout token differs from the approved checkout; review it with get_checkout. Nothing was sent to Krónan: no slot was reserved and no order was placed or changed.',
);

const CHECKOUT_TOTAL_CHANGED = new SafeError(
  'The checkout total differs from the approved total; review it with get_checkout and ask the user again. Nothing was sent to Krónan: no slot was reserved and no order was placed or changed.',
);

const NO_ACTIVE_ORDER = new SafeError(
  'Krónan reports no active order. Nothing was sent to Krónan: no order was placed or changed.',
);

const ORDER_REPLACED = new SafeError(
  'The active order differs from the approved order; review it with get_active_order. Nothing was sent to Krónan: no order was placed or changed.',
);

const GATE_UNVERIFIED = new SafeError(
  'Could not read the checkout or active order to verify the approval; call get_checkout or get_active_order for the reason. Nothing was sent to Krónan: no slot was reserved and no order was placed or changed.',
);

const GATE_REFUSALS = new Set([
  CHECKOUT_EMPTY,
  CHECKOUT_REPLACED,
  CHECKOUT_TOTAL_CHANGED,
  NO_ACTIVE_ORDER,
  ORDER_REPLACED,
]);

const OUTCOME_UNKNOWN =
  'Outcome unknown: the request reached or may have reached Krónan, and no confirmation was read (an error status does not prove it was refused). Check get_active_order and list_orders and ask the user; do not retry or place another order. Order calls for this checkout stay blocked.';

const WEIGHT_NOTE =
  'authorizedAmount is the amount authorized on the saved card; tell the user, because fees and the selected slot can make it higher than the approved checkout total. Separately, weight-charged products mean the final captured amount can differ.';

const ORDER_PLACED = `Krónan accepted the order. ${WEIGHT_NOTE} Check get_active_order for its state.`;

const SLOT_RESERVED = `Krónan reserved the slot and returned an order token. ${WEIGHT_NOTE} Check get_active_order before any other order call.`;

const LINES_ADDED = `Krónan added the checkout lines to the active order. ${WEIGHT_NOTE} Check get_active_order for its state.`;

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
    private readonly token: TokenSource = () => loadToken(),
    private readonly request: RequestFunction = fetch,
    private readonly attempts: string = attemptsPath(),
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
    method: Method,
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

  /**
   * Sends one mutation and never repeats it. A 4xx is a refusal before acceptance; every other
   * failure after the request may have left is WRITE_UNCONFIRMED.
   */
  private async write(
    method: Method,
    path: string,
    { query, body, unconfirmed }: WriteRequest,
  ): Promise<Exchange> {
    let exchange: Exchange;

    try {
      exchange = await this.send(method, path, query, body);
    } catch (cause) {
      // Token and identifier checks throw before sending; a failed or aborted fetch may have been sent.
      if (cause === REQUEST_FAILED || cause === CANCELLED) throw unconfirmed ?? WRITE_UNCONFIRMED;
      throw cause;
    }

    const { response } = exchange;

    if (response.ok) return exchange;
    await response.body?.cancel().catch(() => {});

    if (unconfirmed) throw unconfirmed;

    if (response.status < 400 || response.status > 499) throw WRITE_UNCONFIRMED;

    if ([401, 403, 429].includes(response.status))
      throw KronanClient.failure(response) ?? WRITE_REFUSED;
    throw WRITE_REFUSED;
  }

  private async writeJson<T>(
    method: Method,
    path: string,
    schema: z.ZodType<T>,
    request: WriteRequest,
  ): Promise<T> {
    const exchange = await this.write(method, path, request);
    const unconfirmed = request.unconfirmed ?? WRITE_UNCONFIRMED;
    let data: JsonValue;

    try {
      data = await this.json(exchange);
    } catch {
      throw unconfirmed;
    }

    const result = schema.safeParse(data);

    if (!result.success) throw unconfirmed;

    return result.data;
  }

  /**
   * Refuses unless the live checkout is the non-empty one, at the total, the user approved. The
   * total is a consistency check, not a cap on the amount Krónan authorizes.
   */
  private async verifyCheckout(expectedCheckoutToken: string, expectedTotal: number) {
    const current = await this.get('/checkout/', {}, checkoutSchema);

    if (current.lines.length === 0) throw CHECKOUT_EMPTY;

    if (current.token !== expectedCheckoutToken) throw CHECKOUT_REPLACED;

    if (current.total !== expectedTotal) throw CHECKOUT_TOTAL_CHANGED;

    return { token: current.token, total: current.total, print: fingerprint(current) };
  }

  /**
   * Claims the one attempt this approval allows, runs the gate, and sends one charge-bearing
   * request. Gate and record refusals say nothing was sent; once the request may have left, every
   * failure, 4xx included, is an unknown outcome (null).
   */
  private place<T extends { orderToken: string }>(
    tool: MoneyTool,
    expectedCheckoutToken: string,
    gate: () => Promise<{ token: string; total: number; print: string }>,
    request: () => Promise<T>,
  ): Promise<T | null> {
    return claimAttempt(this.attempts, {
      tool,
      expectedCheckoutToken,
      signal: this.lifecycle.signal,
      gate: async () => {
        try {
          return await gate();
        } catch (cause) {
          if (cause instanceof SafeError && GATE_REFUSALS.has(cause)) throw cause;
          throw GATE_UNVERIFIED;
        }
      },
      send: request,
      orderToken: (value) => value.orderToken,
    });
  }

  private async readActiveOrder() {
    const exchange = await this.send('GET', '/orders/currently-active/');

    // Krónan documents 404 with no body as 'no active order'; every other failure is an error.
    if (exchange.response.status === 404) {
      await exchange.response.body?.cancel().catch(() => {});

      return { active: false, order: null };
    }

    const result = activeOrderSchema.safeParse(await this.json(exchange));

    if (!result.success) throw UNEXPECTED_DATA;

    return { active: true, order: result.data };
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
      this.get(`/orders/${encodeURIComponent(token)}/`, {}, orderSchema, ORDER_NOT_FOUND),
    );
  }

  activeOrder() {
    return this.run(() => this.readActiveOrder());
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

  addresses() {
    return this.run(async () => ({
      addresses: await this.get('/addresses/', {}, addressesUpstream),
    }));
  }

  deliverySlots(input: z.input<typeof deliverySlotsInput>) {
    const body = deliverySlotsInput.parse(input);

    // Availability lookups are POSTs upstream but change nothing; reservation is a separate endpoint.
    return this.run(async () => ({
      days: await this.post('/slots/delivery/', body, deliverySlotsUpstream),
    }));
  }

  pickupSlots(input: z.input<typeof pickupSlotsInput> = {}) {
    const body = pickupSlotsInput.parse(input);

    return this.run(async () => ({
      stores: await this.post('/slots/pickup/', body, pickupSlotsUpstream),
    }));
  }

  checkout() {
    return this.run(() => this.get('/checkout/', {}, checkoutSchema));
  }

  addShoppingNoteLines(input: z.input<typeof addShoppingNoteLinesInput>) {
    const body = addShoppingNoteLinesInput.parse(input);

    return this.run(() =>
      this.writeJson('POST', '/shopping-notes/add-lines/', shoppingNoteSchema, { body }),
    );
  }

  changeShoppingNoteLine(input: z.input<typeof changeShoppingNoteLineInput>) {
    const body = changeShoppingNoteLineInput.parse(input);

    return this.run(() =>
      this.writeJson('PATCH', '/shopping-notes/change-line/', shoppingNoteSchema, { body }),
    );
  }

  toggleShoppingNoteLineComplete(input: z.input<typeof shoppingNoteLineTokenInput>) {
    const body = shoppingNoteLineTokenInput.parse(input);

    return this.run(() =>
      this.writeJson('PATCH', '/shopping-notes/toggle-complete-on-line/', shoppingNoteSchema, {
        body,
      }),
    );
  }

  deleteShoppingNoteLine(input: z.input<typeof shoppingNoteLineTokenInput>) {
    const query = shoppingNoteLineTokenInput.parse(input);

    return this.run(() =>
      this.writeJson('DELETE', '/shopping-notes/delete-line/', shoppingNoteSchema, { query }),
    );
  }

  clearShoppingNote(input: z.input<typeof clearShoppingNoteInput>) {
    clearShoppingNoteInput.parse(input);

    return this.run(async () => {
      // Krónan answers 204 with no body; the note itself is kept.
      const { response } = await this.write('DELETE', '/shopping-notes/delete-shopping-note/', {});
      await response.body?.cancel().catch(() => {});

      return { cleared: true as const };
    });
  }

  previewCheckoutLines(input: z.input<typeof previewCheckoutLinesInput>) {
    const body = previewCheckoutLinesInput.parse(input);

    // Krónan documents this POST as validation only; the checkout is not modified.
    return this.run(() => this.post('/checkout/preview-lines/', body, previewResponseSchema));
  }

  setCheckoutLines(input: z.input<typeof setCheckoutLinesInput>) {
    // replace is required input, so Krónan's replace-by-default never applies.
    const body = setCheckoutLinesInput.parse(input);

    return this.run(() => this.writeJson('POST', '/checkout/lines/', checkoutSchema, { body }));
  }

  reserveDeliverySlot(input: z.input<typeof reserveDeliverySlotInput>) {
    const { expectedCheckoutToken, expectedTotal, slotId, addressId, returnBags } =
      reserveDeliverySlotInput.parse(input);

    return this.run(async () => {
      const reservation = await this.place(
        'reserve_delivery_slot',
        expectedCheckoutToken,
        () => this.verifyCheckout(expectedCheckoutToken, expectedTotal),
        () =>
          this.writeJson('POST', '/slots/delivery/reserve/', reserveResponseSchema, {
            body: { slotId, addressId, returnBags },
            unconfirmed: WRITE_UNCONFIRMED,
          }),
      );

      return reservation === null
        ? { outcome: 'unknown' as const, reservation, message: OUTCOME_UNKNOWN }
        : { outcome: 'accepted' as const, reservation, message: SLOT_RESERVED };
    });
  }

  reservePickupSlot(input: z.input<typeof reservePickupSlotInput>) {
    const { expectedCheckoutToken, expectedTotal, slotId, returnBags } =
      reservePickupSlotInput.parse(input);

    return this.run(async () => {
      const reservation = await this.place(
        'reserve_pickup_slot',
        expectedCheckoutToken,
        () => this.verifyCheckout(expectedCheckoutToken, expectedTotal),
        () =>
          this.writeJson('POST', '/slots/pickup/reserve/', reserveResponseSchema, {
            body: { slotId, returnBags },
            unconfirmed: WRITE_UNCONFIRMED,
          }),
      );

      return reservation === null
        ? { outcome: 'unknown' as const, reservation, message: OUTCOME_UNKNOWN }
        : { outcome: 'accepted' as const, reservation, message: SLOT_RESERVED };
    });
  }

  completeCheckout(input: z.input<typeof completeCheckoutInput>) {
    const { expectedCheckoutToken, expectedTotal, slotId, addressId, returnBags } =
      completeCheckoutInput.parse(input);

    return this.run(async () => {
      const order = await this.place(
        'complete_checkout',
        expectedCheckoutToken,
        () => this.verifyCheckout(expectedCheckoutToken, expectedTotal),
        () =>
          this.writeJson('POST', '/checkout/complete/', orderTokenResponseSchema, {
            body: { slotId, addressId, returnBags },
            unconfirmed: WRITE_UNCONFIRMED,
          }),
      );

      return order === null
        ? { outcome: 'unknown' as const, order, message: OUTCOME_UNKNOWN }
        : { outcome: 'accepted' as const, order, message: ORDER_PLACED };
    });
  }

  addCheckoutToOrder(input: z.input<typeof addCheckoutToOrderInput>) {
    const { expectedCheckoutToken, expectedTotal, expectedOrderToken } =
      addCheckoutToOrderInput.parse(input);

    return this.run(async () => {
      const order = await this.place(
        'add_checkout_to_order',
        expectedCheckoutToken,
        async () => {
          const checkout = await this.verifyCheckout(expectedCheckoutToken, expectedTotal);
          const { order: active } = await this.readActiveOrder();

          if (active === null) throw NO_ACTIVE_ORDER;

          if (active.orderToken !== expectedOrderToken) throw ORDER_REPLACED;

          return checkout;
        },
        // The endpoint documents no request body.
        () =>
          this.writeJson('POST', '/checkout/add-to-order/', orderTokenResponseSchema, {
            unconfirmed: WRITE_UNCONFIRMED,
          }),
      );

      return order === null
        ? { outcome: 'unknown' as const, order, message: OUTCOME_UNKNOWN }
        : { outcome: 'accepted' as const, order, message: LINES_ADDED };
    });
  }

  deleteOrderLines(input: z.input<typeof deleteOrderLinesInput>) {
    const { orderToken, lineIds } = deleteOrderLinesInput.parse(input);

    return this.run(() =>
      this.writeJson(
        'POST',
        `/orders/${encodeURIComponent(orderToken)}/delete-lines/`,
        orderSchema,
        { body: { lineIds }, unconfirmed: ORDER_CHANGE_UNCONFIRMED },
      ),
    );
  }

  lowerOrderLineQuantities(input: z.input<typeof lowerOrderLineQuantitiesInput>) {
    const { orderToken, lineIds, quantity } = lowerOrderLineQuantitiesInput.parse(input);

    return this.run(() =>
      this.writeJson(
        'POST',
        `/orders/${encodeURIComponent(orderToken)}/lower-quantity-lines/`,
        orderSchema,
        { body: { lineIds, quantity }, unconfirmed: ORDER_CHANGE_UNCONFIRMED },
      ),
    );
  }

  toggleOrderLineSubstitution(input: z.input<typeof toggleOrderLineSubstitutionInput>) {
    const { orderToken, lineIds } = toggleOrderLineSubstitutionInput.parse(input);

    return this.run(() =>
      this.writeJson(
        'POST',
        `/orders/${encodeURIComponent(orderToken)}/lines-toggle-substitution/`,
        orderSchema,
        { body: { lineIds }, unconfirmed: ORDER_CHANGE_UNCONFIRMED },
      ),
    );
  }
}
