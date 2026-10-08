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
bun run deploy:check
bun run deploy
```

The static output in `dist/` is served by Cloudflare Workers Static Assets.
`wrangler.jsonc` pins the personal Cloudflare account and `mcp.olinn.is` custom
domain. `deploy:check` builds and runs `wrangler deploy --dry-run`, which uploads
nothing. Deployment uses the pinned Wrangler devDependency and its local login,
which is separate from a `cf` CLI login; no credentials belong in the repository
or the site. The `cf` CLI (beta) cannot deploy this project from `wrangler.jsonc`
without rewriting it, so do not run `cf deploy` here. There is no application
server, database, or analytics.

Service versions and pinned install commands are derived from the five package
manifests at build time. Before deployment, verify those versions have published
GitHub releases. Edit both languages in `src/data/content.ts`; keep the Domino’s
preview limitations and Inna's absence-submission limits in both. The setup links
point to each release's README.

Each service also has a collapsed "set it up with your coding agent" prompt,
built in `src/data/content.ts` from the same manifests. It is the same English
text on both routes; only its labels are translated. Every command in a prompt
must appear verbatim in the root README or that package's README, so update the
prompt when a sign-in or client-registration command changes there.

The Open Graph image is `public/og.png` (1200 by 630), referenced from the page
head as `https://mcp.olinn.is/og.png`. Its source and regeneration command live
in `scripts/og/`.

Archivo is self-hosted through Fontsource; its OFL license is included in
`public/archivo-license.txt`. The only client script handles copying commands
and agent prompts, including visible feedback and a manual-copy fallback.

For the browser smoke check, paste `scripts/check-copy.js` into the developer
console on each language route. It checks all ten copy buttons (five install
commands and five agent prompts), their reset, and the permission-denied fallback
without changing the system clipboard.

Design context lives in `PRODUCT.md`, `DESIGN.md`, and `.impeccable/`.
