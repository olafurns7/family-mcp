// Original TS integration cases; Rust: the client/auth actions execute the stdio/CLI binary.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cartInput, payInput } from '../../../../packages/dominos-mcp/src/schemas.ts';
import { saveSession } from '../../../../packages/dominos-mcp/src/auth.ts';
import { DominosClient, migrate, logout, sessionStorage } from './rust-dominos.ts';
import { setup, cart, current, saved, TOKENS } from './fixtures.ts';
import { filesContaining } from './scratch.ts';
/** Every file below the checkouts directory with its bytes. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  for (const name of await readdir(directory))
    files[name] = await readFile(join(directory, name), 'utf8');

  return files;
}

test('a 401 during checkout or payment is never retried', async () => {
  const fixture = await setup();
  const { request } = fixture.provider;
  let reject = '';

  const client = new DominosClient(fixture.path, async (url, options) => {
    if (reject !== '' && new URL(url).pathname.endsWith(reject)) {
      reject = '';

      return new Response('', { status: 401 });
    }

    return request(url, options);
  });

  try {
    const quote = await client.quoteOrder(cart);
    const input = { quoteId: quote.quoteId, expectedTotal: quote.total };
    reject = '/api/user/newuser';
    await assert.rejects(client.createCheckout(input), /No automatic retry was made/);
    assert.equal(fixture.provider.refreshes, 0);
    assert.equal(fixture.provider.orders, 0);

    const checkout = await client.createCheckout(input);
    assert.equal(checkout.state, 'ready');
    reject = '/payments';

    const paid = await client.paySavedCard({
      checkoutId: checkout.checkoutId,
      cardId: 'card_1',
      expectedTotal: checkout.total,
      confirm: true,
    });

    // The payment call's 401 never reaches the retry: the attempt is recorded as unknown.
    assert.equal(paid.state, 'unknown');
    assert.equal(fixture.provider.payments, 0);
    assert.equal(fixture.provider.refreshes, 0);
    assert.equal(fixture.provider.orders, 1);
  } finally {
    await client.close();
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

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
