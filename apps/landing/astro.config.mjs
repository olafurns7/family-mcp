import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mcp.olinn.is',
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
});
