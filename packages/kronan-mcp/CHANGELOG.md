# Changelog

## 0.1.0

- First release of the unofficial Krónan MCP server.
- Adds product search, lookup, category, tag, sale, and favorite-product tools.
- Adds order, purchase-history, shopping-note, product-list, recipe, and
  checkout read tools.
- Exposes 24 read tools; no checkout, order, note, list, favorite, or slot
  mutations are available. `get_checkout` and `get_shopping_note` are annotated
  as not read-only because Krónan creates an empty resource on first read.
- Adds private personal-token authentication through `KRONAN_TOKEN_FILE`
  and `kronan-mcp auth set`; imported token source files must be private.
- Vendors Krónan's OpenAPI document and checks the Zod schemas against
  openapi-typescript output at typecheck time.
- Every read endpoint except the barcode lookup was verified once against a
  live account on 2026-09-15; responses matched the vendored schema.
