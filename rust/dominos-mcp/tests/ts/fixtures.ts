import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import type { KeyProvider } from '@family-mcp/session-store';
import { saveSession, migrate, withSession, type Session } from '../../../../packages/dominos-mcp/src/auth.ts';
import { scratchHome } from './scratch.ts';
import { DominosClient } from './rust-dominos.ts';
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

const TOKENS = ['synthetic-access', 'synthetic-refresh', 'rotated-access', 'rotated-refresh'];

const saved = (expired = false, prefix = 'synthetic'): Session => ({
  version: 1,
  accessToken: `${prefix}-access`,
  refreshToken: `${prefix}-refresh`,
  username: '3545550123',
  expiresAt: Date.now() + (expired ? -1 : 3600000),
});

/** The session the store (or, before migration, the plaintext file) holds now. */
const current = (path: string, keys?: KeyProvider) =>
  withSession(path, new AbortController().signal, async (session) => session, keys);

/** By default the session is migrated into the store; `legacy` keeps only the plaintext file. */
async function setup(expired = false, legacy = false) {
  const home = await scratchHome('dominos-client-test-');
  const { directory, path } = home;
  await saveSession(path, saved(expired));

  if (!legacy) assert.equal(await migrate(path), 'migrated');
  const provider = new Provider();
  const client = new DominosClient(path, provider.request);

  return { directory, path, home, provider, client };
}


export { availability, pizza, menu, html, cart, profile, store, Provider, setup, saved, current, TOKENS };
