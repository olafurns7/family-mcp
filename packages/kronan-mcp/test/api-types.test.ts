import { expect, test } from 'bun:test';

import type * as z from 'zod/v4';

import type { components } from '../api/kronan-api.js';
import type {
  activeOrderSchema,
  addressSchema,
  deliverySlotsInput,
  pickupSlotsInput,
  pickupStoreSchema,
  slotDaySchema,
  ordersUpstream,
  productListsUpstream,
  purchaseStatsUpstream,
  recipesUpstream,
  searchProductsInput,
  archivedLinesUpstream,
  categoriesUpstream,
  categoryProductsSchema,
  checkoutSchema,
  lookupProductsInput,
  lookupResultSchema,
  meSchema,
  orderLineSummarySchema,
  orderSchema,
  orderSummarySchema,
  productDetailSchema,
  productListDetailSchema,
  productListSummarySchema,
  productPageSchema,
  productSchema,
  purchaseStatSchema,
  recipeDetailSchema,
  recipeSearchResultSchema,
  recipeSummarySchema,
  searchHitSchema,
  searchRecipesInput,
  searchResultSchema,
  shoppingNoteSchema,
  tagsUpstream,
} from '../src/schemas.js';

type Extends<A, B> = [A] extends [B] ? true : false;

/** Compares field names and value types while ignoring optional-versus-undefined differences. */
type Defined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

const meOk: Extends<components['schemas']['PublicMe'], z.input<typeof meSchema>> = true;

const productOk: Extends<
  components['schemas']['PublicProduct'],
  z.input<typeof productSchema>
> = true;

const productDetailOk: Extends<
  components['schemas']['PublicProductDetail'],
  z.input<typeof productDetailSchema>
> = true;

const searchHitOk: Extends<
  components['schemas']['PublicSearchHit'],
  z.input<typeof searchHitSchema>
> = true;

const searchResultOk: Extends<
  components['schemas']['PublicPaginatedSearchResult'],
  z.input<typeof searchResultSchema>
> = true;

const batchSkuResponseOk: Extends<
  components['schemas']['PublicBatchSkuResponse'],
  z.input<typeof lookupResultSchema>
> = true;

const categoryOk: Extends<
  components['schemas']['PublicCategory'],
  z.input<typeof categoriesUpstream>[number]
> = true;

const categoryProductsOk: Extends<
  components['schemas']['PublicCategoryProductList'],
  z.input<typeof categoryProductsSchema>
> = true;

const productTagOk: Extends<
  components['schemas']['PublicProductTag'],
  z.input<typeof tagsUpstream>[number]
> = true;

const onSaleProductListOk: Extends<
  components['schemas']['PublicOnSaleProductList'],
  z.input<typeof productPageSchema>
> = true;

const orderSummaryOk: Extends<
  components['schemas']['PublicOrderSummary'],
  z.input<typeof orderSummarySchema>
> = true;

const orderOk: Extends<components['schemas']['PublicOrder'], z.input<typeof orderSchema>> = true;

const activeOrderOk: Extends<
  components['schemas']['CurrentlyActiveResponse'],
  z.input<typeof activeOrderSchema>
> = true;

const orderLineSummaryOk: Extends<
  components['schemas']['PublicOrderLineSummary'],
  z.input<typeof orderLineSummarySchema>
> = true;

const purchaseStatsOk: Extends<
  components['schemas']['PublicProductPurchaseStats'],
  z.input<typeof purchaseStatSchema>
> = true;

const shoppingNoteOk: Extends<
  components['schemas']['PublicShoppingNote'],
  z.input<typeof shoppingNoteSchema>
> = true;

const archivedShoppingNoteLineOk: Extends<
  components['schemas']['PublicShoppingNoteLineArchived'],
  z.input<typeof archivedLinesUpstream>[number]
> = true;

const productListOk: Extends<
  components['schemas']['PublicProductListWithCount'],
  z.input<typeof productListSummarySchema>
> = true;

const productListDetailOk: Extends<
  components['schemas']['PublicProductListDetail'],
  z.input<typeof productListDetailSchema>
> = true;

const recipeListOk: Extends<
  components['schemas']['PublicRecipeList'],
  z.input<typeof recipeSummarySchema>
> = true;

const recipeDetailOk: Extends<
  components['schemas']['PublicRecipeDetail'],
  z.input<typeof recipeDetailSchema>
> = true;

const recipeSearchOk: Extends<
  components['schemas']['PublicRecipeSearchResponse'],
  z.input<typeof recipeSearchResultSchema>
> = true;

const checkoutOk: Extends<
  components['schemas']['PublicCheckout'],
  z.input<typeof checkoutSchema>
> = true;

const searchRecipesInputOk: Extends<
  z.output<typeof searchRecipesInput>,
  components['schemas']['PublicRecipeSearchInput']
> = true;

const lookupProductsInputOk: Extends<
  z.output<typeof lookupProductsInput>,
  components['schemas']['PublicBatchSkuInput']
> = true;

const searchInputOk: Extends<
  Defined<z.output<typeof searchProductsInput>>,
  Defined<components['schemas']['PublicSearchInput']>
> = true;

const ordersPageOk: Extends<
  components['schemas']['PaginatedPublicOrderSummaryList'],
  z.input<typeof ordersUpstream>
> = true;

const purchaseStatsPageOk: Extends<
  components['schemas']['PaginatedPublicProductPurchaseStatsList'],
  z.input<typeof purchaseStatsUpstream>
> = true;

const productListsPageOk: Extends<
  components['schemas']['PaginatedPublicProductListWithCountList'],
  z.input<typeof productListsUpstream>
> = true;

const recipesPageOk: Extends<
  components['schemas']['PaginatedPublicRecipeListList'],
  z.input<typeof recipesUpstream>
> = true;

const favoriteRecipesPageOk: Extends<
  components['schemas']['PublicFavoriteRecipeListPaginated'],
  z.input<typeof recipesUpstream>
> = true;

const addressOk: Extends<
  components['schemas']['PublicAddress'],
  z.input<typeof addressSchema>
> = true;

const slotDayOk: Extends<
  components['schemas']['PublicSlotDay'],
  z.input<typeof slotDaySchema>
> = true;

const pickupStoreOk: Extends<
  components['schemas']['PublicPickupStore'],
  z.input<typeof pickupStoreSchema>
> = true;

const deliverySlotsInputOk: Extends<
  z.output<typeof deliverySlotsInput>,
  components['schemas']['PublicDeliverySlotInput']
> = true;

const pickupSlotsInputOk: Extends<
  Defined<z.output<typeof pickupSlotsInput>>,
  Defined<components['schemas']['PublicPickupSlotInput']>
> = true;

test('spec types stay compatible with the MCP schemas', () => {
  expect([
    meOk,
    productOk,
    productDetailOk,
    searchHitOk,
    searchResultOk,
    batchSkuResponseOk,
    categoryOk,
    categoryProductsOk,
    productTagOk,
    onSaleProductListOk,
    orderSummaryOk,
    orderOk,
    activeOrderOk,
    orderLineSummaryOk,
    purchaseStatsOk,
    shoppingNoteOk,
    archivedShoppingNoteLineOk,
    productListOk,
    productListDetailOk,
    recipeListOk,
    recipeDetailOk,
    recipeSearchOk,
    checkoutOk,
    searchRecipesInputOk,
    lookupProductsInputOk,
    searchInputOk,
    ordersPageOk,
    purchaseStatsPageOk,
    productListsPageOk,
    recipesPageOk,
    favoriteRecipesPageOk,
    addressOk,
    slotDayOk,
    pickupStoreOk,
    deliverySlotsInputOk,
    pickupSlotsInputOk,
  ]).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
});
