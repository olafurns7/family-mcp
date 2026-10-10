import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DominosClient as Reference } from '../../../../packages/dominos-mcp/src/client.ts';
import { cartInput } from '../../../../packages/dominos-mcp/src/schemas.ts';
import { writePrivateFile } from '@family-mcp/session-store';
import { DominosClient as Rust } from './rust-dominos.ts';
import { setup, cart, store } from './fixtures.ts';
const Q = '10000000-0000-4000-8000-000000000001';
const C = '10000000-0000-4000-8000-000000000002';
const FUTURE = Date.parse('2100-01-01T00:00:00Z');
const cleanCart = cartInput.parse(cart);
const card = {
  id: 'private-vault-token',
  type: 'scheme',
  brand: 'visa',
  lastFour: '1234',
  expiryMonth: '12',
  expiryYear: '2030',
};
const quote = {
  id: Q,
  username: '3545550123',
  cart: cleanCart,
  total: 2500,
  createdAt: 0,
  expiresAt: FUTURE,
};
const checkout = {
  id: C,
  quoteId: Q,
  username: '3545550123',
  cart: cleanCart,
  total: 2500,
  state: 'ready',
  expiresAt: FUTURE,
  orderId: 123,
  orderGuid: 'private-guid',
  sessionId: 'private-session',
  sessionData: 'private-session-data',
  clientKey: 'private-client-key',
  cards: [card],
};
function normalized(value: unknown): unknown {
  if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) return 'UUID';
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'expiresAt' && typeof v === 'string' ? 'ISO' : normalized(v),
      ]),
    );
  return value;
}
type Scenario = {
  name: string;
  tool: 'quote' | 'create' | 'get' | 'pay';
  patch?: Record<string, unknown>;
  mode?: string;
  total?: number;
  cardId?: string;
  cart?: object;
};
const scenarios: Scenario[] = [
  { name: 'quote pickup', tool: 'quote' },
  {
    name: 'quote delivery',
    tool: 'quote',
    cart: {
      ...cart,
      fulfillment: {
        type: 'delivery',
        address: { ID: 42, Name: 'Test & ð', PostalCode: '100', PostalCodeName: 'Test' },
        instructions: 'Door 2',
      },
      coupon: 'SYNTHETIC',
    },
  },
  {
    name: 'quote menu selection refusal',
    tool: 'quote',
    cart: { ...cart, pizzas: [{ ...cart.pizzas[0], sections: [{ pizzaId: 'UNKNOWN' }] }] },
  },
  ...['quote-zero', 'quote-fraction', 'quote-401', 'store-disabled'].map((mode) => ({
    name: mode,
    tool: 'quote' as const,
    mode,
  })),
  { name: 'create ready', tool: 'create' },
  { name: 'quote account changed', tool: 'create', patch: { username: 'other' } },
  { name: 'quote confirmed total changed', tool: 'create', total: 2501 },
  { name: 'quote expired', tool: 'create', patch: { expiresAt: 0 } },
  {
    name: 'quote already used despite expiry',
    tool: 'create',
    patch: { expiresAt: 0, checkoutId: C },
  },
  {
    name: 'quote linked checkout missing',
    tool: 'create',
    patch: { checkoutId: '10000000-0000-4000-8000-000000000003' },
  },
  ...[
    'order-lost',
    'order-rejected',
    'order-schema',
    'order-total',
    'setup-amount',
    'setup-currency',
    'setup-id',
    'setup-date',
    'setup-schema',
  ].map((mode) => ({ name: mode, tool: 'create' as const, mode })),
  { name: 'payment confirmed total changed', tool: 'pay', total: 2501 },
  { name: 'payment account changed', tool: 'pay', patch: { username: 'other' } },
  { name: 'payment expired', tool: 'pay', patch: { expiresAt: 0 } },
  { name: 'payment card missing', tool: 'pay', cardId: 'card_0' },
  { name: 'payment card numeric overflow', tool: 'pay', cardId: `card_${'9'.repeat(400)}` },
  { name: 'payment empty session refuses without send', tool: 'pay', patch: { sessionData: '' } },
  ...[
    'creating',
    'submitting',
    'authorised',
    'refused',
    'pending',
    'requires_action',
    'unknown',
    'amount_changed',
  ].map((state) => ({ name: `payment already ${state}`, tool: 'pay' as const, patch: { state } })),
  ...[
    'Authorised',
    'Refused',
    'Cancelled',
    'Error',
    'Pending',
    'action',
    'payment-schema',
    'payment-401',
    'payment-lost',
  ].map((mode) => ({ name: mode, tool: 'pay' as const, mode })),
  { name: 'get different account', tool: 'get', patch: { username: 'other' } },
  { name: 'get unknown unpaid', tool: 'get', patch: { state: 'unknown' } },
  { name: 'get unknown paid', tool: 'get', patch: { state: 'unknown' }, mode: 'latest-paid' },
  {
    name: 'get nonempty string invalid latest',
    tool: 'get',
    patch: { state: 'unknown' },
    mode: 'latest-schema',
  },
  {
    name: 'get empty string latest',
    tool: 'get',
    patch: { state: 'unknown' },
    mode: 'latest-empty',
  },
  { name: 'get ready never reconciles', tool: 'get', mode: 'latest-schema' },
  { name: 'local record invalid schema', tool: 'get', patch: { total: 1.5 } },
  { name: 'local record invalid json', tool: 'get', mode: 'record-json' },
  { name: 'local record oversized', tool: 'get', mode: 'record-large' },
];
export async function moneyParity() {
  for (const scenario of scenarios) {
    const outcomes = [];
    for (const Type of [Reference, Rust]) {
      const fixture = await setup();
      const calls: { url: string; method: string; authorization: string | null; body: unknown }[] =
        [];
      const client = new Type(fixture.path, async (url, options) => {
        const target = new URL(url);
        const authorization = new Headers(options.headers).get('authorization');
        let body: unknown = options.body ?? null;
        if (typeof body === 'string' && body.startsWith('{')) body = JSON.parse(body);
        calls.push({ url, method: options.method ?? 'GET', authorization, body });
        if (target.hostname === 'checkoutshopper-live.adyen.com') assert.equal(authorization, null);
        if (target.pathname.endsWith('/GetAddressStoreWithWaitingTimes'))
          return Response.json({ RefID: '1', WaitingTime: null });
        if (scenario.mode === 'store-disabled' && target.pathname === '/api/store')
          return Response.json([{ ...store, Disabled: true }]);
        if (target.pathname === '/api/orders') {
          if (scenario.mode === 'quote-401') return new Response('secret-body', { status: 401 });
          if (scenario.mode === 'quote-zero') return Response.json({ Total: 0 });
          if (scenario.mode === 'quote-fraction') return Response.json({ Total: 1.5 });
          if (scenario.mode === 'order-lost') throw new Error('secret-transport');
          if (scenario.mode === 'order-schema')
            return Response.json({ Total: 2500, AdyenSessionId: 'secret-bad/id' });
        }
        if (target.pathname.endsWith('/payments')) {
          if (scenario.mode === 'payment-lost') throw new Error('secret-payment');
          if (scenario.mode === 'payment-401')
            return new Response('secret-payment', { status: 401 });
          if (scenario.mode === 'payment-schema')
            return Response.json({ secret: 'secret-payment' });
          if (scenario.mode === 'action')
            return Response.json({
              sessionData: 'private-next',
              resultCode: 'ChallengeShopper',
              action: { type: 'redirect', url: 'https://example.invalid/private-action' },
            });
          if (scenario.mode)
            return Response.json({ sessionData: 'private-next', resultCode: scenario.mode });
        }
        if (target.pathname.endsWith('/cart/latest')) {
          if (scenario.mode === 'latest-paid')
            return Response.json({ OrderData: { IsPayed: true, secret: 'secret-order' } });
          if (scenario.mode === 'latest-schema')
            return Response.json({ OrderData: 'secret-order' });
          if (scenario.mode === 'latest-empty') return Response.json({ OrderData: '' });
        }
        const response = await fixture.provider.request(url, options);
        if (target.pathname === '/api/orders' && scenario.mode === 'order-rejected')
          return Response.json({ ...(await response.json()), Success: false });
        if (target.pathname === '/api/orders' && scenario.mode === 'order-total')
          return Response.json({ ...(await response.json()), Total: 2501 });
        if (target.pathname.endsWith('/setup')) {
          const value = await response.json();
          value.expiresAt = '2100-01-01T00:00:00Z';
          if (scenario.mode === 'setup-amount') value.amount.value = 2500;
          if (scenario.mode === 'setup-currency') value.amount.currency = 'EUR';
          if (scenario.mode === 'setup-id') value.id = 'private-other';
          if (scenario.mode === 'setup-date') value.expiresAt = '2100-02-29T00:00:00Z';
          if (scenario.mode === 'setup-schema')
            value.paymentMethods.storedPaymentMethods[0].lastFour = 'secret';
          return Response.json(value);
        }
        return response;
      });
      try {
        const directory = `${fixture.path}.checkouts`;
        await writePrivateFile(
          `${directory}/${Q}.json`,
          JSON.stringify({ ...quote, ...(scenario.tool === 'create' ? scenario.patch : {}) }),
        );
        await writePrivateFile(
          `${directory}/${C}.json`,
          JSON.stringify({ ...checkout, ...(scenario.tool !== 'create' ? scenario.patch : {}) }),
        );
        if (scenario.mode === 'record-json')
          await writePrivateFile(`${directory}/${C}.json`, 'secret-invalid-json');
        if (scenario.mode === 'record-large')
          await writePrivateFile(`${directory}/${C}.json`, 'x'.repeat(1048577));
        let result: unknown;
        try {
          result =
            scenario.tool === 'quote'
              ? await client.quoteOrder(scenario.cart ?? cart)
              : scenario.tool === 'create'
                ? await client.createCheckout({ quoteId: Q, expectedTotal: scenario.total ?? 2500 })
                : scenario.tool === 'get'
                  ? await client.getCheckout({ checkoutId: C })
                  : await client.paySavedCard({
                      checkoutId: C,
                      cardId: scenario.cardId ?? 'card_1',
                      expectedTotal: scenario.total ?? 2500,
                      confirm: true,
                    });
        } catch (error) {
          result = { error: (error as Error).message };
        }
        assert.ok(!JSON.stringify(result).includes('secret-'));
        assert.ok(!JSON.stringify(result).includes('private-'));
        const states: unknown[] = [];
        for (const id of [Q, C]) {
          const text = await readFile(`${directory}/${id}.json`, 'utf8');
          try {
            const parsed = JSON.parse(text);
            states.push(parsed.state ?? null);
          } catch {
            states.push('invalid');
          }
        }
        outcomes.push({ result: normalized(result), calls, states });
      } finally {
        await Promise.all([client.close(), fixture.client.close()]);
        await fixture.home.cleanup();
      }
    }
    assert.deepEqual(outcomes[1], outcomes[0], scenario.name);
  }
  return scenarios.length;
}
