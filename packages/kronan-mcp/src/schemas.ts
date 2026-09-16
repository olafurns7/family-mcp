import * as z from 'zod/v4';

// Inputs. Every tool input is a strict object so misspelled filters fail instead of widening.

/** Bare dot segments would be collapsed by URL parsing into a different endpoint. */
const DOT_SEGMENT = /^\.{1,2}$/;

const sku = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => !DOT_SEGMENT.test(value), { message: 'Invalid SKU' })
  .describe('Krónan product SKU.');

const barcode = z
  .string()
  .min(4)
  .max(20)
  .regex(/^[0-9]+$/)
  .describe('EAN/UPC barcode digits.');

/** Krónan slugs are `^[-a-zA-Z0-9_]+$`; letters outside ASCII are tolerated for safety. */
const slug = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}\p{N}_.-]+$/u)
  .refine((value) => !DOT_SEGMENT.test(value), { message: 'Invalid slug' });

const resourceToken = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const page = z.number().int().min(1).max(10000).default(1).describe('1-based page number.');

const limit = z.number().int().min(1).max(100).default(20).describe('Items per page.');

const offset = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .default(0)
  .describe('Index of the first item; continue with the previous nextOffset.');

const year = z.number().int().min(2000).max(2100);

const month = z.number().int().min(1).max(12);

const tagIds = z.array(z.number().int().min(0)).max(20).default([]);

export const emptyInput = z.strictObject({});

export const searchProductsInput = z.strictObject({
  query: z.string().min(1).max(64).describe('Free-text search, Icelandic or English.'),
  page,
  pageSize: z.number().int().min(1).max(50).default(20),
  sortBy: z
    .string()
    .max(32)
    .regex(/^[a-z_]+$/)
    .optional()
    .describe("Optional sort field name as accepted by Krónan, for example 'price' or 'name'."),
  withDetail: z
    .boolean()
    .default(false)
    .describe('Include discounted price, discount percent, and tags per hit. Slower.'),
  includePurchaseHistory: z
    .boolean()
    .default(false)
    .describe("Include this account's purchase statistics per hit when available."),
});

export const getProductInput = z
  .strictObject({ sku: sku.optional(), barcode: barcode.optional() })
  .refine((v) => (v.sku === undefined) !== (v.barcode === undefined), {
    message: 'Provide exactly one of sku or barcode',
  });

export const lookupProductsInput = z.strictObject({ skus: z.array(sku).min(1).max(30) });

export const categoryProductsInput = z.strictObject({
  slug: slug.describe('Leaf (third-level) category slug from list_categories.'),
  page,
});

export const productsByTagInput = z.strictObject({
  slug: slug.describe('Tag slug from list_product_tags.'),
  page,
});

export const pageInput = z.strictObject({ page });

export const listOrdersInput = z
  .strictObject({
    limit,
    offset,
    year: year.optional().describe('Filter by order display date; requires month.'),
    month: month.optional().describe('Filter by order display date; requires year.'),
    type: z.enum(['delivery', 'pickup', 'scan_n_go', 'digital']).optional(),
  })
  .refine((v) => (v.year === undefined) === (v.month === undefined), {
    message: 'Provide year and month together',
  });

export const orderInput = z.strictObject({
  token: resourceToken.describe('Order token from list_orders or get_active_order.'),
});

export const summarizeOrderLinesInput = z
  .strictObject({
    fromYear: year.optional(),
    fromMonth: month.optional(),
    toYear: year.optional(),
    toMonth: month.optional(),
    nameContains: z
      .string()
      .min(2)
      .max(100)
      .optional()
      .describe('Case-insensitive substring of the historical product name.'),
    skus: z.array(sku).min(1).max(10).optional().describe('Exact historical order-line SKUs.'),
  })
  .refine(
    (v) =>
      [v.fromYear, v.fromMonth, v.toYear, v.toMonth].every((part) => part === undefined) ||
      [v.fromYear, v.fromMonth, v.toYear, v.toMonth].every((part) => part !== undefined),
    { message: 'Provide fromYear, fromMonth, toYear, and toMonth together, or none of them' },
  )
  .refine((v) => (v.nameContains === undefined) !== (v.skus === undefined), {
    message: 'Provide exactly one of nameContains or skus',
  });

export const purchaseStatsInput = z.strictObject({
  limit,
  offset,
  sort: z.enum(['recent', 'oldest', 'most_frequent', 'most_quantity']).default('recent'),
  includeIgnored: z.boolean().default(false),
});

export const offsetInput = z.strictObject({ limit, offset });

export const productListInput = z.strictObject({
  token: resourceToken.describe('Product list token from list_product_lists.'),
});

export const searchRecipesInput = z.strictObject({
  query: z.string().max(64).default(''),
  tags: tagIds.describe('Tag IDs from availableTags.tags of a previous search.'),
  ingredientTags: tagIds,
  cuisineTags: tagIds,
  occasionTags: tagIds,
  page,
  orderBy: z.enum(['default', 'top', 'cooking_time']).default('default'),
});

export const recipeInput = z.strictObject({
  slug: slug.describe('Recipe slug from list_recipes or search_recipes.'),
});

// Upstream and output data. Required fields follow Krónan's published schema; image and URL
// strings are also accepted as null because unset upload fields serialize that way.

const isk = z.number().int().describe('Whole ISK.');

const image = z.string().nullish();

const idName = z.object({ id: z.number().int(), name: z.string() });

const slugName = z.object({ slug: z.string(), name: z.string() });

const pageFields = {
  count: z.number().int(),
  page: z.number().int(),
  pageCount: z.number().int(),
  hasNextPage: z.boolean(),
};

/** Krónan's limit/offset pages carry absolute next/previous URLs; only their presence is kept. */
const offsetPageUpstream = z.object({ count: z.number().int(), next: z.string().nullish() });

const offsetPageFields = {
  count: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  hasNextPage: z.boolean(),
  nextOffset: z
    .number()
    .int()
    .nullable()
    .describe('Offset for the next page, counted from returned items; null on the last page.'),
};

export const productSchema = z.object({
  sku: z.string(),
  name: z.string(),
  thumbnail: image,
  price: isk,
  discountedPrice: isk,
  discountPercent: z.number(),
  onSale: z.boolean(),
  priceInfo: z.string().nullable(),
  chargedByWeight: z.boolean().optional(),
  pricePerKilo: z.number().nullable(),
  baseComparisonUnit: z.string().nullish(),
  temporaryShortage: z.boolean(),
  categoryPath: z.string().nullable(),
  brand: z.string().nullish(),
});

export const productDetailSchema = productSchema.extend({
  description: z.string().optional(),
  image,
  qtyPerBaseCompUnit: z.number().nullish(),
  qtyInSalesUnit: z.number().nullish(),
  countryOfOrigin: z.string().nullish(),
  tags: z.array(slugName),
  // Documented as a string map; flat numbers are tolerated, nested upstream objects are not.
  nutrition: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
});

export const meSchema = z.object({ type: z.string(), name: z.string() });

export const statusResultSchema = z.object({ authenticated: z.literal(true), account: meSchema });

export const searchHitSchema = z.object({
  sku: z.string(),
  name: z.string(),
  price: isk,
  thumbnail: image,
  temporaryShortage: z.boolean(),
  priceInfo: z.string().nullable(),
  chargedByWeight: z.boolean(),
  pricePerKilo: z.number().nullable(),
  baseComparisonUnit: z.string().nullable(),
  detail: z
    .object({
      discountedPrice: isk,
      discountPercent: z.number(),
      onSale: z.boolean(),
      qtyInSalesUnit: z.number().nullish(),
      tags: z.array(slugName),
    })
    .nullable(),
  purchaseHistory: z
    .object({
      purchaseCount: z.number().int(),
      averagePurchaseQuantity: z.number().nullable(),
      lastPurchaseDate: z.string().nullable(),
    })
    .nullable(),
});

export const searchResultSchema = z.object({ ...pageFields, hits: z.array(searchHitSchema) });

export const lookupResultSchema = z.object({
  results: z.array(productDetailSchema),
  missingSkus: z.array(z.string()),
});

const categoryLevel2 = slugName;

const categoryLevel1 = slugName.extend({ children: z.array(categoryLevel2) });

export const categoriesUpstream = z.array(
  slugName.extend({
    backgroundImage: image,
    icon: image,
    children: z.array(categoryLevel1),
  }),
);

export const categoriesResultSchema = z.object({ categories: categoriesUpstream });

export const categoryProductsSchema = z.object({
  name: z.string(),
  ...pageFields,
  products: z.array(productSchema),
});

export const tagsUpstream = z.array(slugName);

export const tagsResultSchema = z.object({ tags: tagsUpstream });

export const productPageSchema = z.object({ ...pageFields, results: z.array(productSchema) });

const deliveryInfoSchema = z.object({
  timeStart: z.string().nullable(),
  timeStop: z.string().nullable(),
  status: z.number().nullable(),
  statusDisplay: z.string().nullable(),
  eta: z.string().nullable(),
  address: z
    .object({
      streetAddress1: z.string(),
      city: z.string(),
      postalCode: z.string(),
      lat: z.number().nullable(),
      lng: z.number().nullable(),
      comment: z.string().nullable(),
    })
    .nullable(),
});

export const orderSummarySchema = z.object({
  token: z.string().optional(),
  created: z.string(),
  displayDate: z.string().optional(),
  status: z.string().optional(),
  type: z.string().nullish(),
  total: isk,
  discount: isk,
  deliveryDate: z.string().nullish(),
  allowAlterOrderLines: z.boolean(),
  deliveryInfo: deliveryInfoSchema.nullable(),
});

export const orderLineSchema = z.object({
  id: z.number().int(),
  productName: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  quantityOrdered: z.number().int().optional(),
  unitPrice: isk,
  substitution: z.boolean().optional(),
  substitutionForLineId: z.number().int().nullable(),
  isMutable: z.boolean(),
  isLastChance: z.boolean().optional(),
  thumbnail: image,
  total: isk,
});

export const orderSchema = orderSummarySchema
  .omit({ displayDate: true })
  .extend({ lines: z.array(orderLineSchema) });

export const ordersUpstream = offsetPageUpstream.extend({ results: z.array(orderSummarySchema) });

export const ordersResultSchema = z.object({
  ...offsetPageFields,
  results: z.array(orderSummarySchema),
});

export const activeOrderSchema = z.object({
  orderToken: z.string(),
  type: z.string(),
  deliveryDate: z.string().nullable(),
  timeStart: z.string().nullable(),
  timeStop: z.string().nullable(),
  address: z
    .object({
      id: z.number().int(),
      streetAddress1: z.string(),
      city: z.string(),
      postalCode: z.string(),
    })
    .nullable(),
  store: idName.nullable(),
  lines: z.array(
    z.object({ sku: z.string(), name: z.string(), quantity: z.number().int(), unitPrice: isk }),
  ),
  subtotal: isk,
  shippingFee: isk,
  serviceFee: isk,
  bagFee: isk,
  total: isk,
  freeShippingCutoff: isk,
  neededForFreeShipping: isk,
  allowAdditionalOrderLinesUntil: z.string().nullable(),
  authorizedAmount: isk,
  capturedAmount: isk,
});

export const activeOrderResultSchema = z.object({
  active: z.boolean().describe('False when Krónan reports no currently active order.'),
  order: activeOrderSchema.nullable(),
});

export const orderLineSummarySchema = z.object({
  nameContains: z.string().nullable(),
  skus: z.array(z.string()).nullable(),
  fromYear: z.number().int(),
  fromMonth: z.number().int(),
  toYear: z.number().int(),
  toMonth: z.number().int(),
  asOfDate: z.string(),
  totalAmount: isk,
  totalQuantity: z.number().int(),
  orderCount: z.number().int(),
  months: z.array(
    z.object({
      year: z.number().int(),
      month: z.number().int(),
      amount: isk,
      quantity: z.number().int(),
      orderCount: z.number().int(),
    }),
  ),
  matchedProductCount: z.number().int(),
  matchedProducts: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      amount: isk,
      quantity: z.number().int(),
      orderCount: z.number().int(),
    }),
  ),
});

export const purchaseStatSchema = z.object({
  id: z.number().int(),
  product: productSchema,
  purchaseCount: z.number().int().optional(),
  quantityPurchased: z.number().int().optional(),
  averagePurchaseQuantity: z.number().nullish(),
  lastPurchaseQuantity: z.number().int().optional(),
  averagePurchaseIntervalDays: z.number().nullish(),
  firstPurchaseDate: z.string().nullish(),
  lastPurchaseDate: z.string().nullish(),
  isIgnored: z.boolean().optional(),
});

export const purchaseStatsUpstream = offsetPageUpstream.extend({
  results: z.array(purchaseStatSchema),
});

export const purchaseStatsResultSchema = z.object({
  ...offsetPageFields,
  results: z.array(purchaseStatSchema),
});

export const shoppingNoteSchema = z.object({
  token: z.string(),
  name: z.string(),
  lines: z.array(
    z.object({
      token: z.string(),
      text: z.string().nullish(),
      quantity: z.number().int().nullish(),
      product: z
        .object({
          sku: z.string().nullish(),
          name: z.string(),
          description: z.string().optional(),
          thumbnail: image,
        })
        .nullish(),
      placement: z.number().int().optional(),
      isCompleted: z.boolean().optional(),
    }),
  ),
});

export const archivedLinesUpstream = z.array(
  z.object({ token: z.string(), text: z.string(), completedCount: z.number().int().optional() }),
);

export const archivedLinesResultSchema = z.object({ lines: archivedLinesUpstream });

export const productListSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  token: z.string(),
  description: z.string().optional(),
  hasProducts: z.boolean(),
});

export const productListsUpstream = offsetPageUpstream.extend({
  results: z.array(productListSummarySchema),
});

export const productListsResultSchema = z.object({
  ...offsetPageFields,
  results: z.array(productListSummarySchema),
});

export const productListDetailSchema = productListSummarySchema.omit({ hasProducts: true }).extend({
  items: z.array(
    z.object({ id: z.number().int(), quantity: z.number().int(), product: productSchema }),
  ),
});

const recipeImage = z.object({ image: z.string(), alt: z.string().optional() });

export const recipeSummarySchema = z.object({
  token: z.string(),
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  isFeatured: z.boolean().optional(),
  preparationMinutes: z.number().int().optional(),
  cookingMinutes: z.number().int().optional(),
  totalMinutes: z.number().int(),
  servings: z.number().int().optional(),
  difficulty: z.number().nullable(),
  mainImage: recipeImage.nullable(),
  tags: z.array(idName),
  ingredientTags: z.array(idName),
  cuisineTags: z.array(idName),
  occasionTags: z.array(idName),
  favorited: z.boolean(),
  hasVideo: z.boolean(),
});

const recipeProductLine = z.object({
  quantity: z.number().int(),
  comment: z.string().optional(),
  product: productSchema,
});

export const recipeDetailSchema = recipeSummarySchema.extend({
  directions: z.string().optional(),
  ingredients: z.string().optional(),
  videoUrl: z.string().nullish(),
  items: z.array(recipeProductLine),
  essentials: z.array(recipeProductLine),
  recommendations: z.array(z.object({ product: productSchema })),
  images: z.array(recipeImage),
  directionSteps: z.array(
    z.object({
      name: z.string().nullable(),
      steps: z.array(
        z.object({
          number: z.number().int().nullable(),
          text: z.string(),
          ingredients: z.array(z.string()),
          icon: z.object({ name: z.string().optional(), icon: z.string().nullish() }).nullable(),
        }),
      ),
    }),
  ),
});

export const recipesUpstream = offsetPageUpstream.extend({
  results: z.array(recipeSummarySchema),
});

export const recipesResultSchema = z.object({
  ...offsetPageFields,
  results: z.array(recipeSummarySchema),
});

export const recipeSearchResultSchema = z.object({
  ...pageFields,
  recipes: z.array(recipeSummarySchema),
  availableTags: z.object({
    tags: z.array(idName),
    ingredientTags: z.array(idName),
    cuisineTags: z.array(idName),
    occasionTags: z.array(idName),
  }),
});

export const checkoutSchema = z.object({
  token: z.string(),
  lines: z.array(
    z.object({
      id: z.number().int(),
      quantity: z.number().int(),
      product: productSchema,
      total: isk,
      price: isk,
      substitution: z.boolean().optional(),
    }),
  ),
  total: isk,
  subtotal: isk,
  baggingFee: isk,
  serviceFee: isk,
  shippingFee: isk,
  shippingFeeCutoff: isk,
});
