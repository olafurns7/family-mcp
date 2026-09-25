# Changelog

## 0.2.0

- Adds shopping-note writes: `add_shopping_note_lines`,
  `change_shopping_note_line`, `toggle_shopping_note_line_complete`,
  `delete_shopping_note_line`, and `clear_shopping_note` (requires
  `confirm: true`).
- Adds basket tools: `preview_checkout_lines` (read-only validation) and
  `set_checkout_lines`, which requires an explicit `replace`.
- Adds order tools that can authorize a charge on the saved card:
  `reserve_delivery_slot`, `reserve_pickup_slot`, `complete_checkout`, and
  `add_checkout_to_order`. Each requires `confirm: true`, `expectedTotal`, and
  `expectedCheckoutToken`, re-reads the checkout, and refuses without calling
  Krónan when the checkout is empty or changed. `add_checkout_to_order` also
  requires `expectedOrderToken` and checks the active order.
- Order requests are sent once and never retried. Once sent, any failure,
  4xx and 429 included, returns `outcome: "unknown"`, not a failure; the result
  tells the agent to check `get_active_order` and `list_orders`, ask the user,
  and not retry.
- Allows one attempt per approval. Order calls are recorded in a private
  `<token file>.order-attempts.json` under a cross-process lock, as
  `submitting` before the request and `accepted` or `unknown` after it. An
  unresolved attempt blocks all four order tools for that checkout; an accepted
  one blocks repeating it for the same lines and total, while an accepted
  reserve still allows `complete_checkout`. Only the new
  `kronan-mcp orders clear-attempts` CLI command clears the record, after a y/N
  confirmation.
- `expectedTotal` is documented as a checkout consistency check, not a cap:
  fees and the selected slot can make `authorizedAmount` higher, so agents must
  show the checkout fee fields and get approval of that uncertainty.
- Adds placed-order changes: `delete_order_lines` and
  `lower_order_line_quantities` (both require `confirm: true`) and
  `toggle_order_line_substitution`. Any failure after sending one of them
  means the change may have been applied; read `get_order` first.
- Exposes 41 tools. Annotations mark every removal, checkout replacement, and
  order call as destructive and not idempotent.
- Extends the OpenAPI drift check to every new request body and response.
- The write endpoints are not yet verified against a live Krónan account; the
  order in which reserve and complete combine is unverified.

## 0.1.0

- First release of the unofficial Krónan MCP server.
- Adds product search, lookup, category, tag, sale, and favorite-product tools.
- Adds order, purchase-history, shopping-note, product-list, recipe, address,
  delivery and pickup slot availability, and checkout read tools.
- Exposes 27 read tools; no checkout, order, note, list, favorite, or slot
  mutations are available. `get_checkout` and `get_shopping_note` are annotated
  as not read-only because Krónan creates an empty resource on first read.
- Adds private personal-token authentication through `KRONAN_TOKEN_FILE`
  and `kronan-mcp auth set`; imported token source files must be private.
- Vendors Krónan's OpenAPI document and checks the Zod schemas against
  openapi-typescript output at typecheck time.
- Every read endpoint except the barcode lookup was verified once against a
  live account on 2026-09-15; responses matched the vendored schema.
