// Preloaded into the TypeScript CLI by parity.ts: requests for InfoMentor's hosts go to the local
// fake upstream in INFOMENTOR_TEST_ORIGIN instead, as `<origin>/<host><path><query>`, which is
// where the Rust binary built with `test-origin` sends them. Cookies and URLs the code sees are
// unchanged.
const origin = process.env.INFOMENTOR_TEST_ORIGIN;

if (!origin?.startsWith('http://127.0.0.1:'))
  throw new RangeError('INFOMENTOR_TEST_ORIGIN must be local.');
const upstream = globalThis.fetch;

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));

    if (
      url.protocol !== 'https:' ||
      url.port ||
      !(url.hostname === 'infomentor.is' || url.hostname.endsWith('.infomentor.is'))
    )
      throw new RangeError('Unexpected request origin.');

    return upstream(`${origin}/${url.hostname}${url.pathname}${url.search}`, init);
  },
  { preconnect: upstream.preconnect },
);
