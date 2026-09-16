import { join } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import { readPrivateFile, writePrivateFile } from '@family-mcp/session-store';
import * as z from 'zod/v4';

import {
  exchangeToken,
  loadSession,
  locked,
  saveSession,
  sessionPath,
  type Session,
} from './auth.js';
import { orderItems, parseMenu } from './catalog.js';
import { ADYEN, API, HttpError, requestJson, requestText, WEBSITE, type Request } from './http.js';
import * as s from './schemas.js';

const deliveryStore = z.object({ RefID: z.string(), WaitingTime: z.string().nullable() });

type Checkout = z.infer<typeof s.checkout>;

function publicCheckout(value: Checkout): z.infer<typeof s.checkoutResult> {
  return {
    checkoutId: value.id,
    state: value.state,
    total: value.total,
    currency: 'ISK',
    cart: value.cart,
    orderId: value.orderId,
    expiresAt: new Date(value.expiresAt).toISOString(),
    resultCode: value.resultCode ?? null,
    cards: value.cards.map((card, index) => ({
      cardId: `card_${index + 1}`,
      brand: card.brand,
      lastFour: card.lastFour,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
    })),
  };
}

export class DominosClient {
  private readonly lifecycle = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly path = sessionPath(),
    private readonly request: Request = fetch,
  ) {}

  async close(): Promise<void> {
    this.lifecycle.abort();
    await Promise.allSettled(this.active);
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    const operation = work();
    this.active.add(operation);

    return operation.finally(() => this.active.delete(operation));
  }

  private dominos<T>(
    path: string,
    schema: z.ZodType<T>,
    session?: Session,
    body?: string,
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });

    if (session) headers.set('Authorization', `bearer ${session.accessToken}`);

    if (body !== undefined) headers.set('Content-Type', 'application/json');

    return requestJson(
      this.request,
      `${API}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body ?? null,
      },
      this.lifecycle.signal,
      schema,
    );
  }

  private async refresh(previous: Session): Promise<Session> {
    const next = await exchangeToken(
      this.request,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }),
      this.lifecycle.signal,
    );

    if (next.username !== previous.username)
      throw new SafeError(
        'The refreshed Domino’s account differs from the saved account. Sign in again.',
      );
    await saveSession(this.path, next);

    return next;
  }

  private auth<T>(work: (session: Session) => Promise<T>, retryRead = false): Promise<T> {
    return locked(this.path, this.lifecycle.signal, async () => {
      let session = await loadSession(this.path);

      if (session.expiresAt <= Date.now() + 60_000) session = await this.refresh(session);

      try {
        return await work(session);
      } catch (error) {
        // Only reads can be replayed after 401. Orders and payments are never retried here.
        if (retryRead && error instanceof HttpError && error.status === 401)
          return work(await this.refresh(session));

        throw error;
      }
    });
  }

  private file(id: string): string {
    return join(`${this.path}.checkouts`, `${s.localId.parse(id)}.json`);
  }

  private async read<T>(id: string, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(JSON.parse(await readPrivateFile(this.file(id), { maxBytes: 1048576 })));
    } catch {
      throw new SafeError(
        'The local quote or checkout is missing or invalid. Do not repeat an uncertain payment; check your Domino’s order history first.',
      );
    }
  }

  private save(value: z.infer<typeof s.quote> | Checkout): Promise<void> {
    return writePrivateFile(this.file(value.id), JSON.stringify(value) + '\n');
  }

  private menu() {
    return requestText(this.request, `${WEBSITE}/panta/pizzur`, {}, this.lifecycle.signal).then(
      parseMenu,
    );
  }

  status() {
    return this.run(() =>
      this.auth(async (session) => {
        const account = await this.dominos('user/newuser', s.profile, session);

        return { authenticated: true as const, name: account.name };
      }, true),
    );
  }

  profile() {
    return this.run(() =>
      this.auth(async (session) => {
        const account = await this.dominos('user/newuser', s.profile, session);

        return {
          id: account.id,
          name: account.name,
          phoneNumber: account.phoneNumber,
          email: account.email,
          addresses: account.savedAddress ?? [],
          savedOrders: (account.savedOrders ?? []).map(({ id, name }) => ({ id, name })),
        };
      }, true),
    );
  }

  stores() {
    return this.run(async () => ({ stores: await this.dominos('store', z.array(s.store)) }));
  }

  searchMenu(input: z.input<typeof s.menuSearch>) {
    const query = s.menuSearch.parse(input);

    return this.run(async () => {
      const menu = await this.menu();

      const groups = [
        { kind: 'pizza' as const, items: menu.menuPizzas },
        { kind: 'side' as const, items: menu.sides },
        { kind: 'sauce' as const, items: menu.sauces },
        { kind: 'beverage' as const, items: menu.beverages },
        { kind: 'offer' as const, items: menu.packages },
      ];

      const items: z.infer<typeof s.searchResult>['items'] = [];

      for (const group of groups) {
        if (query.kind && group.kind !== query.kind) continue;

        for (const item of group.items) {
          if (
            item.isHidden ||
            !item.name.toLocaleLowerCase('is').includes(query.query.toLocaleLowerCase('is'))
          )
            continue;
          items.push({
            kind: group.kind,
            id: item.id,
            name: item.name,
            description: 'description' in item ? item.description : null,
          });
        }
      }

      const end = query.offset + query.limit;

      return {
        items: items.slice(query.offset, end),
        total: items.length,
        nextOffset: end < items.length ? end : null,
      };
    });
  }

  menuItem(input: z.infer<typeof s.itemInput>) {
    const { id, kind } = s.itemInput.parse(input);

    return this.run(async () => {
      const menu = await this.menu();

      const groups = {
        pizza: [...menu.menuPizzas, menu.basePizza],
        side: menu.sides,
        sauce: menu.sauces,
        beverage: menu.beverages,
        offer: menu.packages,
      };

      const item = groups[kind].find((candidate) => candidate.id === id && !candidate.isHidden);

      if (!item)
        throw new SafeError('Menu item not found. Use search_menu to discover current IDs.');

      return {
        kind,
        item,
        toppings: kind === 'pizza' ? menu.allToppings.filter((topping) => !topping.isHidden) : [],
        allergens: menu.allergens,
      };
    });
  }

  addresses(query: string) {
    return this.run(async () => ({
      addresses: await this.dominos(
        `addresses?q=${encodeURIComponent(z.string().min(2).max(100).parse(query))}`,
        z.array(s.address),
      ),
    }));
  }

  deliveryStore(address: string, postalCode: string) {
    return this.run(() =>
      this.dominos(
        `addresses/GetAddressStoreWithWaitingTimes?${new URLSearchParams({ address, postalCode })}`,
        deliveryStore,
      ),
    );
  }

  receipts() {
    return this.run(() =>
      this.auth(
        async (session) => ({
          receipts: await this.dominos('user/getreceipts', s.receipts, session),
        }),
        true,
      ),
    );
  }

  tracker() {
    return this.run(() =>
      this.auth(
        async (session) => ({ tracker: await this.dominos('tracker', s.tracker, session) }),
        true,
      ),
    );
  }

  private async payload(cart: s.Cart, session: Session, final: boolean) {
    const items = orderItems(cart, await this.menu());
    const account = await this.dominos('user/newuser', s.profile, session);
    const fulfillment = cart.fulfillment;

    const storeId =
      fulfillment.type === 'pickup'
        ? fulfillment.storeId
        : (await this.deliveryStore(fulfillment.address.Name, fulfillment.address.PostalCode))
            .RefID;

    const stores = await this.dominos('store', z.array(s.store));
    const selected = stores.find((store) => store.RefID === storeId);

    if (
      !selected ||
      selected.Disabled ||
      selected.IsHidden ||
      !selected.AcceptInternet ||
      (fulfillment.type === 'pickup' ? !selected.AcceptsPickup : !selected.AcceptsDelivery)
    )
      throw new SafeError('The selected store is not accepting this type of online order now.');

    const location =
      fulfillment.type === 'delivery'
        ? {
            ...fulfillment.address,
            Address: fulfillment.address.Name,
            AdditionalInfo: fulfillment.instructions,
          }
        : undefined;

    const body = {
      ...items,
      User: { Name: account.name ?? '', Username: session.username, Translation: 'IS' },
      IsPickup: fulfillment.type === 'pickup',
      StoreID: fulfillment.type === 'pickup' ? storeId : undefined,
      Location: location,
      AdditionalPickupInfo: fulfillment.type === 'pickup' ? fulfillment.instructions : '',
      IsTouchFreeDelivery: false,
      IsFinal: final,
      IsCompanyOrder: false,
      CompanyDescription: '',
      CartCollection: JSON.stringify(items),
      WebCoupon: cart.coupon,
    };

    if (final)
      return JSON.stringify({
        ...body,
        AurToken: false,
        AurUserName: '',
        CouponApplied: Boolean(cart.coupon),
        IsPayed: false,
        KassResponse: false,
        KassUserName: '',
        PayToken: false,
        PayWithAur: false,
        PayWithPei: false,
        PeiToken: false,
        PayWithStraumur: true,
        PaymentMethod: null,
        CreditUsed: 0,
        Total: 0,
        Payonline: false,
        PeiPurchaseAccess: false,
        ClientID: null,
      });

    return JSON.stringify(body);
  }

  quoteOrder(input: z.input<typeof s.cartInput>) {
    const cart = s.cartInput.parse(input);

    return this.run(() =>
      this.auth(async (session) => {
        const response = await this.dominos(
          'orders',
          s.quoteResponse,
          session,
          await this.payload(cart, session, false),
        );

        if (response.Success === false || response.Total <= 0)
          throw new SafeError('Domino’s did not return a valid order quote.');

        const quote = {
          id: crypto.randomUUID(),
          username: session.username,
          cart,
          total: response.Total,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60_000,
        };

        await this.save(quote);

        return {
          quoteId: quote.id,
          total: quote.total,
          currency: 'ISK' as const,
          expiresAt: new Date(quote.expiresAt).toISOString(),
          cart,
        };
      }),
    );
  }

  private adyen<T>(
    checkout: Checkout,
    endpoint: 'setup' | 'payments',
    body: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (!checkout.sessionId || !checkout.sessionData || !checkout.clientKey)
      throw new SafeError('The payment session is incomplete. No payment was sent.');

    const url = new URL(
      `/checkoutshopper/v1/sessions/${encodeURIComponent(checkout.sessionId)}/${endpoint}`,
      ADYEN,
    );

    url.searchParams.set('clientKey', checkout.clientKey);

    // Domino’s bearer tokens are never forwarded to the payment provider.
    return requestJson(
      this.request,
      url.href,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      this.lifecycle.signal,
      schema,
    );
  }

  createCheckout(input: z.infer<typeof s.checkoutInput>) {
    const { quoteId, expectedTotal } = s.checkoutInput.parse(input);

    return this.run(() =>
      locked(this.file(quoteId), this.lifecycle.signal, () =>
        this.auth(async (session) => {
          const quote = await this.read(quoteId, s.quote);

          if (quote.username !== session.username || quote.total !== expectedTotal)
            throw new SafeError(
              'The quoted account or total does not match. Obtain and review a new quote.',
            );

          if (quote.checkoutId)
            return publicCheckout(await this.read(quote.checkoutId, s.checkout));

          if (quote.expiresAt <= Date.now())
            throw new SafeError('The quote expired. Obtain and review a new quote.');
          const body = await this.payload(quote.cart, session, true);

          const checkout: Checkout = {
            id: crypto.randomUUID(),
            quoteId,
            username: session.username,
            total: quote.total,
            cart: quote.cart,
            state: 'creating',
            expiresAt: quote.expiresAt,
            orderId: null,
            cards: [],
          };

          await this.save(checkout);
          await this.save({ ...quote, checkoutId: checkout.id });

          try {
            const order = await this.dominos('orders', s.orderResponse, session, body);

            if (order.Success === false)
              throw new SafeError('Domino’s did not accept this checkout. No payment was sent.');

            checkout.orderId = order.OrderID ?? null;
            checkout.orderGuid = order.OrderGuidId;
            checkout.sessionId = order.AdyenSessionId;
            checkout.sessionData = order.AdyenSessionData;
            checkout.clientKey = order.AdyenClientId;
            await this.save(checkout);

            const setup = await this.adyen(
              checkout,
              'setup',
              JSON.stringify({ sessionData: checkout.sessionData }),
              s.setupResponse,
            );

            checkout.sessionData = setup.sessionData;
            checkout.cards = setup.paymentMethods.storedPaymentMethods ?? [];
            checkout.expiresAt = Date.parse(setup.expiresAt);
            // Adyen uses two decimal places for ISK; Domino’s prices are whole krónur.
            checkout.state =
              order.Total === quote.total &&
              setup.amount.value === quote.total * 100 &&
              setup.id === checkout.sessionId
                ? 'ready'
                : 'amount_changed';
          } catch {
            // The upstream may have created an unpaid order. Repeating this quote never creates another.
            checkout.state = 'unknown';
          }

          await this.save(checkout);

          return publicCheckout(checkout);
        }),
      ),
    );
  }

  getCheckout(input: z.infer<typeof s.checkoutIdInput>) {
    const { checkoutId } = s.checkoutIdInput.parse(input);

    return this.run(() =>
      locked(this.file(checkoutId), this.lifecycle.signal, () =>
        this.auth(async (session) => {
          const checkout = await this.read(checkoutId, s.checkout);

          if (checkout.username !== session.username)
            throw new SafeError('This checkout belongs to a different Domino’s account.');

          if (
            checkout.orderGuid &&
            checkout.state !== 'ready' &&
            checkout.state !== 'amount_changed'
          ) {
            const result = await this.dominos(
              `orders/cart/latest?orderGuid=${encodeURIComponent(checkout.orderGuid)}`,
              s.latestCart,
              session,
            );

            if (result.OrderData && result.OrderData.IsPayed) {
              checkout.state = 'authorised';
              await this.save(checkout);
            }
          }

          return publicCheckout(checkout);
        }, true),
      ),
    );
  }

  paySavedCard(input: z.infer<typeof s.payInput>) {
    const { checkoutId, cardId, expectedTotal } = s.payInput.parse(input);

    return this.run(() =>
      locked(this.file(checkoutId), this.lifecycle.signal, () =>
        this.auth(async (session) => {
          const checkout = await this.read(checkoutId, s.checkout);

          if (checkout.username !== session.username || checkout.total !== expectedTotal)
            throw new SafeError(
              'The checkout account or amount differs from the confirmed order. No payment was sent.',
            );

          if (checkout.state !== 'ready') return publicCheckout(checkout);

          if (checkout.expiresAt <= Date.now())
            throw new SafeError('The payment session expired. No payment was sent.');
          const card = checkout.cards[Number(cardId.slice(5)) - 1];

          if (!card)
            throw new SafeError('Saved card not found in this checkout. No payment was sent.');
          checkout.state = 'submitting';
          // Commit intent before the network call; a crash or timeout must never cause a second charge.
          await this.save(checkout);

          try {
            const response = await this.adyen(
              checkout,
              'payments',
              JSON.stringify({
                sessionData: checkout.sessionData,
                paymentMethod: { type: 'scheme', storedPaymentMethodId: card.id },
                storePaymentMethod: false,
              }),
              s.paymentResponse,
            );

            checkout.sessionData = response.sessionData;
            checkout.resultCode = response.resultCode;
            checkout.state = response.action
              ? 'requires_action'
              : response.resultCode === 'Authorised'
                ? 'authorised'
                : ['Refused', 'Cancelled', 'Error'].includes(response.resultCode)
                  ? 'refused'
                  : 'pending';
          } catch {
            checkout.state = 'unknown';
          }

          await this.save(checkout);

          return publicCheckout(checkout);
        }),
      ),
    );
  }
}
