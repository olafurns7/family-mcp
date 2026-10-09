// A copy of packages/kronan-mcp/test/integration.test.ts run against the Rust binary through the
// drop-ins in rust-kronan.ts, changed only where marked `Rust:`. Cases arrive with the tools they
// exercise.
import { afterAll, test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import manifest from '../../../../packages/kronan-mcp/package.json' with { type: 'json' };

// Rust: the fixtures are shared with parity.ts.
import {
  LIST_TOKEN,
  ORDER_TOKEN,
  UPSTREAM_EXTRA,
  fixtureResponse,
  product,
  recipe,
} from './fixtures.ts';
// Rust: the client, the schemas and the stdio executable are the binary.
import {
  KronanClient,
  categoryProductsInput,
  emptyInput,
  getProductInput,
  listOrdersInput,
  lookupProductsInput,
  offsetInput,
  orderInput,
  pageInput,
  previewCheckoutLinesInput,
  productListInput,
  productsByTagInput,
  purchaseStatsInput,
  recipeInput,
  searchProductsInput,
  searchRecipesInput,
  serveCommand,
  summarizeOrderLinesInput,
} from './rust-kronan.ts';

// Rust: `VERSION` from src/server.ts is the package version.
const VERSION = manifest.version;

const TOKEN = 'synthetic-token-0123456789';

/** Order-attempt records from this file stay in a private scratch directory. */
const SCRATCH = await mkdtemp(join(tmpdir(), 'kronan-attempts-'));

// A client built with the default attempts path, and the store and its key, must never touch
// the real configuration. CLI child processes inherit these too.
process.env.KRONAN_TOKEN_FILE = join(SCRATCH, 'default-session.json');

process.env.XDG_CONFIG_HOME = join(SCRATCH, 'config');

process.env.XDG_DATA_HOME = join(SCRATCH, 'data');

afterAll(() => rm(SCRATCH, { recursive: true, force: true }));

const scratchFile = () => join(SCRATCH, randomUUID() + '.json');

type CapturedRequest = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
};

type ContractCase = {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: string;
  body?: string;
  /** Reads the money gate sends first, as 'METHOD /path/'. */
  gate?: string[];
  call: () => Promise<object>;
};

async function captureFailure(
  messages: string[],
  run: () => Promise<object>,
  pattern: RegExp,
): Promise<void> {
  try {
    await run();
  } catch (cause) {
    assert(cause instanceof Error);
    messages.push(cause.message);
    expect(cause.message).toMatch(pattern);

    return;
  }

  assert.fail('Expected the operation to fail.');
}

function withUnexpectedKey<T extends object>(input: T) {
  return { ...input, unexpected: TOKEN };
}

test('offset pages report nextOffset from the returned item count, not the requested limit', async () => {
  const api = new KronanClient(
    async () => TOKEN,
    async () =>
      Response.json({
        count: 60,
        next: 'https://api.kronan.is/api/v1/recipes/?limit=50&offset=50',
        previous: null,
        results: [recipe, recipe],
      }),
  );

  try {
    // Upstream clamped a 100-item request to two items; the next window must start after them.
    const page = await api.recipes({ limit: 100, offset: 10 });
    expect(page).toMatchObject({
      count: 60,
      limit: 100,
      offset: 10,
      hasNextPage: true,
      nextOffset: 12,
    });
    expect(page.results).toHaveLength(2);

    const last = new KronanClient(
      async () => TOKEN,
      async () => Response.json({ count: 2, next: null, previous: null, results: [recipe] }),
    );

    expect(await last.favoriteRecipes({ offset: 1 })).toMatchObject({
      hasNextPage: false,
      nextOffset: null,
    });
    await last.close();
  } finally {
    await api.close();
  }
});

test('all public client methods use the exact published paths, parameters, bodies, and outputs', async () => {
  const requests: CapturedRequest[] = [];
  const attempts = scratchFile();

  const client = new KronanClient(
    async () => TOKEN,
    async (url, options) => {
      requests.push({
        url,
        method: options.method,
        headers: new Headers(options.headers),
        body:
          options.body === undefined || options.body === null
            ? undefined
            : await new Response(options.body).text(),
        redirect: options.redirect,
      });

      return fixtureResponse(new URL(url).pathname);
    },
    attempts,
  );

  const cases: ContractCase[] = [
    { name: 'status', method: 'GET', path: '/me/', call: () => client.status() },
    {
      name: 'searchProducts',
      method: 'POST',
      path: '/products/search/',
      body: JSON.stringify({
        query: 'milk',
        page: 1,
        pageSize: 20,
        withDetail: false,
        includePurchaseHistory: false,
      }),
      call: () => client.searchProducts({ query: 'milk' }),
    },
    {
      name: 'product by SKU',
      method: 'GET',
      path: '/products/SKU-1/',
      call: () => client.product({ sku: 'SKU-1' }),
    },
    {
      name: 'product by barcode',
      method: 'GET',
      path: '/products/barcode/12345678/',
      call: () => client.product({ barcode: '12345678' }),
    },
    {
      name: 'lookupProducts',
      method: 'POST',
      path: '/products/batch/',
      body: JSON.stringify({ skus: ['SKU-1', 'SKU-2'] }),
      call: () => client.lookupProducts({ skus: ['SKU-1', 'SKU-2'] }),
    },
    { name: 'categories', method: 'GET', path: '/categories/', call: () => client.categories() },
    {
      name: 'categoryProducts',
      method: 'GET',
      path: '/categories/dairy/products/',
      query: 'page=2',
      call: () => client.categoryProducts({ slug: 'dairy', page: 2 }),
    },
    { name: 'tags', method: 'GET', path: '/products/tags/', call: () => client.tags() },
    {
      name: 'productsByTag',
      method: 'GET',
      path: '/products/by-tag/vegan/',
      query: 'page=3',
      call: () => client.productsByTag({ slug: 'vegan', page: 3 }),
    },
    {
      name: 'productsOnSale',
      method: 'GET',
      path: '/products/on-sale/',
      query: 'page=4',
      call: () => client.productsOnSale({ page: 4 }),
    },
    {
      name: 'favoriteProducts',
      method: 'GET',
      path: '/products/favorites/',
      query: 'page=5',
      call: () => client.favoriteProducts({ page: 5 }),
    },
    {
      name: 'orders',
      method: 'GET',
      path: '/orders/',
      query: 'limit=20&offset=0&year=2025&month=8&type=delivery',
      call: () => client.orders({ year: 2025, month: 8, type: 'delivery' }),
    },
    {
      name: 'order',
      method: 'GET',
      path: '/orders/' + ORDER_TOKEN + '/',
      call: () => client.order({ token: ORDER_TOKEN }),
    },
    {
      name: 'activeOrder',
      method: 'GET',
      path: '/orders/currently-active/',
      call: () => client.activeOrder(),
    },
    {
      name: 'orderLineSummary',
      method: 'GET',
      path: '/orders/line-summary/',
      query: 'from_year=2025&from_month=1&to_year=2025&to_month=6&skus=SKU-1&skus=SKU-2',
      call: () =>
        client.orderLineSummary({
          fromYear: 2025,
          fromMonth: 1,
          toYear: 2025,
          toMonth: 6,
          skus: ['SKU-1', 'SKU-2'],
        }),
    },
    {
      name: 'orderLineSummary name filter',
      method: 'GET',
      path: '/orders/line-summary/',
      query: 'name_contains=milk',
      call: () => client.orderLineSummary({ nameContains: 'milk' }),
    },
    {
      name: 'purchaseStats',
      method: 'GET',
      path: '/product-purchase-stats/',
      query: 'limit=7&offset=3&sort=most_quantity&include_ignored=true',
      call: () =>
        client.purchaseStats({ limit: 7, offset: 3, sort: 'most_quantity', includeIgnored: true }),
    },
    {
      name: 'shoppingNote',
      method: 'GET',
      path: '/shopping-notes/',
      call: () => client.shoppingNote(),
    },
    {
      name: 'archivedShoppingNoteLines',
      method: 'GET',
      path: '/shopping-notes/lines-archived/',
      call: () => client.archivedShoppingNoteLines(),
    },
    {
      name: 'productLists',
      method: 'GET',
      path: '/product-lists/',
      query: 'limit=20&offset=0',
      call: () => client.productLists(),
    },
    {
      name: 'productList',
      method: 'GET',
      path: '/product-lists/' + LIST_TOKEN + '/',
      call: () => client.productList({ token: LIST_TOKEN }),
    },
    {
      name: 'recipes',
      method: 'GET',
      path: '/recipes/',
      query: 'limit=20&offset=0',
      call: () => client.recipes(),
    },
    {
      name: 'searchRecipes',
      method: 'POST',
      path: '/recipes/search/',
      body: JSON.stringify({
        query: 'oats',
        tags: [1],
        ingredientTags: [],
        cuisineTags: [],
        occasionTags: [],
        page: 1,
        orderBy: 'default',
      }),
      call: () => client.searchRecipes({ query: 'oats', tags: [1] }),
    },
    {
      name: 'recipe',
      method: 'GET',
      path: '/recipes/oat-cakes/',
      call: () => client.recipe({ slug: 'oat-cakes' }),
    },
    {
      name: 'favoriteRecipes',
      method: 'GET',
      path: '/recipes/favorites/',
      query: 'limit=20&offset=0',
      call: () => client.favoriteRecipes(),
    },
    {
      name: 'addresses',
      method: 'GET',
      path: '/addresses/',
      call: () => client.addresses(),
    },
    {
      name: 'deliverySlots',
      method: 'POST',
      path: '/slots/delivery/',
      body: JSON.stringify({ addressId: 11 }),
      call: () => client.deliverySlots({ addressId: 11 }),
    },
    {
      name: 'pickupSlots',
      method: 'POST',
      path: '/slots/pickup/',
      body: JSON.stringify({ chain: 'pikkolo' }),
      call: () => client.pickupSlots({ chain: 'pikkolo' }),
    },
    {
      name: 'checkout',
      method: 'GET',
      path: '/checkout/',
      call: () => client.checkout(),
    },
    {
      name: 'previewCheckoutLines',
      method: 'POST',
      path: '/checkout/preview-lines/',
      body: JSON.stringify({
        lines: [
          { sku: 'SKU-1', quantity: 2 },
          { sku: 'SKU-2', quantity: 1 },
        ],
      }),
      call: () =>
        client.previewCheckoutLines({ lines: [{ sku: 'SKU-1', quantity: 2 }, { sku: 'SKU-2' }] }),
    },
    // Rust: the write and order cases arrive with their tools.
  ];

  try {
    for (const item of cases) {
      // Each money case is its own approval; the attempts rules have their own tests.
      await rm(attempts, { force: true });
      const before = requests.length;
      const output = await item.call();
      const sent = requests.slice(before);
      const request = sent.at(-1);
      assert(request);

      // Exactly one request per call beyond the documented gate reads; nothing is retried.
      expect(
        sent.map(
          (entry) => entry.method + ' ' + new URL(entry.url).pathname.slice('/api/v1'.length),
        ),
        item.name,
      ).toEqual([...(item.gate ?? []), item.method + ' ' + item.path]);

      expect(request.url).toBe(
        'https://api.kronan.is/api/v1' +
          item.path +
          (item.query === undefined ? '' : '?' + item.query),
      );
      expect(request.method).toBe(item.method);
      expect(request.headers.get('authorization')).toBe('AccessToken ' + TOKEN);
      expect(request.headers.get('accept')).toBe('application/json');
      expect(request.headers.get('content-type')).toBe(
        item.body === undefined ? null : 'application/json',
      );
      expect(request.redirect).toBe('error');
      expect(request.body).toBe(item.body);
      expect(JSON.stringify(output)).not.toContain(UPSTREAM_EXTRA);
    }
  } finally {
    await client.close();
  }
});

test('safe errors, strict inputs, and token non-disclosure', async () => {
  const errors: string[] = [];
  let response = new Response(TOKEN, { status: 401 });

  const client = new KronanClient(
    async () => TOKEN,
    async () => response,
  );

  try {
    await captureFailure(errors, () => client.status(), /Krónan rejected the access token/);
    response = new Response(TOKEN, { status: 403 });
    await captureFailure(errors, () => client.status(), /Krónan denied this request/);
    response = new Response(TOKEN, { status: 429 });
    await captureFailure(errors, () => client.status(), /Krónan rate limit reached/);

    const notFound = [
      () => client.product({ sku: 'SKU-1' }),
      () => client.order({ token: ORDER_TOKEN }),
      () => client.categoryProducts({ slug: 'dairy' }),
      () => client.productsByTag({ slug: 'vegan' }),
      () => client.productList({ token: LIST_TOKEN }),
      () => client.recipe({ slug: 'oat-cakes' }),
    ];

    const notFoundMessages = [
      /Product not found/,
      /Order not found/,
      /Category not found/,
      /Tag not found/,
      /Product list not found/,
      /Recipe not found/,
    ];

    for (const [index, run] of notFound.entries()) {
      response = new Response(TOKEN, { status: 404 });
      const pattern = notFoundMessages[index];
      assert(pattern);
      await captureFailure(errors, run, pattern);
    }

    response = new Response(null, { status: 404 });
    expect(await client.activeOrder()).toEqual({ active: false, order: null });

    response = new Response(TOKEN, { status: 500 });
    await captureFailure(errors, () => client.status(), /Krónan returned an error/);
    response = new Response(TOKEN, { status: 200 });
    await captureFailure(errors, () => client.status(), /Krónan returned an invalid API response/);
    response = Response.json({ type: 'user', upstreamOnly: TOKEN });
    await captureFailure(errors, () => client.status(), /outside the documented schema/);

    response = Response.json({ type: 'user', name: 'Account' });
    await captureFailure(errors, () => client.product({}), /Provide exactly one of sku or barcode/);
    await captureFailure(
      errors,
      () => client.product({ sku: 'SKU-1', barcode: '12345678' }),
      /Provide exactly one of sku or barcode/,
    );
    await captureFailure(errors, () => client.orders({ year: 2025 }), /year and month together/);
    await captureFailure(
      errors,
      () => client.orderLineSummary({ fromYear: 2025, nameContains: 'milk' }),
      /fromYear, fromMonth, toYear, and toMonth together/,
    );
    await captureFailure(
      errors,
      () => client.orderLineSummary({ nameContains: 'milk', skus: ['SKU-1'] }),
      /exactly one of nameContains or skus/,
    );
    await captureFailure(
      errors,
      () => client.orderLineSummary({}),
      /exactly one of nameContains or skus/,
    );

    // Rust: the binary validates, so each result is awaited.
    const strictResults = await Promise.all([
      emptyInput.safeParse(withUnexpectedKey({})),
      searchProductsInput.safeParse(withUnexpectedKey({ query: 'milk' })),
      getProductInput.safeParse(withUnexpectedKey({ sku: 'SKU-1' })),
      lookupProductsInput.safeParse(withUnexpectedKey({ skus: ['SKU-1'] })),
      categoryProductsInput.safeParse(withUnexpectedKey({ slug: 'dairy' })),
      productsByTagInput.safeParse(withUnexpectedKey({ slug: 'vegan' })),
      pageInput.safeParse(withUnexpectedKey({})),
      listOrdersInput.safeParse(withUnexpectedKey({})),
      orderInput.safeParse(withUnexpectedKey({ token: ORDER_TOKEN })),
      summarizeOrderLinesInput.safeParse(withUnexpectedKey({ nameContains: 'milk' })),
      purchaseStatsInput.safeParse(withUnexpectedKey({})),
      offsetInput.safeParse(withUnexpectedKey({})),
      productListInput.safeParse(withUnexpectedKey({ token: LIST_TOKEN })),
      searchRecipesInput.safeParse(withUnexpectedKey({})),
      recipeInput.safeParse(withUnexpectedKey({ slug: 'oat-cakes' })),
      previewCheckoutLinesInput.safeParse(withUnexpectedKey({ lines: [{ sku: 'SKU-1' }] })),
      // Rust: the write and order inputs arrive with their tools.
    ]);

    for (const result of strictResults) {
      if (result.success) assert.fail('An input accepted an unknown key.');
      expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
      errors.push(result.error.message);
    }

    expect((await getProductInput.safeParse({})).success).toBe(false);
    expect((await getProductInput.safeParse({ sku: 'SKU-1', barcode: '12345678' })).success).toBe(false);
    expect((await listOrdersInput.safeParse({ year: 2025 })).success).toBe(false);
    expect(
      (await summarizeOrderLinesInput.safeParse({ fromYear: 2025, nameContains: 'milk' })).success,
    ).toBe(false);
    expect(
      (await summarizeOrderLinesInput.safeParse({ nameContains: 'milk', skus: ['SKU-1'] })).success,
    ).toBe(false);
    expect((await summarizeOrderLinesInput.safeParse({})).success).toBe(false);
    expect(errors.join('\n')).not.toMatch(new RegExp(TOKEN));
  } finally {
    await client.close();
  }
});

test('nested nutrition data is rejected and leading-punctuation slugs reach Krónan encoded', async () => {
  const NESTED_MARKER = 'nested-upstream-marker-7c1f';
  const requested: string[] = [];

  const api = new KronanClient(
    async () => TOKEN,
    async (url) => {
      const { pathname } = new URL(url);
      requested.push(pathname);

      if (pathname === '/api/v1/products/SKU-1/')
        return Response.json({ ...product, nutrition: { energy: { marker: NESTED_MARKER } } });

      if (pathname === '/api/v1/products/batch/')
        return Response.json({
          results: [{ ...product, nutrition: { list: [NESTED_MARKER] } }],
          missingSkus: [],
        });

      if (pathname === '/api/v1/categories/_dairy/products/')
        return fixtureResponse('/api/v1/categories/dairy/products/');

      if (pathname === '/api/v1/recipes/-recipe/' || pathname === '/api/v1/recipes/mj%C3%B3lk/')
        return fixtureResponse('/api/v1/recipes/oat-cakes/');

      return new Response(null, { status: 404 });
    },
  );

  try {
    const messages: string[] = [];
    await captureFailure(
      messages,
      () => api.product({ sku: 'SKU-1' }),
      /outside the documented schema/,
    );
    await captureFailure(
      messages,
      () => api.lookupProducts({ skus: ['SKU-1'] }),
      /outside the documented schema/,
    );
    expect(messages.join('\n')).not.toContain(NESTED_MARKER);

    const flat = new KronanClient(
      async () => TOKEN,
      async () =>
        Response.json({ ...product, nutrition: { energy: '100 kcal', fat: 2.5, salt: null } }),
    );

    expect((await flat.product({ sku: 'SKU-1' })).nutrition).toEqual({
      energy: '100 kcal',
      fat: 2.5,
      salt: null,
    });
    await flat.close();

    expect((await api.categoryProducts({ slug: '_dairy' })).name).toBe('Dairy');
    expect((await api.recipe({ slug: '-recipe' })).slug).toBe('oat-cakes');
    expect((await api.recipe({ slug: 'mjólk' })).slug).toBe('oat-cakes');
    expect(requested.slice(-3)).toEqual([
      '/api/v1/categories/_dairy/products/',
      '/api/v1/recipes/-recipe/',
      '/api/v1/recipes/mj%C3%B3lk/',
    ]);
    expect((await categoryProductsInput.safeParse({ slug: 'a/b' })).success).toBe(false);
    expect((await recipeInput.safeParse({ slug: '../x' })).success).toBe(false);

    // Bare dot segments would be collapsed by URL parsing into a different endpoint.
    for (const segment of ['.', '..']) {
      expect((await recipeInput.safeParse({ slug: segment })).success).toBe(false);
      expect((await categoryProductsInput.safeParse({ slug: segment })).success).toBe(false);
      expect((await getProductInput.safeParse({ sku: segment })).success).toBe(false);
      expect((await lookupProductsInput.safeParse({ skus: [segment] })).success).toBe(false);
    }

    expect((await getProductInput.safeParse({ sku: 'a.b' })).success).toBe(true);
  } finally {
    await api.close();
  }
});

test('stdio executable reports a missing token through MCP without stderr noise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kronan-stdio-'));
  const client = new Client({ name: 'kronan-stdio', version: VERSION });
  let stderr = '';

  // Rust: the stdio executable is the binary.
  const transport = new StdioClientTransport({
    ...serveCommand(),
    cwd: resolve('.'),
    env: {
      ...process.env,
      KRONAN_TOKEN_FILE: join(directory, 'missing.json'),
      XDG_CONFIG_HOME: join(directory, 'config'),
    },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'auth_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('No saved Krónan access token');
    await client.close();
    expect(stderr).toBe('');
  } finally {
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
