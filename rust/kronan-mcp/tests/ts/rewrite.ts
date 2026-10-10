// Preloaded into the TypeScript CLI by parity.ts: requests for Krónan's origin go to the local
// fake upstream in KRONAN_TEST_ORIGIN instead. URLs and headers the code sees are unchanged.
const origin = process.env.KRONAN_TEST_ORIGIN;

if (!origin?.startsWith('http://127.0.0.1:')) throw new RangeError('KRONAN_TEST_ORIGIN must be local.');
const upstream = globalThis.fetch;

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (!url.startsWith('https://api.kronan.is/')) throw new RangeError('Unexpected request origin.');

    return upstream(url.replace('https://api.kronan.is', origin), init);
  },
  { preconnect: upstream.preconnect },
);
