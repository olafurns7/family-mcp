import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FakeKeyProvider, SessionStoreError, type KeyProvider } from '@family-mcp/session-store';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

import manifest from '../package.json' with { type: 'json' };
import {
  loadSession,
  login,
  logout,
  migrate,
  saveSession,
  SESSION_MAX_BYTES,
  sessionStorage,
  withSession,
  type Session,
} from '../src/auth.js';
import { orderItems, parseMenu } from '../src/catalog.js';
import { DominosClient } from '../src/client.js';
import { cartInput, payInput, profileResult } from '../src/schemas.js';
import { createServer } from '../src/server.js';
import { filesContaining, scratchHome } from './scratch.js';

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

for (const legacy of [false, true])
  test(`concurrent clients serialize refresh and persist rotated tokens (${legacy ? 'plaintext file' : 'store'})`, async () => {
    const fixture = await setup(true, legacy);
    const other = new DominosClient(fixture.path, fixture.provider.request);

    try {
      await Promise.all([fixture.client.status(), other.status()]);
      assert.equal(fixture.provider.refreshes, 1);

      const bodies = fixture.provider.requests
        .filter(({ url }) => url.pathname === '/api/token')
        .map(({ options }) => options.body);

      assert.deepEqual(bodies, ['grant_type=refresh_token&refresh_token=synthetic-refresh']);
      assert.equal((await current(fixture.path)).refreshToken, 'rotated-refresh');

      if (legacy) {
        // Before migration the plaintext file stays authoritative, refreshes included.
        assert.equal((await loadSession(fixture.path)).refreshToken, 'rotated-refresh');
        await assert.rejects(stat(fixture.home.record));
        await assert.rejects(stat(`${fixture.home.record}.marker`));
        assert.equal(
          await sessionStorage(fixture.path),
          'Saved in a plaintext file. Run dominos-mcp auth migrate.',
        );
      } else {
        await assert.rejects(stat(fixture.path));
        assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
      }
    } finally {
      await Promise.all([fixture.client.close(), other.close()]);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

test('a read retried after 401 refreshes once inside the same store hold', async () => {
  const fixture = await setup();
  const { request } = fixture.provider;
  let rejected = 0;

  const client = new DominosClient(fixture.path, async (url, options) => {
    if (
      new URL(url).pathname === '/api/user/newuser' &&
      new Headers(options.headers).get('authorization') === 'bearer synthetic-access'
    ) {
      rejected++;

      return new Response('', { status: 401 });
    }

    return request(url, options);
  });

  try {
    assert.equal((await client.status()).authenticated, true);
    assert.equal(rejected, 1);
    assert.equal(fixture.provider.refreshes, 1);
    assert.equal((await current(fixture.path)).accessToken, 'rotated-access');
    assert.match(await readFile(`${fixture.home.record}.marker`, 'utf8'), /"generation":2\}/);
    assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
  } finally {
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

/** The longest JSON a schema-valid session can have, at a given token. */
const worst = (token: string): Session => ({
  version: 1,
  accessToken: token,
  refreshToken: token,
  username: '\u0001'.repeat(256),
  expiresAt: -Number.MAX_VALUE,
});

test('the largest schema-valid session fits the store, so a refreshed one is always storable', async () => {
  const home = await scratchHome('dominos-size-test-');

  try {
    const largest = worst('"'.repeat(32768));
    assert.equal(Buffer.byteLength(JSON.stringify(largest)), SESSION_MAX_BYTES);
    await assert.rejects(saveSession(home.path, worst('"'.repeat(32769))));
    await assert.rejects(saveSession(home.path, { ...largest, username: '\u0001'.repeat(257) }));

    await saveSession(home.path, largest);
    assert.equal(await migrate(home.path), 'migrated');
    assert.deepEqual(await current(home.path), largest);
  } finally {
    await home.cleanup();
  }
});

test('a refreshed session that cannot be stored poisons the old record and nothing retries', async () => {
  const fixture = await setup(true);
  const marker = `${fixture.home.record}.marker`;
  const { request } = fixture.provider;

  const client = new DominosClient(fixture.path, async (url, options) => {
    // Domino's consumes the refresh token, then the store refuses the pending marker.
    if (new URL(url).pathname === '/api/token') {
      await rename(marker, `${marker}.aside`);
      await mkdir(join(marker, 'blocked'), { recursive: true });
    }

    return request(url, options);
  });

  try {
    await assert.rejects(client.status(), /did not complete, so its session is not used/);
    assert.equal(fixture.provider.refreshes, 1);
    assert.equal(fixture.provider.requests.length, 1);
    await assert.rejects(stat(fixture.home.record));

    // Once the store works again, the consumed refresh token is never offered a second time.
    await rm(marker, { recursive: true });
    await rename(`${marker}.aside`, marker);

    for (const run of [() => client.status(), () => sessionStorage(fixture.path)])
      await assert.rejects(run(), /did not complete.*run dominos-mcp auth login again/);
    assert.equal(fixture.provider.requests.length, 1);
    assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
  } finally {
    await client.close();
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

/** Every file below the checkouts directory with its bytes. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  for (const name of await readdir(directory))
    files[name] = await readFile(join(directory, name), 'utf8');

  return files;
}

test('migrate is explicit, idempotent and leaves quotes and checkouts where they are', async () => {
  const fixture = await setup(false, true);
  const checkouts = `${fixture.path}.checkouts`;

  try {
    await fixture.client.quoteOrder(cart);
    const before = await snapshot(checkouts);
    assert.equal(Object.keys(before).length, 1);

    assert.equal(await migrate(fixture.path), 'migrated');
    await assert.rejects(stat(fixture.path));
    assert.equal(await sessionStorage(fixture.path), 'Saved in an encrypted file.');
    assert.equal((await current(fixture.path)).refreshToken, 'synthetic-refresh');
    assert.deepEqual(await filesContaining(fixture.directory, TOKENS), []);
    assert.deepEqual(await snapshot(checkouts), before);
    assert.equal(await migrate(fixture.path), 'already');

    // A stale plaintext file planted after migration is never read, and migrate removes it.
    await saveSession(fixture.path, saved(false, 'planted'));
    assert.equal((await fixture.client.status()).authenticated, true);
    assert.equal((await current(fixture.path)).accessToken, 'synthetic-access');
    assert.equal(await migrate(fixture.path), 'already-removed-legacy');
    await assert.rejects(stat(fixture.path));

    // Logout keeps the store deciding: a planted file is still ignored.
    await logout(fixture.path);
    await assert.rejects(stat(fixture.path));
    assert.deepEqual(await snapshot(checkouts), before);
    await saveSession(fixture.path, saved(false, 'planted'));
    await assert.rejects(fixture.client.status(), /No saved Domino’s session/);
    await assert.rejects(sessionStorage(fixture.path), /No saved Domino’s session/);
    assert.equal(await migrate(fixture.path), 'already-removed-legacy');
    assert.equal(
      fixture.provider.requests.some(({ options }) =>
        new Headers(options.headers).get('authorization')?.includes('planted'),
      ),
      false,
    );
    assert.deepEqual(await snapshot(checkouts), before);
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('without any saved session every command says to sign in', async () => {
  const home = await scratchHome('dominos-empty-test-');

  try {
    await assert.rejects(sessionStorage(home.path), /No saved Domino’s session/);
    await assert.rejects(migrate(home.path), /No saved Domino’s session/);
    await logout(home.path);
    await assert.rejects(stat(home.record));
  } finally {
    await home.cleanup();
  }
});

const failing = (code: SessionStoreError['code']): KeyProvider => ({
  backend: 'test',
  keySource: 'memory',
  keyId: 'test',
  getKey: async () => {
    throw new SessionStoreError(code, 'synthetic key failure');
  },
  createKey: async () => undefined,
});

test('store failures have fixed messages, change no file and never fall back', async () => {
  const fixture = await setup(false, true);
  const keys = new FakeKeyProvider(new Uint8Array(32).fill(7));
  const marker = `${fixture.home.record}.marker`;

  try {
    assert.equal(await migrate(fixture.path, keys), 'migrated');
    await saveSession(fixture.path, saved(false, 'planted'));

    const files = async () => [
      await readFile(fixture.home.record, 'utf8'),
      await readFile(marker, 'utf8'),
      await readFile(fixture.path, 'utf8'),
    ];

    const before = await files();

    for (const [code, message] of [
      ['STORE_LOCKED', /Unlock your login keychain and try again\./],
      ['STORE_TIMEOUT', /did not answer in time/],
      ['STORE_ACCESS_DENIED', /Allow dominos-mcp to use the login keychain/],
      ['STORE_UNAVAILABLE', /store key is missing\. Run dominos-mcp auth login/],
      ['STORE_ERROR', /damaged, unsafe, or not readable/],
    ] as const) {
      const client = new DominosClient(fixture.path, fixture.provider.request, failing(code));

      try {
        await assert.rejects(client.status(), message);
      } finally {
        await client.close();
      }

      await assert.rejects(migrate(fixture.path, failing(code)), message);
      await assert.rejects(logout(fixture.path, failing(code)), message);
      assert.deepEqual(await files(), before);
    }

    // The wrong key, and a record without its marker, are refused without a fallback.
    await assert.rejects(
      current(fixture.path, new FakeKeyProvider(new Uint8Array(32).fill(8))),
      /damaged, unsafe, or not readable/,
    );
    await rm(marker);
    await assert.rejects(
      current(fixture.path, keys),
      /did not complete, so its session is not used/,
    );
    assert.equal(fixture.provider.requests.length, 0);

    for (const error of await Promise.allSettled([
      migrate(fixture.path, failing('STORE_LOCKED')),
      current(fixture.path, keys),
    ]))
      assert.ok(
        error.status === 'rejected' &&
          error.reason instanceof Error &&
          !error.reason.message.includes(fixture.directory) &&
          !TOKENS.some((token) => String(error.reason).includes(token)),
      );
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a lost key fails closed until an explicit login replaces the store', async () => {
  const fixture = await setup();

  try {
    await rm(fixture.home.key);
    await saveSession(fixture.path, saved(false, 'planted'));
    await assert.rejects(fixture.client.status(), /store key is missing/);
    assert.equal(fixture.provider.requests.length, 0);
    await assert.rejects(sessionStorage(fixture.path), /store key is missing/);
    await assert.rejects(migrate(fixture.path), /store key is missing/);
    await assert.rejects(logout(fixture.path), /store key is missing/);
    assert.ok(await stat(fixture.path));

    assert.equal(await login('5550123', '123456', fixture.path, fixture.provider.request), true);
    await assert.rejects(stat(fixture.path));
    assert.equal((await fixture.client.status()).authenticated, true);
    assert.match(await readFile(`${fixture.home.record}.marker`, 'utf8'), /"generation":1\}/);
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a session path that aliases the store, its key or the checkouts is refused untouched', async () => {
  const fixture = await setup();
  const { record, key } = fixture.home;
  const storeDirectory = join(fixture.directory, 'config', 'dominos-mcp');
  const aliased = join(fixture.directory, 'aliased');
  await mkdir(aliased);
  await symlink(storeDirectory, join(aliased, 'session.checkouts'));
  await symlink(storeDirectory, join(fixture.directory, 'linked'));
  // Checkouts planted under a record temporary's exact name: refused, and never swept.
  const temporary = `${record}.${randomUUID()}.tmp`;
  const planted = join(temporary, 'session.json.checkouts', 'quote.json');
  await mkdir(dirname(planted), { recursive: true });
  await writeFile(planted, 'kept');
  await utimes(temporary, new Date(0), new Date(0));
  await symlink(temporary, join(aliased, 'temporary.checkouts'));

  const files = async () => [
    await readFile(record),
    await readFile(`${record}.marker`),
    await readFile(key),
  ];

  const before = await files();

  try {
    for (const path of [
      record,
      `${record}.marker`,
      `${record}.lock`,
      `${record}.tmp`,
      join(storeDirectory, 'session'),
      join(fixture.directory, 'linked', 'session.enc'),
      join(storeDirectory, 'nested', '..', 'session.enc'),
      key,
      storeDirectory,
      join(aliased, 'session'),
      join(temporary, 'session.json'),
      join(aliased, 'temporary'),
      join(dirname(key), 'dominos-mcp.default.key.lock', 'session.json'),
    ]) {
      for (const run of [
        () => login('5550123', '123456', path, fixture.provider.request),
        () => migrate(path),
        () => logout(path),
      ])
        await assert.rejects(run(), /DOMINOS_SESSION_FILE overlaps/);
      assert.deepEqual(await files(), before);
    }

    assert.equal(fixture.provider.requests.length, 0);
    assert.equal((await fixture.client.status()).authenticated, true);
    assert.equal(await readFile(planted, 'utf8'), 'kept');
  } finally {
    await fixture.client.close();
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
