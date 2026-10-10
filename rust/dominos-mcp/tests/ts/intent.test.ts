// Real private-file failures and an owned process crash after a synthetic provider sees the send.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, rmdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { DominosClient as Reference } from '../../../../packages/dominos-mcp/src/client.ts';
import { DominosClient as Rust } from './rust-dominos.ts';
import { setup, cart } from './fixtures.ts';
for (const Type of [Reference, Rust])
  for (const phase of ['create', 'pay'])
    test(`${Type === Rust ? 'Rust' : 'TS'} ${phase} retains intent when post-send persistence fails`, async () => {
      const fixture = await setup();
      let unsafeDirectory: string | undefined;
      let intent: string | undefined;
      let paymentSends = 0;
      let finalOrderSends = 0;
      let inject = false;
      const client = new Type(fixture.path, async (url, options) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/payments')) paymentSends++;
        if (path === '/api/orders' && JSON.parse(options.body as string).IsFinal) finalOrderSends++;
        const response = await fixture.provider.request(url, options);
        const trigger =
          phase === 'pay'
            ? path.endsWith('/payments')
            : path === '/api/orders' && JSON.parse(options.body as string).IsFinal;
        if (inject && trigger) {
          const directory = `${fixture.path}.checkouts`;
          for (const name of await readdir(directory)) {
            if (!name.endsWith('.json')) continue;
            const file = `${directory}/${name}`;
            const record = JSON.parse(await readFile(file, 'utf8'));
            if (record.state === (phase === 'pay' ? 'submitting' : 'creating')) {
              intent = file;
              unsafeDirectory = directory;
              await chmod(directory, 0o500);
            }
          }
          assert.ok(unsafeDirectory, 'Intent must be committed before the send reaches the fake.');
        }
        return response;
      });
      try {
        const quote = await client.quoteOrder(cart);
        const create = { quoteId: quote.quoteId, expectedTotal: quote.total };
        if (phase === 'create') {
          inject = true;
          await assert.rejects(
            client.createCheckout(create),
            /Cannot safely access the local Domino’s session/,
          );
          assert.ok(intent && unsafeDirectory);
          await chmod(unsafeDirectory, 0o700);
          for (const name of await readdir(unsafeDirectory))
            if (name.endsWith('.lock')) await rmdir(`${unsafeDirectory}/${name}`);
          unsafeDirectory = undefined;
          assert.equal(JSON.parse(await readFile(intent, 'utf8')).state, 'creating');

          assert.equal((await client.createCheckout(create)).state, 'creating');
          assert.equal(finalOrderSends, 1);
          assert.equal(paymentSends, 0);
        } else {
          const checkout = await client.createCheckout(create);
          const pay = {
            checkoutId: checkout.checkoutId,
            cardId: 'card_1',
            expectedTotal: checkout.total,
            confirm: true as const,
          };
          inject = true;
          await assert.rejects(
            client.paySavedCard(pay),
            /Cannot safely access the local Domino’s session/,
          );
          assert.ok(intent && unsafeDirectory);
          await chmod(unsafeDirectory, 0o700);
          for (const name of await readdir(unsafeDirectory))
            if (name.endsWith('.lock')) await rmdir(`${unsafeDirectory}/${name}`);
          unsafeDirectory = undefined;
          assert.equal(JSON.parse(await readFile(intent, 'utf8')).state, 'submitting');

          assert.equal((await client.paySavedCard(pay)).state, 'submitting');
          assert.equal(paymentSends, 1);
        }
      } finally {
        if (unsafeDirectory) await chmod(unsafeDirectory, 0o700);
        await Promise.all([client.close(), fixture.client.close()]);
        await fixture.home.cleanup();
      }
    });

test('a killed Rust payment process leaves submitting intent and a restart sends nothing', async () => {
  const fixture = await setup();
  let reached!: () => void;
  const sent = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let sends = 0;
  const driver = new Rust(fixture.path, async (url, options) => {
    if (new URL(url).pathname.endsWith('/payments')) {
      sends++;
      reached();
      return new Promise<Response>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(new Response()), { once: true }),
      );
    }
    return fixture.provider.request(url, options);
  });
  const mcp = new Client({ name: 'synthetic-intent-crash', version: '1' });
  const serve = await driver.serve();
  try {
    const quote = await fixture.client.quoteOrder(cart);
    const checkout = await fixture.client.createCheckout({
      quoteId: quote.quoteId,
      expectedTotal: quote.total,
    });
    const pay = {
      checkoutId: checkout.checkoutId,
      cardId: 'card_1',
      expectedTotal: checkout.total,
      confirm: true as const,
    };
    await mcp.connect(serve.transport);
    const result = mcp.callTool({ name: 'pay_saved_card', arguments: pay }).then(
      () => false,
      () => true,
    );
    await sent;
    assert.equal(
      JSON.parse(await readFile(`${fixture.path}.checkouts/${checkout.checkoutId}.json`, 'utf8'))
        .state,
      'submitting',
    );
    assert.ok(serve.transport.pid);
    process.kill(serve.transport.pid, 'SIGKILL');
    assert.equal(await result, true);
    // The OS reaps the holder; family-store safely takes over the stale lock on restart.
    assert.equal((await driver.paySavedCard(pay)).state, 'submitting');
    assert.equal(sends, 1);
  } finally {
    await Promise.all([mcp.close(), driver.close(), fixture.client.close()]);
    await serve.close();
    await fixture.home.cleanup();
  }
});

test('host cancellation does not change the payment outcome or abort the provider', async () => {
  const fixture = await setup();
  let reached!: () => void;
  const sent = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let providerAborted = false;
  const driver = new Rust(fixture.path, async (url, options) => {
    const response = await fixture.provider.request(url, options);
    if (new URL(url).pathname.endsWith('/payments')) {
      options.signal!.addEventListener(
        'abort',
        () => {
          providerAborted = true;
        },
        { once: true },
      );
      reached();
      await held;
      assert.equal(providerAborted, false);
    }
    return response;
  });
  const mcp = new Client({ name: 'synthetic-host-cancel', version: '1' });
  const serve = await driver.serve();
  try {
    const quote = await fixture.client.quoteOrder(cart);
    const checkout = await fixture.client.createCheckout({
      quoteId: quote.quoteId,
      expectedTotal: quote.total,
    });
    const args = {
      checkoutId: checkout.checkoutId,
      cardId: 'card_1',
      expectedTotal: checkout.total,
      confirm: true as const,
    };
    await mcp.connect(serve.transport);
    const controller = new AbortController();
    const result = mcp
      .callTool({ name: 'pay_saved_card', arguments: args }, { signal: controller.signal })
      .then(
        () => false,
        () => true,
      );
    await sent;
    controller.abort();
    assert.equal(await result, true);
    release();
    assert.equal(
      (await fixture.client.getCheckout({ checkoutId: checkout.checkoutId })).state,
      'authorised',
    );
    assert.equal(fixture.provider.payments, 1);
  } finally {
    release();
    await Promise.all([mcp.close(), driver.close(), fixture.client.close()]);
    await serve.close();
    await fixture.home.cleanup();
  }
});
