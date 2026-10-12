// Preloaded into the TypeScript CLI by abler-parity.ts for the contract set: rust/abler-mcp/tests/
// ts/rewrite.ts, which parity.ts preloaded, with two additions that the drop-ins made in their
// own way. Requests for Abler's origin go to the local upstream in ABLER_TEST_ORIGIN, as before;
// requests for the default Chrome debugging endpoint (`http://127.0.0.1:9222`, a bare
// `auth capture`) go there too, under `/chrome-9222`, as the drop-ins' preload fetch answered
// them. And with ABLER_TEST_FORCE_REFRESH set, `AblerClient.status` forces its refresh, as the
// drop-ins' `client.status(true)` did in process and as the binary's `test-origin` seam of that
// name does. Cookies and URLs the code sees are unchanged. PR 3 deletes this script with the
// TypeScript sources.
import { AblerClient } from '../../packages/abler-mcp/src/api.ts';

const origin = process.env.ABLER_TEST_ORIGIN;

if (origin?.startsWith('http://127.0.0.1:') !== true)
  throw new RangeError('ABLER_TEST_ORIGIN must be local.');

const upstream = globalThis.fetch;

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.startsWith('https://www.abler.io/'))
      return upstream(url.replace('https://www.abler.io', origin), init);

    if (url.startsWith('http://127.0.0.1:9222/'))
      return upstream(url.replace('http://127.0.0.1:9222', `${origin}/chrome-9222`), init);

    throw new RangeError('Unexpected request origin.');
  },
  { preconnect: upstream.preconnect },
);

if (process.env.ABLER_TEST_FORCE_REFRESH !== undefined) {
  const status = AblerClient.prototype.status;

  AblerClient.prototype.status = function forced() {
    return status.call(this, true);
  };
}
