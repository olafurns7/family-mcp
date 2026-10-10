// The unchanged TS CLI uses real fetch, routed only to the local fake upstream.
const value = process.env.DOMINOS_TEST_ORIGIN;
const origin = value ? new URL(value) : undefined;
if (
  !origin ||
  origin.protocol !== 'http:' ||
  origin.hostname !== '127.0.0.1' ||
  !origin.port ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
)
  throw new Error('DOMINOS_TEST_ORIGIN must be local.');
const upstream = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const prefix =
      url.origin === 'https://api.dominos.is'
        ? ''
        : url.origin === 'https://www.dominos.is'
          ? '/website'
          : url.origin === 'https://checkoutshopper-live.adyen.com'
            ? '/adyen'
            : undefined;
    if (prefix === undefined) throw new Error('Unexpected request origin.');
    return upstream(`${origin.origin}${prefix}${url.pathname}${url.search}`, init);
  },
  { preconnect: upstream.preconnect },
);
