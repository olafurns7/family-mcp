# Phase 1 tooling report

Completed on 2026-09-11 in `/Users/olafurns/Verkefni/family-mcp`, on `main`.

The requested root acceptance command passes for both MCP servers. All 23 existing application tests pass: 8 Abler tests and 15 InfoMentor tests, including nested subtests. Both packages build and typecheck under the stricter shared TypeScript settings; lint and formatting report no warnings or errors with the documented scoped lint exceptions. Package installation and native executable checks also pass locally.

## Changes

- Added the private `family-mcp` root manifest with `packages/*` and `tooling/*` workspaces, `packageManager: bun@1.4.2`, and all eight requested root scripts routed through Turbo.
- Added a single root `bun.lock`, generated with the existing Bun 1.2.19, and pinned root development tools: Turbo 2.10.12, TypeScript 7.0.2, Oxlint 1.82.0, oxlint-tsgolint 7.0.2001, and Oxfmt 0.67.0. Application dependency ranges, SDK generations, and published package versions are unchanged: Abler 0.3.1 and InfoMentor 0.5.0.
- Added private `@family-mcp/tsconfig` and `@family-mcp/oxlint-anti-slop` tooling workspaces. The new private packages have version 0.0.0 so Bun can resolve workspace references when packing an application; no existing version was bumped.
- Moved all 64 vendored anti-slop files, including licenses, provenance, and upstream tests, from InfoMentor to `tooling/oxlint-anti-slop`. Verified every relocated file is byte-identical. `@oxlint/plugins` remains pinned to the same 1.82.0 version as Oxlint. The vendored implementation stays excluded from application lint, formatting, and typechecking; its new package manifest is formatted.
- Replaced all four per-package Oxc configurations with root `.oxlintrc.json` and `.oxfmtrc.json`. Package scripts explicitly reference those root configurations. Added InfoMentor's missing `typecheck` and `lint:fix` aliases.
- Fixed two tooling paths in InfoMentor for workspace installations: the package smoke check resolves TypeScript's exported package manifest before locating its CLI, and the binary builder finds dependency license directories from the actual bundled input paths. This supports root-hoisted dependencies and nested `node_modules` paths without changing application behavior.
- Replaced the two nested CI workflows with `.github/workflows/ci.yml`. Kept the existing Node 22/24 checks, dependency audit, package installation/MCP checks, and Linux/macOS x64/arm64 standalone matrices and artifacts. Root CI runs `bun install --frozen-lockfile` followed by `bunx turbo run build check test`.
- Kept the root `.gitignore` unchanged: it already covers dependencies, build/test/Turbo caches, release archives, and the existing secret/session patterns.

No application refactoring, shared runtime extraction, SDK migration, live login, publishing, repository creation, or push was performed. InfoMentor's application source is unchanged. Abler's seven source/test files changed only through the requested formatting pass; Bun transpilation produced identical JavaScript before and after for all seven files. Existing package check/test/prepack entry points remain available, including InfoMentor's direct test command rebuilding its own output.

## TypeScript reconciliation

Both package tsconfigs extend `@family-mcp/tsconfig/base.json`. The base preserves ES2023 output, ES2024/DOM libraries, NodeNext modules/resolution, strict checking, unchecked-index checking, JSON resolution, skipLibCheck, and noEmit. It also adopts all of InfoMentor's additional flags:

- `exactOptionalPropertyTypes`
- `noUnusedLocals`
- `noUnusedParameters`
- `noImplicitReturns`
- `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax`
- `forceConsistentCasingInFileNames`

**Failing stricter flags: none.** Both full package typechecks and production builds pass. Package-local `types` arrays remain appropriate to their runtimes: Abler's checks include Bun and Node, while InfoMentor uses Node. Existing build tsconfigs still control emit, output directories, and declaration/source-map differences.

## Lint and formatting reconciliation

The root linter combines Abler's plugins, correctness/suspicious/performance categories, type-aware rules, explicit restrictions, and existing CLI/test/auth exceptions with all 18 generic anti-slop rules from InfoMentor. Both package lint scripts reject warnings and unused disable directives. InfoMentor retains its browser globals within its own override.

The new rules were first run without migration exceptions. Abler had 214 anti-slop findings. InfoMentor had 381 findings from newly enabled Abler/type-aware/performance rules; the two required packaging-path changes brought that final unexcepted count to 384. No InfoMentor anti-slop rules needed an exception. These are lint migration findings, not failures of TypeScript's strictness flags.

The tables below were measured again on the final code by temporarily omitting only the migration override blocks. The temporary probe configuration was removed. No anti-slop rule was disabled globally.

### Abler exceptions

All seven rules remain errors globally and are overridden only for `packages/abler-mcp/**`, as requested. Existing Abler lint rules are preserved.

| Rule | Findings |
| --- | ---: |
| `anti-slop/no-conditional-empty-object-spread` | 7 |
| `anti-slop/no-known-value-widening` | 3 |
| `anti-slop/no-runtime-typeof` | 4 |
| `anti-slop/no-unknown-parameters` | 4 |
| `anti-slop/no-unknown-returns` | 1 |
| `anti-slop/no-unsafe-dictionary-type` | 1 |
| `anti-slop/require-readable-spacing` | 194 |
| **Total** | **214** |

### InfoMentor exceptions

Only the listed newly enabled rules are overridden, separately for `src/**`, `test/**`, and `scripts/**`. No existing InfoMentor lint restriction was removed. Most new type-safety findings occur in `.mjs` tooling scripts outside the application's TypeScript project.

| Rule | src | test | scripts | Total |
| --- | ---: | ---: | ---: | ---: |
| `eslint/max-depth` | 5 | 0 | 0 | 5 |
| `eslint/no-console` | 7 | 0 | 3 | 10 |
| `eslint/no-duplicate-imports` | 6 | 3 | 0 | 9 |
| `oxc/no-map-spread` | 0 | 1 | 0 | 1 |
| `promise/always-return` | 2 | 0 | 0 | 2 |
| `typescript/no-base-to-string` | 0 | 4 | 0 | 4 |
| `typescript/no-floating-promises` | 0 | 8 | 0 | 8 |
| `typescript/no-non-null-assertion` | 0 | 1 | 0 | 1 |
| `typescript/no-unnecessary-condition` | 1 | 6 | 0 | 7 |
| `typescript/no-unsafe-argument` | 1 | 1 | 12 | 14 |
| `typescript/no-unsafe-assignment` | 0 | 0 | 54 | 54 |
| `typescript/no-unsafe-call` | 0 | 0 | 189 | 189 |
| `typescript/no-unsafe-member-access` | 0 | 0 | 77 | 77 |
| `typescript/no-unsafe-return` | 0 | 0 | 2 | 2 |
| `typescript/require-array-sort-compare` | 0 | 0 | 1 | 1 |
| **Total** | **22** | **24** | **338** | **384** |

These overrides preserve the tooling-only boundary of Phase 1. They also permit future occurrences of the listed rules within those scopes until the later remediation phase removes each exception.

Formatting uses `singleQuote: true` and `printWidth: 100`. Abler retains its pre-existing import sorting through a root override; InfoMentor retains its existing import order. Root formatting tasks also cover the workflow and tooling manifests/configuration. Generated output and vendored source are excluded. `docs/analysis/**` is excluded so routine formatting does not modify the other agent's analysis; this report is the only file created there by this task.

The installed Turbo schema and `bunx turbo --help` were used to verify task configuration. Oxc configuration resolution and overrides were checked against the official [Oxlint configuration documentation](https://oxc.rs/docs/guide/usage/linter/config.html) and [Oxfmt configuration documentation](https://oxc.rs/docs/guide/usage/formatter/config.html).

## Task graph and cache verification

- `build` depends on `^build` and caches `dist/**`.
- InfoMentor's `test` depends on its `build` and caches `.test-build/**`; Abler's Bun test suite needs no prior build and declares no file outputs.
- `lint`, `typecheck`, `format:check`, and `check` explicitly declare empty file outputs. `check` depends on lint, typecheck, and formatting and also preserves each package's original check command.
- `format` and `lint:fix` disable caching because they modify files. Root formatting is a separate root task, included automatically in both package formatting runs.
- Root Oxc configurations and both tooling directories are global cache inputs. Root formatting explicitly hashes root configuration, tooling, and workflow files.
- Remote caching is disabled in this repository. The first probe encountered pre-existing machine-level Turbo authentication and a sandbox write warning; subsequent runs use only the local cache and require no login.

After a forced successful run with Bun 1.2.19, both `dist` directories and InfoMentor's `.test-build` directory were moved aside. The exact requested acceptance command hit all 11 cached tasks and restored all **47 generated files**, each verified against its previous SHA-256 hash. The temporary backup copies were then removed.

## Bun compatibility and environment friction

The global Bun executable was left at **1.2.19** throughout. Root install, frozen install, all required checks, and both package archives work with that installed version. The root and original package `packageManager` fields remain **bun@1.4.2**.

Bun 1.2.19 did not update existing lockfile workspace-version metadata when 0.0.0 was added to the new tooling packages, including on `bun install --force`. Consequently `bun pm pack` initially reported `Failed to resolve workspace version`. Regenerating the root lockfile after the tooling manifests were finalized resolved this; both ordinary and frozen installation now succeed.

InfoMentor's existing native builder deliberately requires Bun 1.4.2. A private temporary installation at `/private/tmp/family-mcp-phase1-runtime/node_modules/.bin/bun` supplied that version for native checks and a separate forced CI-equivalent run. Its frozen install accepted the Bun 1.2.19-generated lockfile without modification. No release version guard was weakened.

The default npm cache was not writable in the sandbox, so package checks used `/private/tmp/family-mcp-phase1-npm-cache`. No ownership repair or global package-manager installation was performed. Temporary runtime/cache data and ignored package/native artifacts remain local.

## Additional verification and remaining limits

| Check | Result |
| --- | --- |
| Local platform | macOS arm64, Node v24.12.0 |
| Bun 1.2.19 root acceptance, forced execution | 11/11 tasks successful; 0 cached |
| Exact requested root command, cache restoration | 11/11 tasks successful; 11 cached; 47 output hashes match |
| Bun 1.4.2 frozen install and forced `turbo run build check test` | 13/13 tasks successful; 0 cached |
| Root `bun run check` | 9/9 tasks successful |
| `bun audit` | No vulnerabilities found |
| Abler `npm pack`, install without lifecycle scripts, `test/pack-smoke.ts` | Passed Node CLI version, MCP handshake, six tools, missing-auth behavior, strict child filters |
| InfoMentor `bun pm pack` and `bun run test:package` | Passed archive contents, installation without build scripts, CLI, MCP handshake, strict consumer types, and npm publication **dry-run** |
| Abler native build and standalone MCP smoke, Bun 1.4.2 | Passed on darwin-arm64 |
| InfoMentor native build and installer, Bun 1.4.2 | Passed on darwin-arm64, including spaced paths, reinstall, checksum rejection, preserving the prior executable, and MCP handshake |
| `actionlint .github/workflows/ci.yml` | Passed with no diagnostics |
| `git diff --check` | Passed |
| Relocated plugin and unchanged InfoMentor release workflow | Byte-identical to imported originals |

**No required local acceptance check remains failing.** Hosted GitHub Actions, Node 22 runtime execution, Linux standalone builds, macOS x64 builds, and real account connectivity were not run locally. Their configured CI coverage is retained, but hosted success is unverified because this task did not create a remote or push. The vendored plugin's upstream development test suite was preserved rather than added as a new monorepo test obligation; both application lint runs exercised the relocated plugin.

`packages/infomentor-mcp/.github/workflows/release.yml` remains byte-identical and in its existing nested location. GitHub will not discover it as a root workflow there. Its single-package paths, `v${version}` tag assumptions, installer URL scheme, and release artifact wiring require a separate per-package release/tag decision before activation, for example `abler-mcp@0.3.1` and `infomentor-mcp@0.5.0`. Both installers still refer to the original repositories and version tags. No release redesign was attempted.

## Commits

The implementation was committed on `main` in the requested logical groups:

```text
60e687b Set up Bun workspaces and Turborepo with shared strict TypeScript config
7e10cf3 Centralize Oxc configuration and preserve scoped lint baselines
732a8a8 Format Abler with the shared single-quote convention
7b6c315 Consolidate package and standalone CI at the monorepo root
```

This report is recorded in a subsequent documentation commit. Every commit ends with:

```text
Claude-Session: https://claude.ai/code/session_01L7a5Fz4dusPukqVAxrAqMC
```

## Exact final command output

Only trailing terminal whitespace is omitted.

From the repository root, using the unchanged global Bun 1.2.19:

```sh
bun install
```

```text
bun install v1.2.19 (aad3abea)

Checked 132 installs across 196 packages (no changes) [8.00ms]
```

```sh
bun install --frozen-lockfile
```

```text
bun install v1.2.19 (aad3abea)

Checked 132 installs across 196 packages (no changes) [4.00ms]
```

First, force all tasks to execute, so the evidence does not depend on earlier cached results:

```sh
bunx turbo run build typecheck lint format:check test --force
```

```text
• turbo 2.10.12

   • Packages in scope: @family-mcp/oxlint-anti-slop, @family-mcp/tsconfig, abler-mcp, infomentor-mcp
   • Running build, typecheck, lint, format:check, test in 4 packages
   • Remote caching disabled (in configuration)

infomentor-mcp:typecheck: cache bypass, force executing 01b3a719cb3b89b8
infomentor-mcp:lint: cache bypass, force executing e4909f980484173b
abler-mcp:typecheck: cache bypass, force executing 1ed2965a6acb6812
//:format:root:check: cache bypass, force executing 273b82b8c6160544
abler-mcp:test: cache bypass, force executing 3a10bf67b5700285
abler-mcp:lint: cache bypass, force executing b73bca0f7a4c0f91
abler-mcp:build: cache bypass, force executing b3b98ec5991eb806
infomentor-mcp:build: cache bypass, force executing ce91d642bdb9a7cc
abler-mcp:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity error .
abler-mcp:typecheck: $ tsc --noEmit
abler-mcp:test: $ bun test
infomentor-mcp:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity error src test scripts
infomentor-mcp:build: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
//:format:root:check: $ oxfmt --check package.json turbo.json .oxlintrc.json .oxfmtrc.json .github tooling
infomentor-mcp:typecheck: $ tsc --noEmit
abler-mcp:build: $ rm -rf dist && tsc -p tsconfig.build.json
abler-mcp:test: bun test v1.2.19 (aad3abea)
abler-mcp:test:
abler-mcp:test: test/install.test.ts:
//:format:root:check: Checking formatting...
//:format:root:check:
//:format:root:check: All matched files use the correct format.
//:format:root:check: Finished in 10ms on 8 files using 14 threads.
abler-mcp:format:check: cache bypass, force executing 3a15c3814edda80e
infomentor-mcp:format:check: cache bypass, force executing 0d00729c1870e65b
abler-mcp:format:check: $ oxfmt -c ../../.oxfmtrc.json --check .
infomentor-mcp:format:check: $ oxfmt -c ../../.oxfmtrc.json --check .
abler-mcp:format:check: Checking formatting...
abler-mcp:format:check:
infomentor-mcp:format:check: Checking formatting...
infomentor-mcp:format:check:
infomentor-mcp:test: cache bypass, force executing facaed40e9047ffe
infomentor-mcp:test: $ bun run build && bun build ./test/*.test.ts --target=node --packages=external --outdir=.test-build && node --test .test-build/*.test.js
infomentor-mcp:test: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
abler-mcp:format:check: All matched files use the correct format.
abler-mcp:format:check: Finished in 213ms on 14 files using 14 threads.
abler-mcp:lint: Found 0 warnings and 0 errors.
abler-mcp:lint: Finished in 438ms on 7 files with 218 rules using 14 threads.
infomentor-mcp:format:check: All matched files use the correct format.
infomentor-mcp:format:check: Finished in 275ms on 25 files using 14 threads.
infomentor-mcp:test: Bundled 12 modules in 3ms
infomentor-mcp:test:
infomentor-mcp:test:   collection.test.js   32.22 KB   (entry point)
infomentor-mcp:test:   integration.test.js  105.95 KB  (entry point)
infomentor-mcp:test:   lock.test.js         15.0 KB    (entry point)
infomentor-mcp:test:
infomentor-mcp:lint: Found 0 warnings and 0 errors.
infomentor-mcp:lint: Finished in 615ms on 16 files with 218 rules using 14 threads.
infomentor-mcp:test: ▶ collection snapshots replay deltas, preserve context, and fail without advancing
infomentor-mcp:test:   ✔ baseline, identical grouping, full body edits, replay, and missing references (23.768875ms)
infomentor-mcp:test:   ✔ pagination limit restores selection and writes no snapshot (0.782625ms)
infomentor-mcp:test:   ✔ selection interference and cancellation restore with a fresh signal (0.581875ms)
infomentor-mcp:test:   ✔ restoration failure prevents a cursor and preserves authentication errors (0.483667ms)
infomentor-mcp:test:   ✔ account mismatch and expired cursors require an explicit new baseline (1.075709ms)
infomentor-mcp:test:   ✔ oversized output fails without a snapshot (13.274292ms)
infomentor-mcp:test:   ✔ roster edits abort collection but still restore the available original child (0.4275ms)
infomentor-mcp:test: ✔ collection snapshots replay deltas, preserve context, and fail without advancing (42.851666ms)
infomentor-mcp:test: ✔ private login and eleven MCP tools select children and read school data without changing read state (104.355541ms)
infomentor-mcp:test: ✔ expired sessions renew once with private credentials, preserve account and child, and persist cookies (25.943542ms)
infomentor-mcp:test: ✔ rejected login, unsafe redirects, challenges, rate limits and malformed authentication fail closed (3.912416ms)
infomentor-mcp:test: ✔ cancelled login/import cannot replace the previous account at the atomic commit (3.707667ms)
infomentor-mcp:test: ✔ HTTP cancellation and login deadlines abort in-flight requests; closing a client drains reads (44.953417ms)
infomentor-mcp:test: ✔ private loopback login form rejects cross-origin submissions and closes after use or cancellation (16.514083ms)
infomentor-mcp:test: ✔ session locks exclude live owners, recover dead owners safely, and release only their token (24.318333ms)
infomentor-mcp:test: ℹ tests 15
infomentor-mcp:test: ℹ suites 0
infomentor-mcp:test: ℹ pass 15
infomentor-mcp:test: ℹ fail 0
infomentor-mcp:test: ℹ cancelled 0
infomentor-mcp:test: ℹ skipped 0
infomentor-mcp:test: ℹ todo 0
infomentor-mcp:test: ℹ duration_ms 325.103708
abler-mcp:test: (pass) piped installer validates releases and keeps previous installs on failure [1481.64ms]
abler-mcp:test:
abler-mcp:test: test/integration.test.ts:
abler-mcp:test: (pass) private cookie import, renewal, pagination, validation, and redacted failures [14.42ms]
abler-mcp:test: (pass) Chrome capture is limited to loopback and to the Abler tab [3.18ms]
abler-mcp:test: (pass) MCP executable exposes only read tools and reports missing auth without protocol noise [76.57ms]
abler-mcp:test: (pass) child schedules separate siblings by ID, retain empty children, and paginate independently [5.38ms]
abler-mcp:test: (pass) separate processes serialize rotating credentials and logout waits for an in-flight request [3171.68ms]
abler-mcp:test: (pass) unsafe session files, malformed pages, stalled cursors, and wrong events fail explicitly [5.33ms]
abler-mcp:test: (pass) failed import retains a rotated candidate without overwriting the existing session [72.83ms]
abler-mcp:test:
abler-mcp:test:  8 pass
abler-mcp:test:  0 fail
abler-mcp:test:  81 expect() calls
abler-mcp:test: Ran 8 tests across 2 files. [4.92s]

 Tasks:    11 successful, 11 total
Cached:    0 cached, 11 total
  Time:    4.951s
```

Then run the exact command from the brief after moving aside generated output to verify restoration. Replayed per-task output below is from the successful forced run above:

```sh
bunx turbo run build typecheck lint format:check test
```

```text
• turbo 2.10.12

   • Packages in scope: @family-mcp/oxlint-anti-slop, @family-mcp/tsconfig, abler-mcp, infomentor-mcp
   • Running build, typecheck, lint, format:check, test in 4 packages
   • Remote caching disabled (in configuration)

abler-mcp:test: cache hit, replaying logs 3a10bf67b5700285
abler-mcp:test: $ bun test
abler-mcp:test: bun test v1.2.19 (aad3abea)
abler-mcp:test:
abler-mcp:test: test/install.test.ts:
abler-mcp:typecheck: cache hit, replaying logs 1ed2965a6acb6812
infomentor-mcp:typecheck: cache hit, replaying logs 01b3a719cb3b89b8
infomentor-mcp:lint: cache hit, replaying logs e4909f980484173b
//:format:root:check: cache hit, replaying logs 273b82b8c6160544
abler-mcp:test: (pass) piped installer validates releases and keeps previous installs on failure [1481.64ms]
abler-mcp:test:
abler-mcp:test: test/integration.test.ts:
abler-mcp:test: (pass) private cookie import, renewal, pagination, validation, and redacted failures [14.42ms]
infomentor-mcp:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity error src test scripts
infomentor-mcp:lint: Found 0 warnings and 0 errors.
infomentor-mcp:lint: Finished in 615ms on 16 files with 218 rules using 14 threads.
//:format:root:check: $ oxfmt --check package.json turbo.json .oxlintrc.json .oxfmtrc.json .github tooling
//:format:root:check: Checking formatting...
//:format:root:check:
//:format:root:check: All matched files use the correct format.
//:format:root:check: Finished in 10ms on 8 files using 14 threads.
abler-mcp:typecheck: $ tsc --noEmit
abler-mcp:test: (pass) Chrome capture is limited to loopback and to the Abler tab [3.18ms]
abler-mcp:test: (pass) MCP executable exposes only read tools and reports missing auth without protocol noise [76.57ms]
abler-mcp:test: (pass) child schedules separate siblings by ID, retain empty children, and paginate independently [5.38ms]
abler-mcp:test: (pass) separate processes serialize rotating credentials and logout waits for an in-flight request [3171.68ms]
abler-mcp:test: (pass) unsafe session files, malformed pages, stalled cursors, and wrong events fail explicitly [5.33ms]
abler-mcp:test: (pass) failed import retains a rotated candidate without overwriting the existing session [72.83ms]
abler-mcp:test:
abler-mcp:test:  8 pass
abler-mcp:test:  0 fail
abler-mcp:test:  81 expect() calls
abler-mcp:lint: cache hit, replaying logs b73bca0f7a4c0f91
infomentor-mcp:typecheck: $ tsc --noEmit
abler-mcp:test: Ran 8 tests across 2 files. [4.92s]
abler-mcp:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity error .
abler-mcp:lint: Found 0 warnings and 0 errors.
abler-mcp:lint: Finished in 438ms on 7 files with 218 rules using 14 threads.
infomentor-mcp:format:check: cache hit, replaying logs 0d00729c1870e65b
abler-mcp:format:check: cache hit, replaying logs 3a15c3814edda80e
infomentor-mcp:format:check: $ oxfmt -c ../../.oxfmtrc.json --check .
infomentor-mcp:format:check: Checking formatting...
infomentor-mcp:format:check:
infomentor-mcp:format:check: All matched files use the correct format.
infomentor-mcp:format:check: Finished in 275ms on 25 files using 14 threads.
abler-mcp:format:check: $ oxfmt -c ../../.oxfmtrc.json --check .
abler-mcp:format:check: Checking formatting...
abler-mcp:format:check:
abler-mcp:format:check: All matched files use the correct format.
abler-mcp:format:check: Finished in 213ms on 14 files using 14 threads.
abler-mcp:build: cache hit, replaying logs b3b98ec5991eb806
abler-mcp:build: $ rm -rf dist && tsc -p tsconfig.build.json
infomentor-mcp:build: cache hit, replaying logs ce91d642bdb9a7cc
infomentor-mcp:build: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
infomentor-mcp:test: cache hit, replaying logs facaed40e9047ffe
infomentor-mcp:test: $ bun run build && bun build ./test/*.test.ts --target=node --packages=external --outdir=.test-build && node --test .test-build/*.test.js
infomentor-mcp:test: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
infomentor-mcp:test: Bundled 12 modules in 3ms
infomentor-mcp:test:
infomentor-mcp:test:   collection.test.js   32.22 KB   (entry point)
infomentor-mcp:test:   integration.test.js  105.95 KB  (entry point)
infomentor-mcp:test:   lock.test.js         15.0 KB    (entry point)
infomentor-mcp:test:
infomentor-mcp:test: ▶ collection snapshots replay deltas, preserve context, and fail without advancing
infomentor-mcp:test:   ✔ baseline, identical grouping, full body edits, replay, and missing references (23.768875ms)
infomentor-mcp:test:   ✔ pagination limit restores selection and writes no snapshot (0.782625ms)
infomentor-mcp:test:   ✔ selection interference and cancellation restore with a fresh signal (0.581875ms)
infomentor-mcp:test:   ✔ restoration failure prevents a cursor and preserves authentication errors (0.483667ms)
infomentor-mcp:test:   ✔ account mismatch and expired cursors require an explicit new baseline (1.075709ms)
infomentor-mcp:test:   ✔ oversized output fails without a snapshot (13.274292ms)
infomentor-mcp:test:   ✔ roster edits abort collection but still restore the available original child (0.4275ms)
infomentor-mcp:test: ✔ collection snapshots replay deltas, preserve context, and fail without advancing (42.851666ms)
infomentor-mcp:test: ✔ private login and eleven MCP tools select children and read school data without changing read state (104.355541ms)
infomentor-mcp:test: ✔ expired sessions renew once with private credentials, preserve account and child, and persist cookies (25.943542ms)
infomentor-mcp:test: ✔ rejected login, unsafe redirects, challenges, rate limits and malformed authentication fail closed (3.912416ms)
infomentor-mcp:test: ✔ cancelled login/import cannot replace the previous account at the atomic commit (3.707667ms)
infomentor-mcp:test: ✔ HTTP cancellation and login deadlines abort in-flight requests; closing a client drains reads (44.953417ms)
infomentor-mcp:test: ✔ private loopback login form rejects cross-origin submissions and closes after use or cancellation (16.514083ms)
infomentor-mcp:test: ✔ session locks exclude live owners, recover dead owners safely, and release only their token (24.318333ms)
infomentor-mcp:test: ℹ tests 15
infomentor-mcp:test: ℹ suites 0
infomentor-mcp:test: ℹ pass 15
infomentor-mcp:test: ℹ fail 0
infomentor-mcp:test: ℹ cancelled 0
infomentor-mcp:test: ℹ skipped 0
infomentor-mcp:test: ℹ todo 0
infomentor-mcp:test: ℹ duration_ms 325.103708

 Tasks:    11 successful, 11 total
Cached:    11 cached, 11 total
  Time:    14ms >>> FULL TURBO
```
