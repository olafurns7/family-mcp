// Preloaded into the TypeScript CLI by parity.ts: requests for Inna's hosts go to the local fake
// upstream in INNA_TEST_ORIGIN instead, as `<origin>/<host><path><query>`, which is where the Rust
// binary built with `test-origin` sends them, and `Date.now` reads the clock file in INNA_TEST_NOW,
// as the binary's clock does. Cookies and URLs the code sees are unchanged.
import { readFileSync } from 'node:fs';

const origin = process.env.INNA_TEST_ORIGIN;

if (!origin?.startsWith('http://127.0.0.1:')) throw new RangeError('INNA_TEST_ORIGIN must be local.');
const clock = process.env.INNA_TEST_NOW;

if (clock) Date.now = () => Number(readFileSync(clock, 'utf8'));
const upstream = globalThis.fetch;

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));

    if (
      url.protocol !== 'https:' ||
      url.port ||
      !(url.hostname === 'inna.is' || url.hostname.endsWith('.inna.is'))
    )
      throw new RangeError('Unexpected request origin.');

    return upstream(`${origin}/${url.hostname}${url.pathname}${url.search}`, init);
  },
  { preconnect: upstream.preconnect },
);
