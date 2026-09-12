# Terra phase 5 report

## Delivered

- Added `^typecheck` dependencies to cached `test`, `typecheck`, and `lint`
  tasks, so server task hashes include shared workspace package typechecks.
- Added a release-tooling regression test that copies the checkout to a
  temporary directory, records `turbo run test typecheck lint --dry=json`, then
  edits each shared entrypoint independently. It asserts that all six consumer
  hashes (`abler-mcp` and `infomentor-mcp` × `test`, `typecheck`, `lint`) change
  for both `packages/mcp-runtime/src/index.ts` and
  `packages/session-store/src/index.ts`, without `--force`.
- Extended version synchronization and its test to update the selected package's
  root README installer URL while leaving the other package's pin unchanged.
- Rewrote the root README around installation, host setup, login, returned data,
  security, development, and releases. Package READMEs now link to that shared
  host setup, use the supported checks, and no longer present InfoMentor as an
  importable library.
- Updated the maintainer guidance for the privacy boundary and cache-key
  regression.

## Cache-invalidation proof

The regression test passed under the pinned Bun runtime. Its post-change
dry-run graph lists both `@family-mcp/mcp-runtime#typecheck` and
`@family-mcp/session-store#typecheck` as dependencies of every server
`test`, `typecheck`, and `lint` task. The scratch-copy edits then changed every
one of those six consumer hashes for each shared entrypoint.

## Validation

All checks stayed offline; no live Abler or InfoMentor service was contacted.

| Check | Result |
| --- | --- |
| `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run typecheck lint format:check test release:check --force` | Passed: 22 tasks, 0 cached, Bun 1.4.2 |
| `actionlint .github/workflows/*.yml` | Passed |
| `node --test tooling/release/release.test.mjs` | Passed: release pin and cache-key regressions |
| `PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH bunx turbo run test:binary test:installer --dry=json` | Resolved the documented native tasks under Bun 1.4.2 |
| `git diff --check` | Passed |

No version was bumped, and no tag, push, merge, or release was created.
