import * as z from 'zod/v4';

export const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export const money = z.number().int().nonnegative().max(1_000_000);

export const empty = z.strictObject({});

const quantity = z.number().int().min(1).max(20);

const ref = z.union([z.string(), z.number()]);

export const address = z.object({
  ID: z.number().int().positive(),
  Name: z.string(),
  PostalCode: z.string(),
  PostalCodeName: z.string(),
});

export const store = z.object({
  RefID: z.string(),
  Address: z.string(),
  City: z.string(),
  Zip: z.string(),
  AcceptInternet: z.boolean(),
  AcceptsPickup: z.boolean(),
  AcceptsDelivery: z.boolean(),
  Disabled: z.boolean(),
  IsHidden: z.boolean(),
  Status: z.number(),
  StoreStatus: z.number(),
  PickupQuote: z.string().nullable(),
  DeliveryQuote: z.string().nullable(),
  OpensAt: z.string().nullable(),
  ClosesAt: z.string().nullable(),
  OpeningHours: z.string().nullable(),
  NotificationText: z.string().nullable(),
});

const priced = z.object({
  id: z.string(),
  name: z.string(),
  pickupPrice: z.number(),
  deliveryPrice: z.number(),
});

const availability = {
  isHidden: z.boolean(),
  storeAvailability: z.array(ref),
  availableIn: z.array(ref).nullable(),
  notAvailableIn: z.array(ref).nullable(),
  availabilityDescription: z.string().nullable(),
};

const topping = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  quantity: z.number(),
  isDoubleable: z.boolean(),
  isVegan: z.boolean(),
  isHidden: z.boolean(),
  prices: z.array(
    z.object({ sizeId: z.string(), pickupPrice: z.number(), deliveryPrice: z.number() }),
  ),
});

export const pizza = z.object({
  id: z.string(),
  name: z.string(),
  ...availability,
  sizes: z.array(priced.extend({ blockHalfAndHalf: z.boolean() })),
  crusts: z.array(
    z.object({ id: z.string(), name: z.string(), allowedSizes: z.array(z.string()) }),
  ),
  toppings: z.array(topping),
  allergens: z.array(ref),
});

const extra = priced.extend({ isHidden: z.boolean() });

export const side = priced.extend({
  ...availability,
  description: z.string().nullable(),
  extras: z.array(extra),
  allergens: z.array(ref),
  defaultExtraId: z.string().nullable(),
});

export const sauce = priced.extend({
  ...availability,
  description: z.string().nullable(),
  allergens: z.array(ref),
});

export const beverage = z.object({
  id: z.string(),
  name: z.string(),
  sizes: z.array(priced),
  ...availability,
});

export const offer = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  price: z.number(),
  ...availability,
  availableForPickup: z.boolean(),
  availableForDelivery: z.boolean(),
  payOnlineOnly: z.boolean(),
  items: z.array(
    z.object({
      id: z.string(),
      type: z.number(),
      quantity: z.number(),
      sizeId: z.string().nullable(),
      sizeList: z.array(z.string()),
      pizzaType: z.string().nullable(),
      isOptional: z.boolean(),
      items: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});

export const menu = z.object({
  menuPizzas: z.array(pizza),
  basePizza: pizza,
  sides: z.array(side),
  sauces: z.array(sauce),
  beverages: z.array(beverage),
  packages: z.array(offer),
  allToppings: z.array(topping),
  allergens: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const kind = z.enum(['pizza', 'side', 'sauce', 'beverage', 'offer']);

export const menuSearch = z.strictObject({
  query: z.string().max(100).default(''),
  kind: kind.optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});

export const itemInput = z.strictObject({ kind, id });

export const itemResult = z.object({
  kind,
  item: z.union([pizza, side, sauce, beverage, offer]),
  toppings: z.array(topping),
  allergens: menu.shape.allergens,
});

export const searchResult = z.object({
  items: z.array(
    z.object({ kind, id: z.string(), name: z.string(), description: z.string().nullable() }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
});

export const modification = z.strictObject({
  toppingId: id,
  quantity: z.union([z.literal(0), z.literal(0.5), z.literal(0.75), z.literal(1), z.literal(2)]),
});

export const pizzaInput = z.strictObject({
  quantity: quantity.default(1),
  sizeId: id,
  crustId: id,
  sections: z
    .array(
      z.strictObject({ pizzaId: id, modifications: z.array(modification).max(40).default([]) }),
    )
    .min(1)
    .max(2),
});

export const sideInput = z.strictObject({
  id,
  quantity: quantity.default(1),
  extraId: id.optional(),
});

export const beverageInput = z.strictObject({ id, sizeId: id, quantity: quantity.default(1) });

export const packageInput = z.strictObject({
  id,
  quantity: quantity.default(1),
  pizzas: z
    .array(pizzaInput.extend({ packageItemId: id }))
    .max(10)
    .default([]),
  sides: z
    .array(sideInput.extend({ packageItemId: id }))
    .max(10)
    .default([]),
  beverages: z
    .array(beverageInput.extend({ packageItemId: id }))
    .max(10)
    .default([]),
});

export const cartInput = z
  .strictObject({
    fulfillment: z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('pickup'),
        storeId: id,
        instructions: z.string().max(300).default(''),
      }),
      z.strictObject({
        type: z.literal('delivery'),
        address: address.strict(),
        instructions: z.string().max(300).default(''),
      }),
    ]),
    pizzas: z.array(pizzaInput).max(20).default([]),
    sides: z.array(sideInput).max(20).default([]),
    beverages: z.array(beverageInput).max(20).default([]),
    packages: z.array(packageInput).max(20).default([]),
    coupon: z.string().min(1).max(80).optional(),
  })
  .refine(
    (cart) =>
      cart.pizzas.length + cart.sides.length + cart.beverages.length + cart.packages.length > 0,
    'Cart is empty.',
  );

export type Cart = z.infer<typeof cartInput>;

export const profile = z.object({
  id: ref,
  name: z.string().nullable(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  savedAddress: z
    .array(
      z
        .object({
          AddressID: address.shape.ID,
          Address: address.shape.Name,
          PostalCode: address.shape.PostalCode,
          PostalCodeName: address.shape.PostalCodeName,
        })
        .transform(({ AddressID, Address, PostalCode, PostalCodeName }) => ({
          ID: AddressID,
          Name: Address,
          PostalCode,
          PostalCodeName,
        })),
    )
    .optional(),
  savedOrders: z
    .array(z.object({ id: ref, name: z.string(), cartCollection: z.string() }))
    .optional(),
});

export const profileResult = z.object({
  id: ref,
  name: z.string().nullable(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  addresses: z.array(address),
  savedOrders: z.array(z.object({ id: ref, name: z.string() })),
});

export const statusResult = z.object({
  authenticated: z.literal(true),
  name: z.string().nullable(),
});

export const receipts = z.array(
  z.object({
    Id: ref,
    Amount: z.number(),
    DateOf: z.string(),
    IsOneSystem: z.boolean().optional(),
  }),
);

export const tracker = z.object({
  OrderID: ref.nullable(),
  OrderState: z.string(),
  Remaining: z.number().nullable(),
  IsPickup: z.boolean(),
  IsTimedOrder: z.boolean(),
  EstimatedFinishTime: z.string().nullable().optional(),
});

export const latestCart = z.object({
  OrderData: z.union([z.object({ IsPayed: z.boolean() }), z.literal(''), z.null()]),
});

export const quoteResponse = z.object({
  Total: money,
  OrderID: ref.nullable().optional(),
  OrderGuidId: z.string().nullable().optional(),
  EstimatedDeliveryTime: z.string().nullable().optional(),
  Success: z.boolean().optional(),
});

export const orderResponse = quoteResponse.extend({
  AdyenSessionId: id,
  AdyenSessionData: z.string().min(1),
  AdyenClientId: z.string().min(1),
  OrderGuidId: z.string().min(1),
});

const storedCard = z.object({
  id: z.string(),
  type: z.literal('scheme'),
  brand: z.string(),
  lastFour: z.string().regex(/^\d{4}$/),
  expiryMonth: z.string(),
  expiryYear: z.string(),
  supportedShopperInteractions: z.array(z.string()).optional(),
});

export const setupResponse = z.object({
  id: z.string(),
  sessionData: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  amount: z.object({ currency: z.literal('ISK'), value: z.number().int().nonnegative() }),
  paymentMethods: z.object({ storedPaymentMethods: z.array(storedCard).optional() }),
});

export const paymentResponse = z.object({
  resultCode: z.string(),
  sessionData: z.string().min(1),
  sessionResult: z.string().optional(),
  action: z
    .object({ type: z.string(), url: z.string().optional(), method: z.string().optional() })
    .optional(),
});

export const localId = z.string().uuid();

export const quote = z.object({
  id: localId,
  username: z.string(),
  cart: cartInput,
  total: money,
  createdAt: z.number(),
  expiresAt: z.number(),
  checkoutId: localId.optional(),
});

export const checkout = z.object({
  id: localId,
  quoteId: localId,
  username: z.string(),
  total: money,
  cart: cartInput,
  state: z.enum([
    'creating',
    'ready',
    'submitting',
    'authorised',
    'refused',
    'pending',
    'requires_action',
    'unknown',
    'amount_changed',
  ]),
  expiresAt: z.number(),
  orderId: ref.nullable(),
  orderGuid: z.string().optional(),
  sessionId: z.string().optional(),
  sessionData: z.string().optional(),
  clientKey: z.string().optional(),
  cards: z.array(storedCard),
  resultCode: z.string().optional(),
});

export const quoteResult = z.object({
  quoteId: localId,
  total: money,
  currency: z.literal('ISK'),
  expiresAt: z.string(),
  cart: cartInput,
});

export const checkoutInput = z.strictObject({ quoteId: localId, expectedTotal: money });

export const checkoutIdInput = z.strictObject({ checkoutId: localId });

export const payInput = z.strictObject({
  checkoutId: localId,
  cardId: z.string().regex(/^card_\d+$/),
  expectedTotal: money,
  confirm: z.literal(true),
});

export const checkoutResult = z.object({
  checkoutId: localId,
  state: checkout.shape.state,
  total: money,
  currency: z.literal('ISK'),
  cart: cartInput,
  orderId: ref.nullable(),
  expiresAt: z.string(),
  resultCode: z.string().nullable(),
  cards: z.array(
    z.object({
      cardId: z.string(),
      brand: z.string(),
      lastFour: z.string(),
      expiryMonth: z.string(),
      expiryYear: z.string(),
    }),
  ),
});
