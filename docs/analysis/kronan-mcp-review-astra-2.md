# Krónan MCP working-tree re-review

## Findings

### [P2] Set the unsafe fixture's permissions independently of umask — packages/kronan-mcp/test/integration.test.ts:1128

`writeFile(sharedSource, ..., { mode: 0o644 })` applies the process umask. Under `umask 077`, the new fixture is therefore mode 0600, so `readTokenSource` correctly accepts it and the test fails at line 1147 with `Expected: 1, Received: 0`. This makes the package test gate fail on a normally configured private-file environment even though the production fix works. Reproduced from `packages/kronan-mcp` with `(umask 077; bun test test/integration.test.ts --test-name-pattern 'CLI token setup' --timeout 30000)`. Explicitly `chmod(sharedSource, 0o644)` after creation, as the earlier saved-token permissions test already does for its loose fixture.

## Original findings

All four original findings are resolved in the production code:

| Original issue | Verification |
| --- | --- |
| Unsafe token-source reads | `src/cli.ts:75` calls `readTokenSource`, which uses bounded `readPrivateFile` at `src/auth.ts:45` and maps failures to fixed messages before authentication or saving. The CLI tests reject loose, symlinked, and missing sources without sending a request or saving a token. Additional offline probes rejected hard-linked and oversized sources. The new loose-file fixture has the test defect above. |
| Nested nutrition disclosure | `src/schemas.ts:216` accepts only flat string, number, or null values. Nested objects and arrays fail validation for individual and batch products. An additional MCP probe verified `isError: true`, no structured output, and no synthetic secret marker in the returned error. Number/null tolerance is an explicit extension of the vendored string-map contract; documented string values remain accepted. |
| Incorrect read-only annotations | `READ_OR_CREATE_EMPTY` at `src/server.ts:53` sets `readOnlyHint: false` for exactly `get_shopping_note` and `get_checkout`, retaining non-destructive and idempotent hints. Instructions, both descriptions, the package README, and changelog disclose auto-creation. The expanded MCP test verifies the exact 22/2 annotation split and successfully calls all 24 tools. |
| Rejected leading-punctuation slugs | The shared input at `src/schemas.ts:24` accepts leading hyphens and underscores. Tests verify `_dairy`, `-recipe`, and UTF-8 percent encoding for `mjólk`, while rejecting slash-containing inputs. Category, tag, and recipe callers continue to encode the path segment. |

The `String.fromCharCode(3)` and `String.fromCharCode(127)` substitutions preserve the previous Ctrl-C and Delete values and behavior. No additional actionable production or release-plumbing regression was found.

## Validation and scope

Reviewed `git status --short` and the complete `git diff HEAD`, including intent-to-add files, against HEAD `2685b18b76a86ecfc80b2172dc30c8f8d8a64ac6`. SHA-256 of the plain diff: `3764e9749fe90675ee04814731056b6d047ad5add378b25f17873998d52c97dc`.

- Package `bun run test`: **10 passed**, 0 failed, 440 assertions with the normal environment.
- Package `bun run check`: passed shell syntax, OpenAPI declaration drift, lint, formatting, and TypeScript checks.
- Package `bun run release:check`: passed.
- `node --test tooling/release/release.test.mjs`: **3 passed**.
- Restricted-umask CLI test: **failed**, reproducing the finding above.
- Additional offline MCP disclosure and private-source probes: passed.
- `git diff --check HEAD`: passed.

Overall: one new P2 test defect remains; no remaining findings from the first review and no P0/P1/P3 findings. No live Krónan calls, native binary/installer tests, hosted CI, or interactive terminal tests were performed in this re-review. Source files were not edited.
