import { defineConfig } from 'astro/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { counterscaleOrigin } from './src/data/analytics.mjs';

if (counterscaleOrigin) {
  const url = new URL(counterscaleOrigin);
  assert(
    url.protocol === 'https:' &&
      url.origin === counterscaleOrigin &&
      !isIP(url.hostname.replace(/^\[(.*)\]$/, '$1')) &&
      !/(^|\.)(localhost|example\.(com|org|net)|example|invalid|test)$/.test(url.hostname) &&
      !/(^|\.)(your-[^.]*|subdomain)(\.|$)/.test(url.hostname),
    'Counterscale requires a real HTTPS hostname, without IP literals, placeholders, a path or trailing slash',
  );
}
const headers = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8');
const csp = headers.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1];
const sources = counterscaleOrigin ? `'self' ${counterscaleOrigin}` : "'self'";
assert.equal(
  csp,
  `default-src 'self'; script-src ${sources}; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src ${sources}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
  'Keep public/_headers CSP unchanged except for counterscaleOrigin in script-src and connect-src (empty means off)',
);

export default defineConfig({
  site: 'https://mcp.olinn.is',
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
  integrations: [
    {
      name: 'check-analytics',
      hooks: {
        'astro:build:done': ({ dir }) => {
          for (const page of ['index.html', 'is/index.html']) {
            const html = readFileSync(new URL(page, dir), 'utf8');
            const tags = html.match(/<script\b[^>]*id="counterscale-script"[^>]*>/g) ?? [];
            assert.equal(tags.length, counterscaleOrigin ? 1 : 0, `${page}: analytics on/off`);
            if (counterscaleOrigin) {
              assert(
                tags[0].includes(`src="${counterscaleOrigin}/tracker.js"`),
                `${page}: tracker origin must match counterscaleOrigin`,
              );
              assert(
                tags[0].includes('data-site-id="mcp-olinn"'),
                `${page}: tracker site id must be mcp-olinn`,
              );
              assert(/\sdefer(?:[\s=>])/.test(tags[0]), `${page}: tracker must be deferred`);
            }
            assert.equal(
              html.includes('Counterscale'),
              Boolean(counterscaleOrigin),
              `${page}: analytics privacy must match the on/off state`,
            );
          }
          assert.equal(readFileSync(new URL('_headers', dir), 'utf8'), headers);
        },
      },
    },
  ],
});
