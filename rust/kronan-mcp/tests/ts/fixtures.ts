// The offline fixtures of packages/kronan-mcp/test/integration.test.ts, copied unchanged except
// for `export`, so parity.ts answers the binary and the TypeScript CLI with the suite's own data.
export const UPSTREAM_EXTRA = 'remove-this-unpublished-field';

export const ORDER_TOKEN = '123e4567-e89b-12d3-a456-426614174001';

export const LIST_TOKEN = '123e4567-e89b-12d3-a456-426614174002';

export const CHECKOUT_TOKEN = '123e4567-e89b-12d3-a456-426614174006';

export const NOTE_LINE_TOKEN = '123e4567-e89b-12d3-a456-426614174007';

/** The approved checkout: one line, nonzero total, so a mismatch is meaningful. */
export const CHECKOUT_TOTAL = 1489;

export const product = {
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

export const productPage = {
  count: 1,
  page: 1,
  pageCount: 1,
  hasNextPage: false,
  results: [{ ...product, upstreamOnly: UPSTREAM_EXTRA }],
  upstreamOnly: UPSTREAM_EXTRA,
};

export const searchResult = {
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

export const categoryTree = [
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

export const deliveryInfo = {
  timeStart: null,
  timeStop: null,
  status: null,
  statusDisplay: null,
  eta: null,
  address: null,
  upstreamOnly: UPSTREAM_EXTRA,
};

export const orderSummary = {
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

export const order = {
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

export const activeOrder = {
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

export const lineSummary = {
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

export const recipe = {
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

export const checkout = {
  token: CHECKOUT_TOKEN,
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
  total: CHECKOUT_TOTAL,
  subtotal: 499,
  baggingFee: 0,
  serviceFee: 0,
  shippingFee: 990,
  shippingFeeCutoff: 0,
  upstreamOnly: UPSTREAM_EXTRA,
};

export const reservation = {
  orderToken: ORDER_TOKEN,
  slotId: 501,
  deliveryDate: '2026-09-26',
  timeStart: '10:00:00',
  timeStop: '12:00:00',
  fees: { shipping: 990 },
  authorizedAmount: CHECKOUT_TOTAL,
  upstreamOnly: UPSTREAM_EXTRA,
};

/** The gate fields a user approval carries for the checkout fixture. */
export const approval = {
  confirm: true as const,
  expectedTotal: CHECKOUT_TOTAL,
  expectedCheckoutToken: CHECKOUT_TOKEN,
};

export function fixtureResponse(pathname: string): Response {
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
    case '/api/v1/shopping-notes/add-lines/':
    case '/api/v1/shopping-notes/change-line/':
    case '/api/v1/shopping-notes/toggle-complete-on-line/':
    case '/api/v1/shopping-notes/delete-line/':
      return Response.json({
        token: '123e4567-e89b-12d3-a456-426614174004',
        name: 'Shopping note',
        lines: [
          {
            token: NOTE_LINE_TOKEN,
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
    case '/api/v1/shopping-notes/delete-shopping-note/':
      return new Response(null, { status: 204 });
    case '/api/v1/checkout/preview-lines/':
      return Response.json({
        lines: [
          {
            sku: product.sku,
            name: product.name,
            quantity: 2,
            price: 499,
            total: 998,
            status: 'ok',
            reason: null,
            upstreamOnly: UPSTREAM_EXTRA,
          },
        ],
        estimatedSubtotal: 998,
        okCount: 1,
        issueCount: 0,
        upstreamOnly: UPSTREAM_EXTRA,
      });
    case '/api/v1/slots/delivery/reserve/':
    case '/api/v1/slots/pickup/reserve/':
      return Response.json(reservation, { status: 201 });
    case '/api/v1/checkout/complete/':
    case '/api/v1/checkout/add-to-order/':
      return Response.json(
        { orderToken: ORDER_TOKEN, authorizedAmount: CHECKOUT_TOTAL, upstreamOnly: UPSTREAM_EXTRA },
        { status: 201 },
      );
    case '/api/v1/orders/' + ORDER_TOKEN + '/delete-lines/':
    case '/api/v1/orders/' + ORDER_TOKEN + '/lower-quantity-lines/':
    case '/api/v1/orders/' + ORDER_TOKEN + '/lines-toggle-substitution/':
      return Response.json(order);
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
    case '/api/v1/checkout/lines/':
      return Response.json(checkout);
    default:
      return new Response('Unexpected offline fixture path.', { status: 404 });
  }
}
