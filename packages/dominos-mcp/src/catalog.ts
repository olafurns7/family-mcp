import { SafeError } from '@family-mcp/mcp-runtime';
import * as z from 'zod/v4';

import { menu, type Cart, type pizzaInput, type sideInput, type beverageInput } from './schemas.js';

export type Menu = z.infer<typeof menu>;

/** Extract the JSON object without evaluating the page's executable JavaScript. */
export function parseMenu(html: string): Menu {
  const marker = html.indexOf('ReactDOM.hydrate(');
  const start = marker < 0 ? -1 : html.indexOf('{', marker);
  let depth = 0;
  let quoted = false;
  let escaped = false;

  if (start < 0) throw new SafeError('Domino’s menu data is missing from the page.');

  for (let i = start; i < html.length; i++) {
    const character = html[i];

    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}') {
      depth--;

      if (depth === 0) {
        try {
          return z.object({ menu }).parse(JSON.parse(html.slice(start, i + 1))).menu;
        } catch {
          throw new SafeError('Domino’s menu format changed. No order was sent.');
        }
      }
    }
  }

  throw new SafeError('Domino’s menu data is incomplete.');
}

function pizzaOrder(input: z.infer<typeof pizzaInput>, data: Menu) {
  const sections = input.sections.map((section) => {
    const item = [...data.menuPizzas, data.basePizza].find(
      (candidate) => candidate.id === section.pizzaId && !candidate.isHidden,
    );

    const size = item?.sizes.find((candidate) => candidate.id === input.sizeId);
    const crust = item?.crusts.find((candidate) => candidate.id === input.crustId);

    if (!item || !size || !crust?.allowedSizes.includes(input.sizeId))
      throw new SafeError(
        'The selected pizza, size, or crust is not available in the current menu.',
      );

    if (input.sections.length === 2 && size.blockHalfAndHalf)
      throw new SafeError('This size does not allow half-and-half pizzas.');

    const seen = new Set<string>();

    for (const change of section.modifications) {
      const topping = data.allToppings.find(
        (candidate) => candidate.id === change.toppingId && !candidate.isHidden,
      );

      if (!topping || seen.has(change.toppingId) || (change.quantity > 1 && !topping.isDoubleable))
        throw new SafeError('A topping modification is invalid or repeated.');
      seen.add(change.toppingId);
    }

    return {
      PizzaRefID: item.id,
      Modifications: section.modifications.map((change) => ({
        ToppingRefID: change.toppingId,
        Quantity: change.quantity,
      })),
    };
  });

  return {
    Quantity: input.quantity,
    SizeRefID: input.sizeId,
    TypeRefID: input.crustId,
    Sections: sections,
  };
}

function sideOrder(input: z.infer<typeof sideInput>, data: Menu) {
  const item = [...data.sides, ...data.sauces].find(
    (candidate) => candidate.id === input.id && !candidate.isHidden,
  );

  if (!item)
    throw new SafeError('The selected side or sauce is not available in the current menu.');
  const side = data.sides.find((candidate) => candidate.id === input.id);
  const extraId = input.extraId ?? side?.defaultExtraId;

  if (extraId && !side?.extras.some((extra) => extra.id === extraId && !extra.isHidden))
    throw new SafeError('The selected extra is not available for this side.');

  return { SideOrderID: input.id, Quantity: input.quantity, Modifiers: extraId ? [extraId] : [] };
}

function beverageOrder(input: z.infer<typeof beverageInput>, data: Menu) {
  const item = data.beverages.find((candidate) => candidate.id === input.id && !candidate.isHidden);

  if (!item?.sizes.some((size) => size.id === input.sizeId))
    throw new SafeError('The selected drink or size is not available in the current menu.');

  return { BeverageID: input.id, SizeRefID: input.sizeId, Quantity: input.quantity };
}

export function orderItems(cart: Cart, data: Menu) {
  const packages = cart.packages.map((input) => {
    const offer = data.packages.find(
      (candidate) => candidate.id === input.id && !candidate.isHidden,
    );

    if (
      !offer ||
      (cart.fulfillment.type === 'pickup' ? !offer.availableForPickup : !offer.availableForDelivery)
    )
      throw new SafeError('This offer is not available for the selected fulfillment method.');

    const choices = [
      ...input.pizzas.map((item) => ({
        slot: item.packageItemId,
        type: 0,
        crustId: item.crustId,
        ids: item.sections.map((part) => part.pizzaId),
        quantity: item.quantity,
        sizeId: item.sizeId,
      })),
      ...input.sides.map((item) => ({
        slot: item.packageItemId,
        type: 4,
        crustId: null,
        ids: [item.id],
        quantity: item.quantity,
        sizeId: '',
      })),
      ...input.beverages.map((item) => ({
        slot: item.packageItemId,
        type: 2,
        crustId: null,
        ids: [item.id],
        quantity: item.quantity,
        sizeId: item.sizeId,
      })),
    ];

    for (const slot of offer.items) {
      const matches = choices.filter((choice) => choice.slot === slot.id);

      if (matches.length === 0 && slot.isOptional) continue;

      if (matches.reduce((sum, choice) => sum + choice.quantity, 0) !== slot.quantity)
        throw new SafeError('Select the required quantity for each offer slot.');

      if (
        matches.some(
          (choice) =>
            choice.type !== slot.type ||
            (slot.pizzaType && choice.crustId !== slot.pizzaType) ||
            choice.ids.some((selected) => !slot.items.some((item) => item.id === selected)) ||
            (choice.sizeId && slot.sizeList.length > 0 && !slot.sizeList.includes(choice.sizeId)),
        )
      )
        throw new SafeError('An item, size, or quantity does not match this offer.');
    }

    if (choices.some((choice) => !offer.items.some((slot) => slot.id === choice.slot)))
      throw new SafeError('Unknown offer slot. Use the slots returned by get_menu_item.');

    return {
      PackageRefID: input.id,
      Quantity: input.quantity,
      Pizzas: input.pizzas.map((item) => ({
        ...pizzaOrder(item, data),
        PackageItemID: item.packageItemId,
      })),
      SideOrders: input.sides.map((item) => ({
        ...sideOrder(item, data),
        PackageItemID: item.packageItemId,
      })),
      Beverages: input.beverages.map((item) => ({
        ...beverageOrder(item, data),
        PackageItemID: item.packageItemId,
      })),
    };
  });

  return {
    Pizzas: cart.pizzas.map((item) => pizzaOrder(item, data)),
    SideOrders: cart.sides.map((item) => sideOrder(item, data)),
    Beverages: cart.beverages.map((item) => beverageOrder(item, data)),
    Packages: packages,
    UpsellOffer: { Pizzas: [], SideOrders: [], Beverages: [], Packages: [] },
  };
}
