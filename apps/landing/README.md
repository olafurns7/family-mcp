# Family MCP landing page

Static Astro + TypeScript site for [mcp.olinn.is](https://mcp.olinn.is).
English lives at `/`; Icelandic lives at `/is/`.

This app has its own Bun lockfile because Astro's language service requires
TypeScript 6, while the MCP workspace uses the native TypeScript 7 compiler.

```sh
cd apps/landing
bun install --frozen-lockfile
bun run dev
```

## Check and deploy

```sh
bun run check
bunx wrangler deploy --dry-run
bun run deploy
```

The static output in `dist/` is served by Cloudflare Workers Static Assets.
`wrangler.jsonc` pins the personal Cloudflare account and `mcp.olinn.is` custom
domain. Deployment uses the local Wrangler login; no credentials belong in the
repository or the site. There is no application server, database, or analytics.

Service versions and pinned install commands are derived from the four package
manifests at build time. Before deployment, verify those versions have published
GitHub releases. Edit both languages in `src/data/content.ts`; keep the Domino’s
preview limitations in both. The setup links point to each release's README.

Archivo is self-hosted through Fontsource; its OFL license is included in
`public/archivo-license.txt`. The only client script handles copying commands,
including visible feedback and a manual-copy fallback.

For the browser smoke check, paste `scripts/check-copy.js` into the developer
console on each language route. It checks all four copy buttons, their reset,
and the permission-denied fallback without changing the system clipboard.

Design context lives in `PRODUCT.md`, `DESIGN.md`, and `.impeccable/`.
