import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

import manifest from '../package.json' with { type: 'json' };
import { loadSession, saveSession } from '../src/auth.js';
import { orderItems, parseMenu } from '../src/catalog.js';
import { DominosClient } from '../src/client.js';
import { cartInput, payInput, profileResult } from '../src/schemas.js';
import { createServer } from '../src/server.js';

const availability = {
  isHidden: false,
  storeAvailability: [],
  availableIn: [],
  notAvailableIn: [],
  availabilityDescription: null,
};

const pizza = {
  id: 'TEST',
  name: 'Synthetic pizza with } and " characters',
  ...availability,
  sizes: [
    { id: 'LG', name: 'Large', pickupPrice: 2500, deliveryPrice: 2500, blockHalfAndHalf: false },
  ],
  crusts: [{ id: 'HANDTOSS', name: 'Classic', allowedSizes: ['LG'] }],
  toppings: [],
  allergens: [],
};

const menu = {
  menuPizzas: [pizza],
  basePizza: pizza,
  sides: [],
  sauces: [],
  beverages: [],
  packages: [],
  allToppings: [],
  allergens: [],
};

const html = `ReactDOM.hydrate(React.createElement(App, ${JSON.stringify({ menu, auth: { access_token: 'DO-NOT-RETURN' } })})); throw new Error('must never execute');`;

const cart = {
  fulfillment: { type: 'pickup' as const, storeId: '1' },
  pizzas: [{ sizeId: 'LG', crustId: 'HANDTOSS', sections: [{ pizzaId: 'TEST' }] }],
};

const profile = {
  id: 1,
  name: 'Test shopper',
  phoneNumber: '3545550123',
  email: null,
  savedAddress: [
    {
      AddressID: 42,
      Address: 'Test street 7',
      PostalCode: '100',
      PostalCodeName: 'Test city',
      AdditionalInfo: 'DO-NOT-RETURN',
    },
  ],
  savedOrders: [],
  access_token: 'DO-NOT-RETURN',
};

const store = {
  RefID: '1',
  Address: 'Test street',
  City: 'Test',
  Zip: '100',
  AcceptInternet: true,
  AcceptsPickup: true,
  AcceptsDelivery: true,
  Disabled: false,
  IsHidden: false,
  Status: 1,
  StoreStatus: 1,
  PickupQuote: '10-15',
  DeliveryQuote: '20-30',
  OpensAt: '11:00',
  ClosesAt: '23:00',
  OpeningHours: '11-23',
  NotificationText: '',
};

class Provider {
  orders = 0;
  payments = 0;
  refreshes = 0;
  minorAmount = 250000;
  losePaymentResponse = false;
  loseOrderResponse = false;
  acceptCheckout = true;
  requireVerification = false;
  latestPaid = false;
  readonly requests: { url: URL; options: RequestInit }[] = [];

  request = async (url: string, options: RequestInit): Promise<Response> => {
    const target = new URL(url);
    this.requests.push({ url: target, options });

    if (target.hostname === 'www.dominos.is') return new Response(html);

    if (target.hostname === 'checkoutshopper-live.adyen.com') return this.payment(target, options);

    assert.equal(target.origin, 'https://api.dominos.is');

    if (target.pathname === '/api/token') {
      this.refreshes++;

      return Response.json({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        token_type: 'bearer',
        username: '3545550123',
        expires_in: 3600,
      });
    }

    if (target.pathname === '/api/store') return Response.json([store]);
    assert.match(
      new Headers(options.headers).get('authorization') ?? '',
      /^bearer (synthetic-access|rotated-access)$/,
    );

    if (target.pathname === '/api/user/newuser') return Response.json(profile);

    if (target.pathname === '/api/orders') {
      assert.equal(options.method, 'POST');

      const body = z
        .object({
          Pizzas: z.array(z.object({ Sections: z.array(z.object({ PizzaRefID: z.string() })) })),
          User: z.object({ Username: z.string() }),
          IsFinal: z.boolean(),
          PayWithStraumur: z.boolean().optional(),
          Payonline: z.boolean().optional(),
        })
        .parse(JSON.parse(z.string().parse(options.body)));

      assert.equal(body.Pizzas[0]?.Sections[0]?.PizzaRefID, 'TEST');
      assert.equal(body.User.Username, '3545550123');

      if (!body.IsFinal) return Response.json({ Total: 2500, Success: true });
      assert.equal(body.PayWithStraumur, true);
      assert.equal(body.Payonline, false);
      this.orders++;

      if (this.loseOrderResponse) throw new Error('lost order response');

      return Response.json({
        Total: 2500,
        Success: this.acceptCheckout,
        OrderID: 123,
        OrderGuidId: 'synthetic-order-guid',
        AdyenSessionId: 'synthetic-session',
        AdyenSessionData: 'private-initial-session',
        AdyenClientId: 'private-client-key',
      });
    }

    if (target.pathname === '/api/orders/cart/latest')
      return Response.json(this.latestPaid ? { OrderData: { IsPayed: true } } : { OrderData: '' });

    throw new Error('Unexpected offline fixture request.');
  };

  private payment(url: URL, options: RequestInit): Response {
    assert.equal(new Headers(options.headers).get('authorization'), null);
    assert.equal(url.searchParams.get('clientKey'), 'private-client-key');
    const body: unknown = JSON.parse(z.string().parse(options.body));

    if (url.pathname.endsWith('/setup')) {
      assert.deepEqual(body, { sessionData: 'private-initial-session' });

      return Response.json({
        id: 'synthetic-session',
        sessionData: 'private-rotated-session',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        amount: { currency: 'ISK', value: this.minorAmount },
        paymentMethods: {
          storedPaymentMethods: [
            {
              id: 'private-vault-token',
              type: 'scheme',
              brand: 'visa',
              lastFour: '1234',
              expiryMonth: '12',
              expiryYear: '2030',
            },
          ],
        },
      });
    }

    assert.ok(url.pathname.endsWith('/payments'));
    assert.deepEqual(body, {
      sessionData: 'private-rotated-session',
      paymentMethod: { type: 'scheme', storedPaymentMethodId: 'private-vault-token' },
      storePaymentMethod: false,
    });
    this.payments++;

    if (this.losePaymentResponse) throw new Error('secret response lost after possible charge');

    if (this.requireVerification)
      return Response.json({
        resultCode: 'ChallengeShopper',
        sessionData: 'private-challenge-session',
        action: { type: 'threeDS2', token: 'private-challenge-token' },
      });

    return Response.json({
      resultCode: 'Authorised',
      sessionData: 'private-final-session',
      sessionResult: 'private-result',
    });
  }
}

async function setup(expired = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dominos-client-test-'));
  const path = join(directory, 'session.json');
  await saveSession(path, {
    version: 1,
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    username: '3545550123',
    expiresAt: Date.now() + (expired ? -1 : 3600000),
  });
  const provider = new Provider();
  const client = new DominosClient(path, provider.request);

  return { directory, path, provider, client };
}

test('public menu parsing never evaluates JavaScript and MCP results omit secrets', async () => {
  assert.equal(parseMenu(html).menuPizzas[0]?.id, 'TEST');
  assert.throws(() => parseMenu('ReactDOM.hydrate({menu: malicious()})'));
  const fixture = await setup();
  const server = createServer(fixture.client);
  const mcp = new Client({ name: 'offline-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const { tools } = await mcp.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).toSorted(),
      [...manifest.familyMcp.release.tools].toSorted(),
    );
    assert.ok(tools.every((tool) => tool.outputSchema));
    assert.equal(
      tools.find((tool) => tool.name === 'quote_order')?.annotations?.idempotentHint,
      false,
    );
    assert.equal(
      tools.find((tool) => tool.name === 'pay_saved_card')?.annotations?.readOnlyHint,
      false,
    );
    const accountResult = await mcp.callTool({ name: 'get_profile', arguments: {} });

    const menuResult = await mcp.callTool({
      name: 'search_menu',
      arguments: { query: 'synthetic' },
    });

    assert.equal(accountResult.isError, undefined);
    assert.deepEqual(profileResult.parse(accountResult.structuredContent).addresses, [
      { ID: 42, Name: 'Test street 7', PostalCode: '100', PostalCodeName: 'Test city' },
    ]);
    assert.equal(menuResult.isError, undefined);
    assert.ok(!JSON.stringify([accountResult, menuResult]).includes('DO-NOT-RETURN'));
    assert.equal(
      (await mcp.callTool({ name: 'quote_order', arguments: { ...cart, IsFinal: true } })).isError,
      true,
    );
  } finally {
    await mcp.close();
    await server.close();
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('offer slots accept different pizzas up to their quantity and enforce size, crust, and item restrictions', () => {
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

  assert.equal(orderItems(input, data).Packages[0]?.Pizzas.length, 2);
  const bundle = input.packages[0];
  assert.ok(bundle);
  const first = bundle.pizzas[0];
  assert.ok(first);
  first.quantity = 2;
  assert.throws(() => orderItems(input, data), /required quantity/);
  first.quantity = 1;
  first.crustId = 'WRONG';
  assert.throws(() => orderItems(input, data), /does not match/);
  first.crustId = 'HANDTOSS';
  first.sizeId = 'SM';
  assert.throws(() => orderItems(input, data), /does not match/);
  first.sizeId = 'LG';
  first.sections = [{ pizzaId: 'UNKNOWN', modifications: [] }];
  assert.throws(() => orderItems(input, data), /does not match/);
});

test('concurrent clients serialize refresh and persist rotated tokens', async () => {
  const fixture = await setup(true);
  const other = new DominosClient(fixture.path, fixture.provider.request);

  try {
    await Promise.all([fixture.client.status(), other.status()]);
    assert.equal(fixture.provider.refreshes, 1);
    assert.equal((await loadSession(fixture.path)).refreshToken, 'rotated-refresh');
  } finally {
    await Promise.all([fixture.client.close(), other.close()]);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('checkout is bound to the quote and permits only one confirmed payment attempt', async () => {
  const fixture = await setup();

  try {
    const quote = await fixture.client.quoteOrder(cart);
    assert.equal(fixture.provider.orders, 0);

    const [checkout, repeated] = await Promise.all([
      fixture.client.createCheckout({ quoteId: quote.quoteId, expectedTotal: 2500 }),
      fixture.client.createCheckout({ quoteId: quote.quoteId, expectedTotal: 2500 }),
    ]);

    assert.deepEqual(checkout, repeated);
    assert.equal(fixture.provider.orders, 1);
    assert.equal(checkout.state, 'ready');
    assert.deepEqual(checkout.cart, quote.cart);
    assert.equal(checkout.cards[0]?.cardId, 'card_1');
    assert.ok(!JSON.stringify(checkout).includes('private-'));
    assert.equal(
      payInput.safeParse({
        checkoutId: checkout.checkoutId,
        cardId: 'card_1',
        expectedTotal: 2500,
        confirm: false,
      }).success,
      false,
    );
    await assert.rejects(
      fixture.client.paySavedCard({
        checkoutId: checkout.checkoutId,
        cardId: 'card_1',
        expectedTotal: 2501,
        confirm: true,
      }),
      /amount differs/,
    );
    assert.equal(fixture.provider.payments, 0);

    const input = {
      checkoutId: checkout.checkoutId,
      cardId: 'card_1',
      expectedTotal: 2500,
      confirm: true as const,
    };

    const [paid, retried] = await Promise.all([
      fixture.client.paySavedCard(input),
      fixture.client.paySavedCard(input),
    ]);

    assert.equal(paid.state, 'authorised');
    assert.equal(retried.state, 'authorised');
    assert.equal(fixture.provider.payments, 1);
    assert.ok(!JSON.stringify(paid).includes('private-'));
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('lost order creation and bank verification never allow another attempt', async () => {
  const fixture = await setup();

  try {
    const quote = await fixture.client.quoteOrder(cart);
    fixture.provider.loseOrderResponse = true;
    const request = { quoteId: quote.quoteId, expectedTotal: quote.total };
    const checkout = await fixture.client.createCheckout(request);
    assert.equal(checkout.state, 'unknown');
    assert.equal((await fixture.client.createCheckout(request)).checkoutId, checkout.checkoutId);
    assert.equal(fixture.provider.orders, 1);
    fixture.provider.loseOrderResponse = false;
    fixture.provider.acceptCheckout = false;
    const rejectedQuote = await fixture.client.quoteOrder(cart);

    const rejected = await fixture.client.createCheckout({
      quoteId: rejectedQuote.quoteId,
      expectedTotal: rejectedQuote.total,
    });

    assert.equal(rejected.state, 'unknown');
    await fixture.client.paySavedCard({
      checkoutId: rejected.checkoutId,
      cardId: 'card_1',
      expectedTotal: rejected.total,
      confirm: true,
    });
    assert.equal(fixture.provider.payments, 0);
    fixture.provider.acceptCheckout = true;
    const next = await fixture.client.quoteOrder(cart);

    const ready = await fixture.client.createCheckout({
      quoteId: next.quoteId,
      expectedTotal: next.total,
    });

    fixture.provider.requireVerification = true;

    const payment = {
      checkoutId: ready.checkoutId,
      cardId: 'card_1',
      expectedTotal: ready.total,
      confirm: true as const,
    };

    const challenged = await fixture.client.paySavedCard(payment);
    assert.equal(challenged.state, 'requires_action');
    assert.ok(!JSON.stringify(challenged).includes('private-'));
    assert.equal((await fixture.client.paySavedCard(payment)).state, 'requires_action');
    assert.equal(fixture.provider.payments, 1);
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('ISK amount mismatch prevents charging and uncertain payments survive restarts without replay', async () => {
  const fixture = await setup();
  let restarted: DominosClient | undefined;

  try {
    fixture.provider.minorAmount = 2500;
    const quote = await fixture.client.quoteOrder(cart);

    const changed = await fixture.client.createCheckout({
      quoteId: quote.quoteId,
      expectedTotal: 2500,
    });

    assert.equal(changed.state, 'amount_changed');
    await fixture.client.paySavedCard({
      checkoutId: changed.checkoutId,
      cardId: 'card_1',
      expectedTotal: 2500,
      confirm: true,
    });
    assert.equal(fixture.provider.payments, 0);
    fixture.provider.minorAmount = 250000;
    const next = await fixture.client.quoteOrder(cart);

    const checkout = await fixture.client.createCheckout({
      quoteId: next.quoteId,
      expectedTotal: 2500,
    });

    fixture.provider.losePaymentResponse = true;

    const input = {
      checkoutId: checkout.checkoutId,
      cardId: 'card_1',
      expectedTotal: 2500,
      confirm: true as const,
    };

    assert.equal((await fixture.client.paySavedCard(input)).state, 'unknown');
    await fixture.client.close();
    restarted = new DominosClient(fixture.path, fixture.provider.request);
    assert.equal((await restarted.paySavedCard(input)).state, 'unknown');
    assert.equal(
      (await restarted.getCheckout({ checkoutId: checkout.checkoutId })).state,
      'unknown',
    );
    assert.equal(fixture.provider.payments, 1);
    assert.equal(
      cartInput.safeParse({ ...cart, pizzas: [], sides: [], beverages: [], packages: [] }).success,
      false,
    );
    fixture.provider.latestPaid = true;
    assert.equal(
      (await restarted.getCheckout({ checkoutId: checkout.checkoutId })).state,
      'authorised',
    );
    assert.equal((await restarted.paySavedCard(input)).state, 'authorised');
    assert.equal(fixture.provider.payments, 1);
  } finally {
    await fixture.client.close();
    await restarted?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
