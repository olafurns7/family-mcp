// Preloaded into the TypeScript CLI by parity.ts: requests for Abler's origin go to the local
// fake upstream in ABLER_TEST_ORIGIN instead. Cookies and URLs the code sees are unchanged.
const origin = process.env.ABLER_TEST_ORIGIN;

if (!origin?.startsWith('http://127.0.0.1:')) throw new RangeError('ABLER_TEST_ORIGIN must be local.');
const upstream = globalThis.fetch;

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (!url.startsWith('https://www.abler.io/')) throw new RangeError('Unexpected request origin.');

    return upstream(url.replace('https://www.abler.io', origin), init);
  },
  { preconnect: upstream.preconnect },
);
