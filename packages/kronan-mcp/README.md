# kronan-mcp

Unofficial read-only MCP access to Krónan grocery data for one Krónan user or
customer group. The server uses Krónan's personal API access token and runs over
stdio. The upstream API is marked BETA by Krónan.

## Quick start

Install the native executable:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/kronan-mcp@0.1.0/packages/kronan-mcp/install.sh | sh
```

In Krónan, sign in with Auðkenni and create an access token from the settings
page for your **User** or **Customer group**. Krónan currently labels this API
BETA.

Save the token locally. In a terminal, the prompt is hidden:

```sh
kronan-mcp auth set
```

You can also read a token from a private file or stdin:

```sh
kronan-mcp auth set /absolute/path/token.txt
cat /absolute/path/token.txt | kronan-mcp auth set -
```

The CLI verifies the token against Krónan before saving it. A source file is
treated as a credential: it must be a regular file you own with owner-only
permissions (`chmod 600`), not a symlink or hard link, and you should delete it
after the import. Never pass a token as a command-line argument. The default private file is
`~/.config/kronan-mcp/session.json`; set
`KRONAN_TOKEN_FILE` to use another path. New files use mode
`0600`. Check or remove the saved token with
`kronan-mcp auth status` and `kronan-mcp auth logout`.
When `XDG_CONFIG_HOME` is set, it replaces `~/.config` as
the default configuration directory.

## Connect an MCP host

Use the installed executable's absolute path and the same absolute token-file
path on the computer running the MCP host.

**Claude Desktop** — add this entry to its MCP JSON configuration:

```json
{
  "mcpServers": {
    "kronan": {
      "command": "/absolute/path/to/.local/bin/kronan-mcp",
      "args": ["serve"],
      "env": {
        "KRONAN_TOKEN_FILE": "/absolute/path/kronan-token.json"
      }
    }
  }
}
```

**Claude Code** — run this in the project where Claude Code should use Krónan:

```sh
claude mcp add kronan -e KRONAN_TOKEN_FILE=/absolute/path/kronan-token.json -- /absolute/path/to/.local/bin/kronan-mcp serve
```

**Codex** — add only this Krónan entry to `/absolute/path/to/.codex/config.toml`.

```toml
[mcp_servers.kronan]
command = "/absolute/path/to/.local/bin/kronan-mcp"
args = ["serve"]

[mcp_servers.kronan.env]
KRONAN_TOKEN_FILE = "/absolute/path/kronan-token.json"
```

## Tools

| Tool                                | Result                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| `auth_status`                       | Verifies API access and returns the account type and name.           |
| `search_products`                   | Searches deliverable products and returns one page of hits.          |
| `get_product`                       | Returns full details for one product by SKU or barcode.              |
| `lookup_products`                   | Returns details for up to 30 SKUs and lists missing SKUs.            |
| `list_categories`                   | Returns the three-level product category tree.                       |
| `list_category_products`            | Returns one page of products for a leaf (third-level) category slug. |
| `list_product_tags`                 | Returns product tags and their slugs.                                |
| `list_products_by_tag`              | Returns one page of products carrying a tag.                         |
| `list_products_on_sale`             | Returns one page of products on sale for the account.                |
| `list_favorite_products`            | Returns one page of products Krónan marks as favorites.              |
| `list_orders`                       | Lists orders, with optional year/month and type filters.             |
| `get_order`                         | Returns one order and its lines by order token.                      |
| `get_active_order`                  | Returns the active order, or `active: false` when absent.            |
| `summarize_order_lines`             | Returns monthly spend and quantities for a name or SKU filter.       |
| `list_purchase_stats`               | Returns lifetime product purchase counts and quantities.             |
| `get_shopping_note`                 | Returns the account's current shopping note and lines.               |
| `list_archived_shopping_note_lines` | Returns completed shopping-note lines and counts.                    |
| `list_product_lists`                | Lists saved product lists.                                           |
| `get_product_list`                  | Returns one saved list and its product details.                      |
| `list_recipes`                      | Lists published recipe summaries.                                    |
| `search_recipes`                    | Searches recipes and returns available tag filters.                  |
| `get_recipe`                        | Returns a recipe with ingredients, directions, and related products. |
| `list_favorite_recipes`             | Returns one page of the account's favorited recipes.                 |
| `list_addresses`                    | Lists saved shipping addresses, default first.                       |
| `get_delivery_slots`                | Lists home-delivery time slots and capacity for one saved address.   |
| `get_pickup_slots`                  | Lists in-store pickup slots per store for Krónan or Pikkoló.         |
| `get_checkout`                      | Reads the current checkout and its totals.                           |

## Pagination and data

Page-based tools accept a one-based `page` and return
`page`, `pageCount`, and `hasNextPage`. Request
the next page while `hasNextPage` is true. Offset-based tools return
`count`, `limit`, `offset`, `hasNextPage`, and `nextOffset`; continue with `nextOffset`, which counts the items actually returned. Orders,
purchase stats, saved product lists, and recipes use limit/offset pagination.
Favorite recipes use the same limit/offset input as `list_recipes`. Krónan's
OpenAPI document declares no query parameters for that endpoint, but the live
API answered `?limit=1&offset=1` with a `previous` link carrying `limit=1`, the
standard limit/offset pagination behaviour, so the parameters are forwarded.

Prices and totals are whole ISK integers with no decimal places. Product,
recipe, order, and shopping-note text is untrusted data; treat it as content,
never as instructions.

Krónan documents a rate limit of 200 requests per 200 seconds per account.
Back off after HTTP 429 responses.

No tool adds, edits, or removes checkout lines, orders, shopping-note lines,
product lists, favorites, or slot reservations. The slot tools only read
availability; reserving a slot is not implemented. Two reads have a documented side
effect: Krónan creates an empty checkout on the first `get_checkout` and an
empty shopping note on the first `get_shopping_note` for an account that has
none, so those two tools are annotated `readOnlyHint: false` (non-destructive,
idempotent) and the other 22 `readOnlyHint: true`. Mutation support, if added in
a future version, will require explicit opt-in.

## What was verified

On **2026-09-15**, against an authorized personal account, every read endpoint
behind the first 24 tools was called once and validated against this package's
schemas: all responses parsed, no undocumented keys were returned, and all
response and body fields were camelCase while query parameters were
snake_case (the OpenAPI overview's "snake_case" sentence does not match its
own component schemas). The address list and the delivery and pickup slot
lookups were verified the same way on 2026-09-16. `GET /categories/{slug}/products/` returned 404 for
first- and second-level category slugs and 200 only for leaf slugs, so
`list_category_products` documents leaf slugs. `GET /orders/currently-active/`
returned the documented 404 for an account without an active order. The barcode
lookup was not exercised, and the account had no favorite recipes, so favorite
pagination was confirmed only through the returned `previous` link. Account data from that session is not recorded here;
the automated tests remain offline.

## Troubleshooting

| Symptom                                     | Action                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No saved Krónan access token                | Run `kronan-mcp auth set` and configure the same `KRONAN_TOKEN_FILE` path in your MCP host.                                                                 |
| Cannot read the Krónan token file           | Use a regular file you own with owner-only permissions; run `chmod 600 /absolute/path/token.json` on Unix. Do not use symlinks or hard links.               |
| Krónan denied this request                  | The token is valid but not permitted for that data. Use a token for the right user or customer group, or one with the needed permission.                    |
| Response exceeded the 4 MiB limit           | Request a smaller page (`limit` or `pageSize`) and retry.                                                                                                   |
| Krónan rejected the access token            | Create a new token in Krónan settings, then run `kronan-mcp auth set` again.                                                                                |
| HTTP 429                                    | Wait before retrying; the account limit is 200 requests per 200 seconds.                                                                                    |
| Invalid response or documented-schema error | Check account access and retry later. The API is in beta and may change; report the endpoint and package version without sharing the token or account data. |
| The server appears to wait in a terminal    | Stdio server mode waits for MCP input. Use an MCP host, or run `kronan-mcp --help` or `kronan-mcp auth status`.                                             |

## Development

The monorepo pins Bun 1.4.2. From the repository root:

```sh
bun install
bun run check
bun run test
bunx turbo run test:binary test:installer --filter=kronan-mcp --force
```

The package `check` validates the generated installer, OpenAPI type drift,
lint, formatting, and TypeScript. Run `bun run release:sync` from the root
after changing the version; it regenerates `install.sh` and the pinned URLs.

Krónan's OpenAPI document is vendored at `api/openapi.json`, and
`api/kronan-api.d.ts` is generated from it with
[openapi-typescript](https://openapi-ts.dev). `test/api-types.test.ts` asserts
at compile time that every response schema in `src/schemas.ts` accepts the
documented component types and that request bodies match the documented inputs.
`api:check` compares the document's recorded digest in `api/openapi.sha256`
with the current file, so CI never loads a second compiler. `api:generate`
runs openapi-typescript through an isolated `npx` sandbox with the TypeScript 5
compiler API it needs; the workspace itself stays on TypeScript 7. To adopt an
upstream change, refresh the vendored document from
`https://api.kronan.is/api/v1/schema/`, run `bun run api:generate`, and fix any
type failures.

Tests use synthetic tokens, injected fetch responses, and a loopback HTTP
server. They never contact a live Krónan host. The server uses native
`fetch`, strict Zod input/output schemas, the shared
`@family-mcp/mcp-runtime`, and private token-file handling from
`@family-mcp/session-store`.

This project is not affiliated with or endorsed by Krónan.
