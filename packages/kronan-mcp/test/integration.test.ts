import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import manifest from '../package.json' with { type: 'json' };
import { KronanClient } from '../src/api.js';
import { loadToken, normalizeToken, removeToken, saveToken } from '../src/auth.js';
import {
  categoryProductsInput,
  emptyInput,
  getProductInput,
  listOrdersInput,
  lookupProductsInput,
  offsetInput,
  orderInput,
  pageInput,
  productListInput,
  productsByTagInput,
  purchaseStatsInput,
  recipeInput,
  searchProductsInput,
  searchRecipesInput,
  summarizeOrderLinesInput,
} from '../src/schemas.js';
import { createServer, VERSION } from '../src/server.js';

const TOKEN = 'synthetic-token-0123456789';

const UPSTREAM_EXTRA = 'remove-this-unpublished-field';

const ORDER_TOKEN = '123e4567-e89b-12d3-a456-426614174001';

const LIST_TOKEN = '123e4567-e89b-12d3-a456-426614174002';

const product = {
  sku: 'SKU-1',
  name: 'Synthetic milk',
  thumbnail: 'https://images.example/product.jpg',
  price: 499,
  discountedPrice: 450,
  discountPercent: 10,
  onSale: true,
  priceInfo: null,
  chargedByWeight: false,
  pricePerKilo: 499,
  baseComparisonUnit: 'L',
  temporaryShortage: false,
  categoryPath: 'dairy',
  brand: 'Test brand',
  description: 'Offline fixture',
  image: 'https://images.example/product.jpg',
  qtyPerBaseCompUnit: 1,
  qtyInSalesUnit: 1,
  countryOfOrigin: 'Iceland',
  tags: [{ slug: 'dairy', name: 'Dairy', upstreamOnly: UPSTREAM_EXTRA }],
  nutrition: { energy: 1 },
  upstreamOnly: UPSTREAM_EXTRA,
};

const productPage = {
  count: 1,
  page: 1,
  pageCount: 1,
  hasNextPage: false,
  results: [{ ...product, upstreamOnly: UPSTREAM_EXTRA }],
  upstreamOnly: UPSTREAM_EXTRA,
};

const searchResult = {
  count: 1,
  page: 1,
  pageCount: 1,
  hasNextPage: false,
  hits: [
    {
      sku: product.sku,
      name: product.name,
      price: product.price,
      thumbnail: product.thumbnail,
      temporaryShortage: false,
      priceInfo: null,
      chargedByWeight: false,
      pricePerKilo: 499,
      baseComparisonUnit: 'L',
      detail: {
        discountedPrice: 450,
        discountPercent: 10,
        onSale: true,
        qtyInSalesUnit: 1,
        tags: [{ slug: 'dairy', name: 'Dairy', upstreamOnly: UPSTREAM_EXTRA }],
        upstreamOnly: UPSTREAM_EXTRA,
      },
      purchaseHistory: {
        purchaseCount: 3,
        averagePurchaseQuantity: 1,
        lastPurchaseDate: '2026-09-01',
        upstreamOnly: UPSTREAM_EXTRA,
      },
      upstreamOnly: UPSTREAM_EXTRA,
    },
  ],
  upstreamOnly: UPSTREAM_EXTRA,
};

const categoryTree = [
  {
    slug: 'dairy',
    name: 'Dairy',
    backgroundImage: null,
    icon: null,
    children: [
      {
        slug: 'fresh',
        name: 'Fresh',
        children: [{ slug: 'milk', name: 'Milk', upstreamOnly: UPSTREAM_EXTRA }],
        upstreamOnly: UPSTREAM_EXTRA,
      },
    ],
    upstreamOnly: UPSTREAM_EXTRA,
  },
];

const deliveryInfo = {
  timeStart: null,
  timeStop: null,
  status: null,
  statusDisplay: null,
  eta: null,
  address: null,
  upstreamOnly: UPSTREAM_EXTRA,
};

const orderSummary = {
  token: ORDER_TOKEN,
  created: '2026-09-01T12:00:00Z',
  displayDate: '2026-09-01',
  status: 'fulfilled',
  type: 'delivery',
  total: 499,
  discount: 0,
  deliveryDate: null,
  allowAlterOrderLines: false,
  deliveryInfo,
  upstreamOnly: UPSTREAM_EXTRA,
};

const order = {
  ...orderSummary,
  lines: [
    {
      id: 1,
      productName: product.name,
      sku: product.sku,
      quantity: 1,
      quantityOrdered: 1,
      unitPrice: 499,
      substitution: false,
      substitutionForLineId: null,
      isMutable: false,
      isLastChance: false,
      thumbnail: product.thumbnail,
      total: 499,
      upstreamOnly: UPSTREAM_EXTRA,
    },
  ],
  upstreamOnly: UPSTREAM_EXTRA,
};

const activeOrder = {
  orderToken: ORDER_TOKEN,
  type: 'delivery',
  deliveryDate: null,
  timeStart: null,
  timeStop: null,
  address: null,
  store: null,
  lines: [
    {
      sku: product.sku,
      name: product.name,
      quantity: 2,
      unitPrice: 499,
      upstreamOnly: UPSTREAM_EXTRA,
    },
  ],
  subtotal: 998,
  shippingFee: 0,
  serviceFee: 0,
  bagFee: 0,
  total: 0,
  freeShippingCutoff: 0,
  neededForFreeShipping: 0,
  allowAdditionalOrderLinesUntil: null,
  authorizedAmount: 0,
  capturedAmount: 0,
  upstreamOnly: UPSTREAM_EXTRA,
};

const lineSummary = {
  nameContains: null,
  skus: [product.sku],
  fromYear: 2025,
  fromMonth: 1,
  toYear: 2025,
  toMonth: 6,
  asOfDate: '2025-06-30',
  totalAmount: 0,
  totalQuantity: 0,
  orderCount: 0,
  months: [],
  matchedProductCount: 0,
  matchedProducts: [],
  upstreamOnly: UPSTREAM_EXTRA,
};

const recipe = {
  token: '123e4567-e89b-12d3-a456-426614174003',
  name: 'Oat cakes',
  displayName: 'Oat cakes',
  slug: 'oat-cakes',
  isFeatured: false,
  preparationMinutes: 5,
  cookingMinutes: 10,
  totalMinutes: 15,
  servings: 2,
  difficulty: null,
  mainImage: null,
  tags: [],
  ingredientTags: [],
  cuisineTags: [],
  occasionTags: [],
  favorited: false,
  hasVideo: false,
  upstreamOnly: UPSTREAM_EXTRA,
};

function fixtureResponse(pathname: string): Response {
  switch (pathname) {
    case '/api/v1/me/':
      return Response.json({
        type: 'user',
        name: 'Synthetic account',
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/products/search/':
      return Response.json(searchResult);
    case '/api/v1/products/SKU-1/':
    case '/api/v1/products/barcode/12345678/':
      return Response.json(product);
    case '/api/v1/products/batch/':
      return Response.json({
        results: [product],
        missingSkus: [],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/categories/':
      return Response.json(categoryTree);
    case '/api/v1/categories/dairy/products/':
      return Response.json({
        name: 'Dairy',
        count: 1,
        page: 1,
        pageCount: 1,
        hasNextPage: false,
        products: [product],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/products/tags/':
      return Response.json([{ slug: 'dairy', name: 'Dairy', upstreamOnly: UPSTREAM_EXTRA }]);
    case '/api/v1/products/by-tag/vegan/':
    case '/api/v1/products/on-sale/':
    case '/api/v1/products/favorites/':
      return Response.json(productPage);
    case '/api/v1/orders/':
      return Response.json({
        count: 1,
        next: null,
        previous: null,
        results: [orderSummary],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/orders/' + ORDER_TOKEN + '/':
      return Response.json(order);
    case '/api/v1/orders/currently-active/':
      return Response.json(activeOrder);
    case '/api/v1/orders/line-summary/':
      return Response.json(lineSummary);
    case '/api/v1/product-purchase-stats/':
      return Response.json({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 1, product, purchaseCount: 3, upstreamOnly: UPSTREAM_EXTRA }],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/shopping-notes/':
      return Response.json({
        token: '123e4567-e89b-12d3-a456-426614174004',
        name: 'Shopping note',
        lines: [
          {
            token: '123e4567-e89b-12d3-a456-426614174007',
            text: 'Milk',
            quantity: 1,
            product: { sku: product.sku, name: product.name, description: '', thumbnail: null },
            placement: 0,
            isCompleted: false,
            upstreamOnly: UPSTREAM_EXTRA,
          },
        ],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/shopping-notes/lines-archived/':
      return Response.json([
        {
          token: '123e4567-e89b-12d3-a456-426614174005',
          text: 'Milk',
          completedCount: 1,
          upstreamOnly: UPSTREAM_EXTRA,
        },
      ]);
    case '/api/v1/product-lists/':
      return Response.json({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 1,
            name: 'Weekly',
            token: LIST_TOKEN,
            description: 'Offline list',
            hasProducts: true,
            upstreamOnly: UPSTREAM_EXTRA,
          },
        ],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/product-lists/' + LIST_TOKEN + '/':
      return Response.json({
        id: 1,
        name: 'Weekly',
        token: LIST_TOKEN,
        description: 'Offline list',
        items: [],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/recipes/':
      return Response.json({
        count: 1,
        next: null,
        previous: null,
        results: [recipe],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/recipes/search/':
      return Response.json({
        count: 1,
        page: 1,
        pageCount: 1,
        hasNextPage: false,
        recipes: [recipe],
        availableTags: { tags: [], ingredientTags: [], cuisineTags: [], occasionTags: [] },
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/recipes/oat-cakes/':
      return Response.json({
        ...recipe,
        directions: 'Mix and bake.',
        ingredients: 'Oats',
        videoUrl: null,
        items: [],
        essentials: [],
        recommendations: [],
        images: [],
        directionSteps: [],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/recipes/favorites/':
      return Response.json({
        count: 1,
        next: null,
        previous: null,
        results: [recipe],
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/addresses/':
      return Response.json([
        {
          id: 11,
          streetAddress1: 'Testgata 1',
          city: 'Reykjavík',
          postalCode: '101',
          comment: '',
          lat: 64.1,
          lng: -21.9,
          dropoffOutside: false,
          isDefaultShipping: true,
          upstreamOnly: UPSTREAM_EXTRA,
        },
      ]);
    case '/api/v1/slots/delivery/':
      return Response.json([
        {
          day: '2026-09-17',
          slots: [
            {
              slotId: 501,
              timeStart: '10:00',
              timeStop: '12:00',
              availabilityStatus: 3,
              upstreamOnly: UPSTREAM_EXTRA,
            },
          ],
          upstreamOnly: UPSTREAM_EXTRA,
        },
      ]);
    case '/api/v1/slots/pickup/':
      return Response.json([
        {
          storeName: 'Krónan Test',
          storeChain: 'kronan',
          days: [
            {
              day: '2026-09-17',
              slots: [
                { slotId: 601, timeStart: '14:00', timeStop: '15:00', availabilityStatus: -1 },
              ],
            },
          ],
          upstreamOnly: UPSTREAM_EXTRA,
        },
      ]);
    case '/api/v1/checkout/':
      return Response.json({
        token: '123e4567-e89b-12d3-a456-426614174006',
        lines: [
          {
            id: 7,
            quantity: 1,
            product: { ...product, upstreamOnly: UPSTREAM_EXTRA },
            total: 499,
            price: 499,
            substitution: true,
            upstreamOnly: UPSTREAM_EXTRA,
          },
        ],
        total: 0,
        subtotal: 0,
        baggingFee: 0,
        serviceFee: 0,
        shippingFee: 0,
        shippingFeeCutoff: 0,
        upstreamOnly: UPSTREAM_EXTRA,
      });
    default:
      return new Response('Unexpected offline fixture path.', { status: 404 });
  }
}

type CapturedRequest = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
};

type ContractCase = {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  query?: string;
  body?: string;
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

test('oversized token files and standard input are rejected with a size message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kronan-size-'));

  try {
    const huge = join(directory, 'huge.json');
    await writeFile(huge, JSON.stringify({ version: 1, token: 'x'.repeat(20_000) }), {
      mode: 0o600,
    });
    await chmod(huge, 0o600);
    await assert.rejects(loadToken(huge), /too large to be a token file/);

    const oversized = await runCli(['auth', 'set', '-'], {
      tokenFile: join(directory, 'saved.json'),
      input: 'y'.repeat(20_000),
    });

    expect(oversized.exitCode).toBe(1);
    expect(oversized.stderr).toMatch(/too large to hold one access token/);
    await assert.rejects(stat(join(directory, 'saved.json')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('private token file permissions, parsing, normalization, and removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kronan-token-test-'));
  const path = join(directory, 'session.json');
  const loosePath = join(directory, 'loose.json');
  const linkPath = join(directory, 'link.json');
  const invalidPath = join(directory, 'invalid.json');

  try {
    await saveToken(path, TOKEN);
    expect(await loadToken(path)).toBe(TOKEN);
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify({ version: 1, token: TOKEN }) + '\n');

    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await writeFile(loosePath, JSON.stringify({ version: 1, token: TOKEN }), { mode: 0o644 });
      await chmod(loosePath, 0o644);
      await assert.rejects(loadToken(loosePath), /Cannot read the Krónan token file/);
      await symlink(path, linkPath);
      await assert.rejects(loadToken(linkPath), /Cannot read the Krónan token file/);
    }

    await writeFile(invalidPath, '{"version":2,"token":"synthetic-token-0123456789"}', {
      mode: 0o600,
    });
    await assert.rejects(loadToken(invalidPath), /Invalid Krónan token file/);
    await assert.rejects(
      loadToken(join(directory, 'missing.json')),
      /No saved Krónan access token/,
    );

    expect(normalizeToken('  ' + TOKEN + ' \n')).toBe(TOKEN);
    expect(() => normalizeToken('')).toThrow(/Invalid Krónan access token/);
    expect(() => normalizeToken('short')).toThrow(/Invalid Krónan access token/);
    expect(() => normalizeToken('synthetic\r\ntoken')).toThrow(/Invalid Krónan access token/);
    expect(() => normalizeToken('synthetic-tökén')).toThrow(/Invalid Krónan access token/);
    expect(() => normalizeToken('x'.repeat(4097))).toThrow(/Invalid Krónan access token/);

    await removeToken(join(directory, 'already-missing.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all public client methods use the exact published paths, parameters, bodies, and outputs', async () => {
  const requests: CapturedRequest[] = [];

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
  ];

  try {
    for (const item of cases) {
      const output = await item.call();
      const request = requests.at(-1);
      assert(request);

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

    expect(requests).toHaveLength(cases.length);
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

    const strictResults = [
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
    ];

    for (const result of strictResults) {
      if (result.success) assert.fail('An input accepted an unknown key.');
      expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
      errors.push(result.error.message);
    }

    expect(getProductInput.safeParse({}).success).toBe(false);
    expect(getProductInput.safeParse({ sku: 'SKU-1', barcode: '12345678' }).success).toBe(false);
    expect(listOrdersInput.safeParse({ year: 2025 }).success).toBe(false);
    expect(
      summarizeOrderLinesInput.safeParse({ fromYear: 2025, nameContains: 'milk' }).success,
    ).toBe(false);
    expect(
      summarizeOrderLinesInput.safeParse({ nameContains: 'milk', skus: ['SKU-1'] }).success,
    ).toBe(false);
    expect(summarizeOrderLinesInput.safeParse({}).success).toBe(false);
    expect(errors.join('\n')).not.toMatch(new RegExp(TOKEN));
  } finally {
    await client.close();
  }
});

const AUTO_CREATING_TOOLS = new Set(['get_checkout', 'get_shopping_note']);

const toolArguments = {
  auth_status: {},
  search_products: { query: 'milk' },
  get_product: { sku: 'SKU-1' },
  lookup_products: { skus: ['SKU-1'] },
  list_categories: {},
  list_category_products: { slug: 'dairy' },
  list_product_tags: {},
  list_products_by_tag: { slug: 'vegan' },
  list_products_on_sale: {},
  list_favorite_products: {},
  list_orders: {},
  get_order: { token: ORDER_TOKEN },
  get_active_order: {},
  summarize_order_lines: { skus: ['SKU-1'] },
  list_purchase_stats: {},
  get_shopping_note: {},
  list_archived_shopping_note_lines: {},
  list_product_lists: {},
  get_product_list: { token: LIST_TOKEN },
  list_recipes: {},
  search_recipes: {},
  get_recipe: { slug: 'oat-cakes' },
  list_favorite_recipes: {},
  list_addresses: {},
  get_delivery_slots: { addressId: 11 },
  get_pickup_slots: {},
  get_checkout: {},
} satisfies Record<string, Record<string, string | number | string[]>>;

test('all 27 MCP tools declare honest annotations and round-trip strict validated results', async () => {
  const api = new KronanClient(
    async () => TOKEN,
    async (url) => fixtureResponse(new URL(url).pathname),
  );

  const server = createServer(api);
  const client = new Client({ name: 'kronan-roundtrip', version: VERSION });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).toSorted();

    expect(names).toEqual(manifest.familyMcp.release.tools.toSorted());
    expect(names).toEqual(Object.keys(toolArguments).toSorted());
    expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);

    for (const tool of listed.tools) {
      // Krónan creates an empty checkout or note on first read; those two must not claim read-only.
      expect(tool.annotations?.readOnlyHint).toBe(!AUTO_CREATING_TOOLS.has(tool.name));
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
    }

    const results = [];

    for (const [name, args] of Object.entries(toolArguments)) {
      const outcome = await client.callTool({ name, arguments: args });

      expect(outcome.isError, name).not.toBe(true);
      expect(outcome.structuredContent, name).toBeDefined();
      results.push(outcome);
    }

    const invalid = await client.callTool({
      name: 'search_products',
      arguments: { query: 'milk', unexpected: TOKEN },
    });

    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    const transcript = JSON.stringify([listed, results, invalid]);
    expect(transcript).not.toContain(TOKEN);
    expect(transcript).not.toContain(UPSTREAM_EXTRA);
  } finally {
    await client.close();
    await server.close();
    await api.close();
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
    expect(categoryProductsInput.safeParse({ slug: 'a/b' }).success).toBe(false);
    expect(recipeInput.safeParse({ slug: '../x' }).success).toBe(false);

    // Bare dot segments would be collapsed by URL parsing into a different endpoint.
    for (const segment of ['.', '..']) {
      expect(recipeInput.safeParse({ slug: segment }).success).toBe(false);
      expect(categoryProductsInput.safeParse({ slug: segment }).success).toBe(false);
      expect(getProductInput.safeParse({ sku: segment }).success).toBe(false);
      expect(lookupProductsInput.safeParse({ skus: [segment] }).success).toBe(false);
    }

    expect(getProductInput.safeParse({ sku: 'a.b' }).success).toBe(true);
  } finally {
    await api.close();
  }
});

test('stdio executable reports a missing token through MCP without stderr noise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kronan-stdio-'));
  const client = new Client({ name: 'kronan-stdio', version: VERSION });
  let stderr = '';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/cli.ts'],
    cwd: resolve('.'),
    env: { ...process.env, KRONAN_TOKEN_FILE: join(directory, 'missing.json') },
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

type CliOptions = {
  tokenFile: string;
  preloadFile?: string;
  recordFile?: string;
  status?: string;
  input?: string;
};

async function runCli(args: string[], options: CliOptions) {
  const command = [process.execPath];

  if (options.preloadFile) command.push('--preload', options.preloadFile);
  command.push('src/cli.ts', ...args);

  const child = Bun.spawn(command, {
    cwd: resolve('.'),
    env: {
      ...process.env,
      KRONAN_TOKEN_FILE: options.tokenFile,
      KRONAN_PRELOAD_RECORD: options.recordFile,
      KRONAN_PRELOAD_STATUS: options.status ?? '200',
    },
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (options.input !== undefined) {
    await child.stdin?.write(options.input);
    await child.stdin?.end();
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

test('CLI token setup, status, logout, help, version, and unknown commands stay offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kronan-cli-'));
  const preload = join(directory, 'mock-fetch.js');
  const source = join(directory, 'token.txt');
  const saved = join(directory, 'saved.json');
  const fileRecord = join(directory, 'file-request.json');
  const stdinSaved = join(directory, 'stdin.json');
  const stdinRecord = join(directory, 'stdin-request.json');
  const rejected = join(directory, 'rejected.json');
  const rejectedRecord = join(directory, 'rejected-request.json');
  const invalid = join(directory, 'invalid.json');
  const invalidRecord = join(directory, 'invalid-request.json');

  const sourceText = [
    "import { writeFile } from 'node:fs/promises';",
    'globalThis.fetch = async (input, init) => {',
    '  const recordPath = process.env.KRONAN_PRELOAD_RECORD;',
    "  if (!recordPath) throw new Error('Missing local request record path.');",
    '  const request = {',
    '    url: String(input),',
    '    authorization: new Headers(init?.headers).get("authorization"),',
    '  };',
    '  await writeFile(recordPath, JSON.stringify(request), { mode: 0o600 });',
    "  if (process.env.KRONAN_PRELOAD_STATUS === '401')",
    "    return new Response('synthetic-token rejected', { status: 401 });",
    "  return Response.json({ type: 'user', name: 'Test' });",
    '};',
    '',
  ].join('\n');

  try {
    await writeFile(preload, sourceText, { mode: 0o600 });
    await writeFile(source, '  ' + TOKEN + ' \n', { mode: 0o600 });

    const fromFile = await runCli(['auth', 'set', source], {
      tokenFile: saved,
      preloadFile: preload,
      recordFile: fileRecord,
    });

    expect(fromFile.exitCode).toBe(0);
    expect(fromFile.stderr).toBe('');
    expect(await loadToken(saved)).toBe(TOKEN);
    expect(await readFile(saved, 'utf8')).toBe(JSON.stringify({ version: 1, token: TOKEN }) + '\n');

    if (process.platform !== 'win32') expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(await readFile(fileRecord, 'utf8')).toBe(
      JSON.stringify({
        url: 'https://api.kronan.is/api/v1/me/',
        authorization: 'AccessToken ' + TOKEN,
      }),
    );

    const fromStdin = await runCli(['auth', 'set', '-'], {
      tokenFile: stdinSaved,
      preloadFile: preload,
      recordFile: stdinRecord,
      input: TOKEN + '\n',
    });

    expect(fromStdin.exitCode).toBe(0);
    expect(await loadToken(stdinSaved)).toBe(TOKEN);
    expect(await readFile(stdinSaved, 'utf8')).toBe(
      JSON.stringify({ version: 1, token: TOKEN }) + '\n',
    );

    if (process.platform !== 'win32') expect((await stat(stdinSaved)).mode & 0o777).toBe(0o600);
    expect(await readFile(stdinRecord, 'utf8')).toBe(
      JSON.stringify({
        url: 'https://api.kronan.is/api/v1/me/',
        authorization: 'AccessToken ' + TOKEN,
      }),
    );

    const rejectedSet = await runCli(['auth', 'set', source], {
      tokenFile: rejected,
      preloadFile: preload,
      recordFile: rejectedRecord,
      status: '401',
    });

    expect(rejectedSet.exitCode).toBe(1);
    expect(rejectedSet.stderr).toMatch(/Krónan rejected the access token/);
    expect(rejectedSet.stderr).not.toContain(TOKEN);
    await assert.rejects(stat(rejected), { code: 'ENOENT' });

    const sharedSource = join(directory, 'shared-token.txt');
    await writeFile(sharedSource, TOKEN + '\n', { mode: 0o644 });
    // writeFile's mode is masked by umask; the fixture must be group-readable regardless.
    await chmod(sharedSource, 0o644);
    const linkedSource = join(directory, 'linked-token.txt');
    await symlink(source, linkedSource);

    for (const [unsafeSource, pattern] of [
      [sharedSource, /Cannot read the token source file/],
      [linkedSource, /Cannot read the token source file/],
      [join(directory, 'absent-token.txt'), /token source file does not exist/],
    ] as const) {
      const unsafeSaved = join(directory, 'unsafe.json');
      const unsafeRecord = join(directory, 'unsafe-request.json');

      const unsafeSet = await runCli(['auth', 'set', unsafeSource], {
        tokenFile: unsafeSaved,
        preloadFile: preload,
        recordFile: unsafeRecord,
      });

      // A group-readable or linked source is itself a leaked credential; nothing is sent or saved.
      expect(unsafeSet.exitCode).toBe(1);
      expect(unsafeSet.stderr).toMatch(pattern);
      expect(unsafeSet.stderr).not.toContain(TOKEN);
      await assert.rejects(stat(unsafeSaved), { code: 'ENOENT' });
      await assert.rejects(stat(unsafeRecord), { code: 'ENOENT' });
    }

    await writeFile(source, 'short\n', { mode: 0o600 });

    const invalidToken = await runCli(['auth', 'set', source], {
      tokenFile: invalid,
      preloadFile: preload,
      recordFile: invalidRecord,
    });

    expect(invalidToken.exitCode).toBe(1);
    expect(invalidToken.stderr).toMatch(/Invalid Krónan access token/);
    await assert.rejects(stat(invalid), { code: 'ENOENT' });
    await assert.rejects(stat(invalidRecord), { code: 'ENOENT' });

    const missingStatus = await runCli(['auth', 'status'], {
      tokenFile: join(directory, 'missing.json'),
    });

    expect(missingStatus.exitCode).toBe(1);
    expect(missingStatus.stderr).toMatch(/No saved Krónan access token/);

    await saveToken(saved, TOKEN);
    const logout = await runCli(['auth', 'logout'], { tokenFile: saved });
    expect(logout.exitCode).toBe(0);
    await assert.rejects(stat(saved), { code: 'ENOENT' });

    const version = await runCli(['--version'], { tokenFile: saved });
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toBe(VERSION + '\n');
    const help = await runCli(['--help'], { tokenFile: saved });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('stdio MCP server');
    const unknown = await runCli(['not-a-command'], { tokenFile: saved });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('kronan-mcp');
    expect(
      [rejectedSet.stderr, invalidToken.stderr, missingStatus.stderr, unknown.stderr].join('\n'),
    ).not.toMatch(new RegExp(TOKEN));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SIGTERM aborts a pending API request and closes the stdio process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kronan-shutdown-'));
  const tokenFile = join(directory, 'token.json');
  const preload = join(directory, 'never-resolves.js');
  const fetchStarted = Promise.withResolvers<void>();
  const fetchAborted = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const client = new Client({ name: 'kronan-shutdown', version: VERSION });

  const source = [
    'globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {',
    "  process.stderr.write('FETCH_STARTED\\n');",
    '  const signal = init?.signal;',
    '  const abort = () => {',
    "    process.stderr.write('FETCH_ABORTED\\n');",
    "    reject(new DOMException('Aborted', 'AbortError'));",
    '  };',
    '  if (signal?.aborted) abort();',
    "  else signal?.addEventListener('abort', abort, { once: true });",
    '});',
    '',
  ].join('\n');

  await saveToken(tokenFile, TOKEN);
  await writeFile(preload, source, { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--preload', preload, 'src/cli.ts'],
    cwd: resolve('.'),
    env: { ...process.env, KRONAN_TOKEN_FILE: tokenFile },
    stderr: 'pipe',
  });

  transport.stderr?.on('data', (chunk) => {
    const output = String(chunk);

    if (output.includes('FETCH_STARTED')) fetchStarted.resolve();

    if (output.includes('FETCH_ABORTED')) fetchAborted.resolve();
  });
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- StdioClientTransport exposes onclose as a callback property.
  transport.onclose = () => stopped.resolve();
  let pending: Promise<object> | undefined;

  try {
    await client.connect(transport);
    const pid = transport.pid;
    assert(pid);
    pending = client.callTool({ name: 'auth_status', arguments: {} });
    void pending.catch(() => {});
    await fetchStarted.promise;
    process.kill(pid, 'SIGTERM');
    await Promise.race([
      fetchAborted.promise,
      Bun.sleep(5000).then(() => assert.fail('The in-flight fetch was not aborted.')),
    ]);
    await Promise.race([
      stopped.promise,
      Bun.sleep(5000).then(() => assert.fail('The stdio process did not stop after SIGTERM.')),
    ]);
    await pending.catch(() => {});
    expect(transport.pid).toBeNull();
  } finally {
    if (transport.pid !== null) process.kill(transport.pid, 'SIGKILL');
    await pending?.catch(() => {});
    await client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
