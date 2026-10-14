import { defineConfig } from 'astro/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { counterscaleOrigin } from './src/data/analytics.mjs';

if (counterscaleOrigin) {
  const url = new URL(counterscaleOrigin);
  assert(
    url.protocol === 'https:' &&
      url.origin === counterscaleOrigin &&
      !/(^|\.)(localhost|example\.(com|org|net)|example|invalid|test)$/.test(url.hostname),
    'Counterscale requires a real HTTPS origin, without a path or trailing slash',
  );
}
const headers = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8');
const csp = headers.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1];
const sources = counterscaleOrigin ? `'self' ${counterscaleOrigin}` : "'self'";
for (const directive of ['script-src', 'connect-src']) {
  assert.equal(
    csp
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${directive} `)),
    `${directive} ${sources}`,
    `Update public/_headers ${directive} together with counterscaleOrigin (empty means off)`,
  );
}

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
              assert(tags[0].includes(`src="${counterscaleOrigin}/tracker.js"`));
              assert(tags[0].includes('data-site-id="mcp-olinn"'));
              assert(/\sdefer(?:[\s=>])/.test(tags[0]));
            }
          }
          assert.equal(readFileSync(new URL('_headers', dir), 'utf8'), headers);
        },
      },
    },
  ],
});
