// Rust: the original catalog case drives quote_order and inspects only its fake order body.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { parseMenu } from '../../../../packages/dominos-mcp/src/catalog.ts';
import { cartInput } from '../../../../packages/dominos-mcp/src/schemas.ts';
import { DominosClient } from './rust-dominos.ts';
import { setup, html, pizza, availability, cart } from './fixtures.ts';
async function orderItems(input: object, data: unknown) {
  const fixture = await setup();
  let result: { Packages: { Pizzas: unknown[] }[] } | undefined;
  const client = new DominosClient(fixture.path, async (url, options) => {
    if (new URL(url).hostname === 'www.dominos.is')
      return new Response(`ReactDOM.hydrate(${JSON.stringify({ menu: data })})`);
    if (new URL(url).pathname === '/api/orders') {
      result = JSON.parse(options.body as string);
      return Response.json({ Total: 4000, Success: true });
    }
    return fixture.provider.request(url, options);
  });
  try {
    await client.quoteOrder(input);
    assert.ok(result);
    return result;
  } finally {
    await Promise.all([client.close(), fixture.client.close()]);
    await fixture.home.cleanup();
  }
}
test('offer slots accept different pizzas up to their quantity and enforce size, crust, and item restrictions', async () => {
  const data = parseMenu(html);
  data.menuPizzas.push({ ...pizza, id: 'SECOND' });
  data.packages.push({
    ...availability,
    id: 'BUNDLE',
    name: 'Two pizzas',
    description: '',
    price: 4000,
    availableForPickup: true,
    availableForDelivery: true,
    payOnlineOnly: true,
    items: [
      {
        id: 'pizza-slot',
        type: 0,
        quantity: 2,
        sizeId: 'LG',
        sizeList: ['LG'],
        pizzaType: 'HANDTOSS',
        isOptional: false,
        items: [
          { id: 'TEST', name: 'First' },
          { id: 'SECOND', name: 'Second' },
        ],
      },
    ],
  });

  const input = cartInput.parse({
    fulfillment: cart.fulfillment,
    packages: [
      {
        id: 'BUNDLE',
        pizzas: [
          {
            sizeId: 'LG',
            crustId: 'HANDTOSS',
            sections: [{ pizzaId: 'TEST' }],
            packageItemId: 'pizza-slot',
          },
          {
            sizeId: 'LG',
            crustId: 'HANDTOSS',
            sections: [{ pizzaId: 'SECOND' }],
            packageItemId: 'pizza-slot',
          },
        ],
      },
    ],
  });

  assert.equal((await orderItems(input, data)).Packages[0]?.Pizzas.length, 2);
  const bundle = input.packages[0];
  assert.ok(bundle);
  const first = bundle.pizzas[0];
  assert.ok(first);
  first.quantity = 2;
  await assert.rejects(() => orderItems(input, data), /required quantity/);
  first.quantity = 1;
  first.crustId = 'WRONG';
  await assert.rejects(() => orderItems(input, data), /does not match/);
  first.crustId = 'HANDTOSS';
  first.sizeId = 'SM';
  await assert.rejects(() => orderItems(input, data), /does not match/);
  first.sizeId = 'LG';
  first.sections = [{ pizzaId: 'UNKNOWN', modifications: [] }];
  await assert.rejects(() => orderItems(input, data), /does not match/);
});
