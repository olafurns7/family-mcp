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
without rewriting it, so do not run `cf deploy` here. The landing page is static.
Optional Counterscale analytics runs separately in the site owner's Cloudflare
account and is off until an origin is configured below.

## Analytics

The owner runs these steps in their own terminal, outside this repository.
No API tokens or dashboard passwords belong in the repo or site configuration.
These instructions were checked against [Counterscale v3.4.1](https://github.com/benvinegar/counterscale/releases/tag/v3.4.1).

1. Use macOS or Linux with Node 20 or newer. In the owner's Cloudflare account,
   set up a Workers subdomain and enable **Storage & Databases → Analytics
   Engine**. Create a token scoped to that account with **Account → Account
   Analytics → Read**. This is the dashboard's query token; Wrangler's separate
   login grants deployment access.
2. In the owner's terminal:

   ```sh
   npx wrangler login
   npx @counterscale/cli@3.4.1 install
   ```

   Select the owner's account if prompted. Enter the token only at the
   installer's prompt, enable dashboard password protection, then approve the
   deployment. Defaults are Worker `counterscale`, Analytics Engine dataset
   `metricsDataset`, and R2 rollup storage (`counterscale-daily-rollups` with a
   development bucket binding); the rollup cron runs daily at 02:00 UTC. If those
   names already belong to another deployment, stop before replacing it; use
   `npx @counterscale/cli@3.4.1 install --advanced` to choose separate Worker and
   dataset names. The installer prints the dashboard's `https://…workers.dev`
   origin. Log in there with the dashboard password.

3. Optionally add `stats.olinn.is`: in Cloudflare **Workers & Pages → counterscale
   → Settings → Domains & Routes → Add → Custom Domain**, enter `stats.olinn.is`
   and confirm. The `olinn.is` zone must be active in the same account; Cloudflare
   creates the DNS record and certificate. Otherwise keep the emitted
   `workers.dev` origin. The dashboard is at `/` on the chosen origin.
4. Set `counterscaleOrigin` in `src/data/analytics.mjs` to that real HTTPS origin
   (no trailing slash or path). In `public/_headers`, add **the same exact origin**
   after `'self'` in both `script-src` and `connect-src`; change no other directive.
   For example, only after that custom domain is live:

   ```js
   export const counterscaleOrigin = 'https://stats.olinn.is';
   ```

   ```text
   script-src 'self' https://stats.olinn.is;
   connect-src 'self' https://stats.olinn.is;
   ```

   The existing script uses site id **`mcp-olinn`** on `/` and `/is/`, keeping these
   counts separate from `olinn.is` (give that site a different id if tracked).
   The standalone 404 page has no tracker. No npm tracker dependency is needed:
   the Worker serves `/tracker.js`, and reports go to its `/cache` and `/collect`.

5. Run `bun run check` in this app before the usual site deployment. It rejects
   invalid/example origins or a CSP mismatch and checks both built pages for
   exactly one deferred tracker with site id `mcp-olinn` when enabled, and none
   when off. Leave the constant empty to keep tracking off and the CSP at
   `script-src 'self'; connect-src 'self'`. To disable later, empty the constant
   and remove its origin from both directives together. After the owner deploys
   the site, visits appear under `mcp-olinn` in the Counterscale dashboard.

Counterscale provides anonymous, cookie-less visit counts in the owner's own
Cloudflare account. It receives no MCP sign-in or account data, and sends
nothing to ad networks. “Anonymous” means no named account or persistent visitor
id: it is not a promise of zero personal data. v3.4.1 uses HTTP browser cache
metadata to count repeat visits (no cookies, localStorage or sessionStorage),
and records site/host, page path, referrer, user agent, browser/device, country
and any collected UTM campaign fields. Cloudflare still receives requests and
network addresses; paths, referrers and campaign values can contain identifying
text, so never put personal information in them. The English and Icelandic
pages use canonical URLs without query strings. Analytics Engine keeps up to
90 days; default R2 rollups retain data longer. Dashboard sign-in uses a separate
authentication cookie, unrelated to visitor tracking.

Sources: [installation and integration](https://github.com/benvinegar/counterscale/blob/v3.4.1/README.md),
[tracker](https://github.com/benvinegar/counterscale/tree/v3.4.1/packages/tracker/src),
[collection](https://github.com/benvinegar/counterscale/blob/v3.4.1/packages/server/app/analytics/collect.ts),
[Worker resources](https://github.com/benvinegar/counterscale/blob/v3.4.1/packages/server/wrangler.json),
[custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

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
`public/archivo-license.txt`. The bundled client script handles copying commands
and agent prompts, including visible feedback and a manual-copy fallback; the
optional analytics script is loaded separately from the owner's Worker.

The "Start here" block above the server list offers one beginner setup prompt,
including optional read-only morning and evening-before routines. It uses the
same server data and setup instructions as the individual prompts. Its labels
are translated; the prompt stays English and asks the assistant to reply in the
user's language.

For the browser smoke check, paste `scripts/check-copy.js` into the developer
console on each language route. It checks all thirteen copy buttons (six install
commands, six server prompts and the start prompt), their reset, and the
permission-denied fallback without changing the system clipboard. It also checks
that the start prompt includes every install command and release README and ends
with the questions-tool instruction.

Design context lives in `PRODUCT.md`, `DESIGN.md`, and `.impeccable/`.
