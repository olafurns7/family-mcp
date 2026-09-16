# Krónan MCP working-tree review

## Findings

### [P2] Enforce private-file checks on token imports — packages/kronan-mcp/src/cli.ts:68

`auth set FILE` reads its credential source with unrestricted `readFile`, bypassing the ownership, permissions, regular-file, link, and size checks used by `loadToken`. With an offline fetch stub, importing both a mode-0644 token file and a symlink returned exit code 0 and saved the token. A private destination does not protect the original credential, which remains readable by other users; a writable source can also supply a different account's token. Use the existing bounded `readPrivateFile` helper for the source and reject unsafe files before sending their contents upstream. The CLI tests only import a regular mode-0600 file; the unsafe-file tests exercise saved-token loading instead of this import path.

### [P2] Restrict nutrition values to the documented string map — packages/kronan-mcp/src/schemas.ts:214

`PublicProductDetail.nutrition` is a nullable map of strings in `api/openapi.json:4444`, but `z.record(z.string(), z.json())` accepts arbitrary nested objects and arrays and returns them unchanged. An offline `get_product` MCP call with an otherwise valid product and a nested nutrition diagnostic containing a synthetic authorization token returned that diagnostic in both text and structured output. This bypasses the filtering applied to other upstream objects and allows undocumented upstream data to reach the host. Validate the documented string values and add a rejection test for nested values. The current fixture uses the undocumented numeric value `nutrition: { energy: 1 }`, and the one-way TypeScript compatibility assertion cannot detect this overly permissive schema.

### [P2] Account for resource creation in the read-only annotations — packages/kronan-mcp/src/server.ts:310

`get_checkout` advertises `READ_ONLY`, but its unconditional `GET /checkout/` calls an endpoint explicitly documented to create a checkout when none exists (`api/openapi.json:117`). `get_shopping_note` has the same issue at `src/server.ts:226`, with auto-creation documented at `api/openapi.json:1965`. For an account without those resources, an MCP host can therefore permit a persistent upstream write under a read-only policy, while the server instructions promise that nothing modifies checkout or notes. Either exclude/gate these auto-creating operations to preserve the read-only contract, or accurately annotate and disclose their side effects. Checking the HTTP method and asserting that every tool has `readOnlyHint: true` does not verify this behavior.

### [P3] Accept documented slugs that begin with a hyphen or underscore — packages/kronan-mcp/src/schemas.ts:23

The shared slug input requires an initial letter or number, whereas the category and recipe component schemas permit `^[-a-zA-Z0-9_]+$` (`api/openapi.json:3246` and `:5041`). Consequently a valid listed category such as `_dairy`, or recipe such as `-recipe`, cannot be supplied to its follow-up tool. An offline probe confirmed that `categories()` accepts `_dairy` and `categoryProducts()` rejects that same returned slug before making a request. Align the input with the documented slug characters; path segments are already encoded with `encodeURIComponent`. Add a list-to-detail test using a leading hyphen or underscore, which the existing alphanumeric fixtures and type-only assertions do not cover.

## Overall assessment

Four actionable findings: three P2 and one P3; no P0 or P1 findings. The request methods, paths, query names, and JSON body field names match the vendored endpoint contracts. No missing release registration was found: the package participates in tag selection, version synchronization, asset selection, smoke checks, and the existing generic CI jobs. Error-body disposal and redirect rejection passed the offline tests. The findings above concern gaps that the passing checks do not establish as safe or compatible.

Reviewed `git status --short` and the complete `git diff HEAD`, including the intent-to-add package, against HEAD `2685b18b76a86ecfc80b2172dc30c8f8d8a64ac6`. SHA-256 of the plain diff: `344bd31173cd0838b9e545b9a3c40d735c9b09d662fe414ed0432fe952fcc940`. Generated declarations matched the vendored spec. Source files were not edited.

Validation performed with Bun 1.4.2:

- Package `bun run test`: 9 passed, 0 failed, 302 assertions.
- Package `typecheck`, `api:check`, `lint`, `format:check`, and `release:check`: passed.
- `node --test tooling/release/release.test.mjs`: 3 passed, including package-specific assets and shared-source cache invalidation.
- Additional offline MCP round trips: all 24 tools succeeded with the existing fixtures; adversarial nutrition, unsafe-import, and slug probes reproduced the findings above.
- `git diff --check HEAD`: passed.

No live Krónan calls were made. Native binaries/installers and hosted CI were not run in this review. Auto-creation is established by the vendored contract, not by a live account mutation. The package's named “all 24 MCP tools” test currently invokes only `search_products`; broader round trips and the adverse cases above should be retained as regression coverage.
