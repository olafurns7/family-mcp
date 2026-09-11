# Phase 2A report: SDK v2 and shared release tooling

Completed on 2026-09-11 in `/Users/olafurns/Verkefni/family-mcp/.worktrees/terra`, branch `phase2/sdk-and-release`, based on `6b521c7`.

All requested local acceptance checks pass. The forced build/typecheck/lint/format/test run completed **14/14 tasks** with no cache hits. The forced distribution/binary/installer run completed **10/10 tasks** with no cache hits. No versions were bumped, no live login occurred, and no repository, tag, push, merge, publication, or hosted release was created.

## SDK migration

InfoMentor now uses `@modelcontextprotocol/server` v2. The migration follows the Phase 1 analysis:

- Replaced the v1 server/types imports and CLI stdio transport import with v2 exports.
- Changed exactly seven handler cancellation accesses from `extra.signal` to `ctx.mcpReq.signal`.
- Kept `server.server.onclose` and the CLI's existing close-on-EOF/signal behavior.
- Moved integration tests and package/installer client imports to `@modelcontextprotocol/client` v2, including the linked in-memory transport pair from the same client package.
- Removed the v1 SDK dependency and updated the root lockfile. Both server packages now resolve server v2.0.0 and client v2.0.0.
- Added the library compatibility note: `createServer()` returns a v2 `McpServer`, so consumers using v1 SDK types must migrate.

All **15 InfoMentor tests** pass. An explicit assertion verifies that the unknown-child error remains `isError: true` with `structuredContent === undefined` despite its registered output schema. The shared installed/native smoke also checks this behavior on a missing-session overview call. The SDK-migration commit's isolated npm consumer smoke passed before extraction, including consumer types and publication dry-run.

The migration was checked against the installed v2 types and the official [v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md), queried through Context7.

## Release tooling

Added private workspace `@family-mcp/release-tooling` at `tooling/release`, version 0.0.0. Its `.mjs` files are checked with TypeScript `checkJs` under the shared strict base and all existing root lint rules. The only new lint exception permits console output in these command-line tools; no anti-slop or type-safety rule was disabled for them.

| Tool | Behavior |
| --- | --- |
| `build-binary.mjs --package <dir>` | One pinned-Bun builder for both packages, with explicit `bun-<platform>-<arch>` target, minification, source maps, and both compile-autoload disabling flags. Generates dependency notices from actual metafile inputs and the shared Bun license. Produces a checksummed archive and `release/native/<name>` for standalone checks. |
| `render-install.mjs --package <dir> [--check]` | Renders the committed installer from one `install.sh.template`. `--check` computes the output and requires byte-for-byte equality without writing. |
| `installer-test.mjs --package <dir> [--mode fake\|real\|both]` | One shared harness, defaulting to both modes. Retains the original 12 fake-command cases and the real-archive installer checks. |
| `mcp-smoke.mjs --bin <path> --expect-tools <names...>` | Shared v2 stdio smoke. Also accepts `--package` to read expected tools/version and `--standalone` to copy the executable outside the checkout with Node/Bun absent from PATH. |
| `test-dist.mjs --package <dir>` | Packs built output, checks the package allowlist, installs into a temporary consumer without lifecycle scripts, runs the shared MCP smoke, retains InfoMentor's public-library runtime/type checks, and runs npm publication dry-run. |
| `sync-version.mjs --package <dir> [--check]` | Regenerates the installer and synchronizes README, AGENTS, and release-guide URLs, package tags, and npm archive version references from package.json. |
| `package.mjs` | Shared validated manifest loading, including safe relative paths for configured extra files. |
| `release.test.mjs` | One Node test verifies deterministic rendering/sync, invalid extra-file paths, the actual workflow's tag validation, package-only asset selection, and rejection of corrupt assets. |

The small `familyMcp.release` block in each manifest stores expected MCP tool names. InfoMentor additionally declares its Linux WARP setup and launcher files. WARP remains optional and supports the same `--with-warp` / `--without-warp` behavior and saved connection mode.

Removed the duplicated per-package builders, installer harnesses, and MCP smoke scripts. Moved the unchanged Bun license to `tooling/release/Bun.txt`. Deleted Abler's hand-maintained third-party notices and removed maintainer docs from its npm `files` allowlist. The final local native archives contain generated notices for **10 Abler** and **8 InfoMentor** bundled dependencies; archive inspection confirmed server SDK, tough-cookie, zod, and Bun notices.

## Installer behavior

Both committed installers now use the same implementation:

- A final `main "$@"` invocation prevents a truncated piped script from starting installation.
- HTTPS-only downloads and exact checksum/digest-filename matching precede installation.
- Each named tar member is streamed with `tar -xO` into a fresh regular file; archive paths and links are never generally extracted.
- Executable version verification precedes changing the installed command.
- A version/checksum directory under the chosen prefix stores the release, and a symlink in `bin/` selects it. Staging and command replacement occur on the destination filesystem. Prior version directories are retained.
- `ABLER_VERSION` / `INFOMENTOR_VERSION` select another released version; the existing prefix variables remain supported.
- InfoMentor's optional administrator hook uses only a freshly verified WARP member, and ordinary upgrades preserve its saved direct/WARP mode.

The 12 fixture cases retained for **each package** are checksum mismatch, wrong checksum filename, failed download, missing required commands, relative prefix, unsupported OS, unsupported CPU, wrong binary version, invalid archive, failed move, command-path directory collision, and successful installation. Each also checks temporary-download cleanup and preservation of the previous command on failure. Both packages additionally pass a truncated-script check.

Real-archive mode retains spaced-prefix installation, unknown-argument rejection, reinstall, bad-checksum rejection with the previous command preserved, and standalone MCP verification. The Linux/x64 InfoMentor branch retains WARP selection, mode persistence, switching back to direct, administrator-call assertions, and launcher argument/stdin preservation. That platform-specific branch was not executed on this Mac.

## Turbo and CI

Both packages expose `build:binary`, `test:dist`, `test:binary`, `test:installer`, `release:sync`, and `release:check` through the shared tools. `test:dist` depends on `build`; `test:binary` depends on `build` and `build:binary`; `test:installer` depends on `build:binary`. Release mutation/runtime tasks bypass caching and declare their generated outputs. They remain separate CI checks rather than part of the default application test suites.

Default tests now report **7 Abler application tests**, **15 InfoMentor tests**, and **1 shared release-tooling test**. Abler's former eighth test was its installer suite, which moved intact into the separate shared installer task and now runs for both packages.

Root CI still tests Node 22/24 and the four macOS/Linux x64/arm64 standalone runners. It now calls shared distribution/binary/installer Turbo tasks. Root `check` also depends on `release:check`, so stale generated installers or documentation pins fail CI. `actionlint .github/workflows/*.yml` passes.

The previous broad `release/` ignore rules also matched the newly requested `tooling/release` source directory. Added the narrow gitignore exception and scoped Oxc artifact ignores to package release directories. Existing secret/session ignore patterns are unchanged.

Turbo initially selected its automatic shared worktree cache. Setting an explicit `.turbo/cache` keeps subsequent caching in this worktree; no main or Luna source files were edited. Remote caching remains disabled. npm cache variables are explicitly passed through to distribution tasks for sandbox-compatible isolated checks.

## Per-package releases

Moved release orchestration to `.github/workflows/release.yml`. It accepts existing tags such as `abler-mcp@0.3.1` and `infomentor-mcp@0.5.0`, on tag push or manual dispatch on a tag.

The version job rejects unsupported package names, malformed tags, branch dispatches, version mismatches, and installer-pin mismatches. The workflow reuses root CI. Its draft job collects only the selected package's npm archive and four native archives with their checksum files, rejects duplicate/missing assets, verifies every selected digest, and includes that package's generated installer. It creates a **draft prerelease** with `--verify-tag`; it does not publish to npm.

The workflow's inline Node programs are executed by the local release-tooling test against synthetic package manifests and artifacts for both packages. The test confirms exactly 11 selected files: five archives, five checksums, and one installer, with no sibling-package assets.

Both manifests now identify `git+https://github.com/olafurns7/family-mcp.git` and their respective `repository.directory`. Installers, READMEs, Abler's AGENTS/PUBLISHING guides, and InfoMentor's RELEASING guide use:

```text
https://raw.githubusercontent.com/olafurns7/family-mcp/<pkg>@<ver>/packages/<pkg>/install.sh
https://github.com/olafurns7/family-mcp/releases/download/<pkg>@<ver>/<asset>
```

Existing package versions remain **Abler 0.3.1** and **InfoMentor 0.5.0**. No tags were created. Historical original-repository releases must remain available for users whose existing installers pin their old URLs.

## Boundaries and remaining verification

All authored changes and commits are in the Terra worktree and branch. Compared the protected `packages/*/src/auth.ts`, `session.ts`, `lock.ts`, and `credentials.ts` paths against `6b521c7`; none changed. The Luna worktree was not edited, and no merge was attempted.

Local evidence is from **macOS arm64, Node v24.12.0**. The global Bun remains **1.2.19**; it passed frozen installation and the required forced regression run. Native/release tests used the existing temporary **Bun 1.4.2** installation at `/private/tmp/family-mcp-phase1-runtime/node_modules/.bin`. No global upgrade was performed. npm used `/private/tmp/family-mcp-phase1-npm-cache` because the default user cache is outside the writable sandbox.

No required local check remains failing. Hosted Actions, Node 22 execution, Linux/native x64 builds, actual WARP administrator setup, public installer URLs, and real account connectivity are **not verified locally**. The workflow and URL scheme are prepared for the future monorepo remote; no GitHub repository was created.

After merging Luna's security track, reconcile `familyMcp.release.tools` with the resulting default InfoMentor tool surface and rerun the combined checks. This branch intentionally preserves the requested current eleven-tool surface; its smoke reads the expected names from package metadata.

## Commits

```text
0507b05 Migrate infomentor-mcp to @modelcontextprotocol/server v2
b88ef33 Share release tooling and adopt per-package release tags
```

SDK migration is isolated in its requested commit. The interdependent installer, archive layout, shared checks, and release workflow changes are committed together so the release pipeline stays coherent. This report is committed separately. Every commit ends with:

```text
Claude-Session: https://claude.ai/code/session_01L7a5Fz4dusPukqVAxrAqMC
```

## Final acceptance output

Only trailing terminal whitespace is omitted below.

```sh
bun install --frozen-lockfile
```

```text
bun install v1.2.19 (aad3abea)

Checked 50 installs across 116 packages (no changes) [3.00ms]
```

```sh
bunx turbo run build typecheck lint format:check test --force
```

```text
• turbo 2.10.12

   • Packages in scope: @family-mcp/oxlint-anti-slop, @family-mcp/release-tooling, @family-mcp/tsconfig, abler-mcp, infomentor-mcp
   • Running build, typecheck, lint, format:check, test in 5 packages
   • Remote caching disabled (in configuration)

@family-mcp/release-tooling:typecheck: cache bypass, force executing 70297dcd74fbed34
abler-mcp:typecheck: cache bypass, force executing f9e0e2f78d9bc2d8
infomentor-mcp:lint: cache bypass, force executing 12ff33064d9e45bf
@family-mcp/release-tooling:lint: cache bypass, force executing 4a8813e6b1d69888
//:format:root:check: cache bypass, force executing 3fc7cb51b143f8ec
@family-mcp/release-tooling:test: cache bypass, force executing d3e7e61f510402d9
abler-mcp:lint: cache bypass, force executing b3f29e2c8013f318
abler-mcp:test: cache bypass, force executing ff8795ec55ecf1b0
infomentor-mcp:typecheck: cache bypass, force executing 018252b0eaeac160
infomentor-mcp:build: cache bypass, force executing 3d6b9af91df4c26d
//:format:root:check: $ oxfmt --check package.json turbo.json .oxlintrc.json .oxfmtrc.json .github tooling
abler-mcp:typecheck: $ tsc --noEmit
@family-mcp/release-tooling:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings .
infomentor-mcp:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity error src test
@family-mcp/release-tooling:typecheck: $ tsc --noEmit
@family-mcp/release-tooling:test: $ node --test release.test.mjs
abler-mcp:lint: $ oxlint -c ../../.oxlintrc.json --deny-warnings --report-unused-disable-directives-severity error .
abler-mcp:test: $ bun test
infomentor-mcp:typecheck: $ tsc --noEmit
infomentor-mcp:build: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
abler-mcp:test: bun test v1.2.19 (aad3abea)
abler-mcp:test:
abler-mcp:test: test/integration.test.ts:
//:format:root:check: Checking formatting...
//:format:root:check:
//:format:root:check: All matched files use the correct format.
//:format:root:check: Finished in 21ms on 19 files using 14 threads.
abler-mcp:build: cache bypass, force executing 9840d41c1d051f3d
abler-mcp:build: $ rm -rf dist && tsc -p tsconfig.build.json
abler-mcp:format:check: cache bypass, force executing 436e14d6a32a6dc3
abler-mcp:format:check: $ oxfmt -c ../../.oxfmtrc.json --check .
infomentor-mcp:format:check: cache bypass, force executing be7b6fe42483a625
infomentor-mcp:format:check: $ oxfmt -c ../../.oxfmtrc.json --check .
abler-mcp:format:check: Checking formatting...
abler-mcp:format:check:
abler-mcp:test: (pass) private cookie import, renewal, pagination, validation, and redacted failures [167.89ms]
abler-mcp:test: (pass) Chrome capture is limited to loopback and to the Abler tab [7.57ms]
infomentor-mcp:format:check: Checking formatting...
infomentor-mcp:format:check:
@family-mcp/release-tooling:lint: Found 0 warnings and 0 errors.
@family-mcp/release-tooling:lint: Finished in 446ms on 8 files with 218 rules using 14 threads.
abler-mcp:lint: Found 0 warnings and 0 errors.
abler-mcp:lint: Finished in 444ms on 5 files with 218 rules using 14 threads.
infomentor-mcp:test: cache bypass, force executing e41302f64f443f19
abler-mcp:format:check: All matched files use the correct format.
abler-mcp:format:check: Finished in 263ms on 12 files using 14 threads.
infomentor-mcp:test: $ bun run build && bun build ./test/*.test.ts --target=node --packages=external --outdir=.test-build && node --test .test-build/*.test.js
infomentor-mcp:test: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
abler-mcp:test: (pass) MCP executable exposes only read tools and reports missing auth without protocol noise [280.81ms]
abler-mcp:test: (pass) child schedules separate siblings by ID, retain empty children, and paginate independently [8.57ms]
infomentor-mcp:format:check: All matched files use the correct format.
infomentor-mcp:format:check: Finished in 245ms on 21 files using 14 threads.
infomentor-mcp:lint: Found 0 warnings and 0 errors.
infomentor-mcp:lint: Finished in 669ms on 13 files with 218 rules using 14 threads.
infomentor-mcp:test: Bundled 12 modules in 3ms
infomentor-mcp:test:
infomentor-mcp:test:   collection.test.js   32.22 KB   (entry point)
infomentor-mcp:test:   integration.test.js  107.23 KB  (entry point)
infomentor-mcp:test:   lock.test.js         15.0 KB    (entry point)
infomentor-mcp:test:
infomentor-mcp:test: ▶ collection snapshots replay deltas, preserve context, and fail without advancing
infomentor-mcp:test:   ✔ baseline, identical grouping, full body edits, replay, and missing references (22.901458ms)
infomentor-mcp:test:   ✔ pagination limit restores selection and writes no snapshot (0.67825ms)
infomentor-mcp:test:   ✔ selection interference and cancellation restore with a fresh signal (0.532958ms)
infomentor-mcp:test:   ✔ restoration failure prevents a cursor and preserves authentication errors (0.484417ms)
infomentor-mcp:test:   ✔ account mismatch and expired cursors require an explicit new baseline (1.132333ms)
infomentor-mcp:test:   ✔ oversized output fails without a snapshot (13.020708ms)
infomentor-mcp:test:   ✔ roster edits abort collection but still restore the available original child (0.424042ms)
infomentor-mcp:test: ✔ collection snapshots replay deltas, preserve context, and fail without advancing (41.534ms)
infomentor-mcp:test: ✔ private login and eleven MCP tools select children and read school data without changing read state (124.8375ms)
infomentor-mcp:test: ✔ expired sessions renew once with private credentials, preserve account and child, and persist cookies (25.169875ms)
infomentor-mcp:test: ✔ rejected login, unsafe redirects, challenges, rate limits and malformed authentication fail closed (4.503833ms)
infomentor-mcp:test: ✔ cancelled login/import cannot replace the previous account at the atomic commit (3.702583ms)
infomentor-mcp:test: ✔ HTTP cancellation and login deadlines abort in-flight requests; closing a client drains reads (45.666917ms)
infomentor-mcp:test: ✔ private loopback login form rejects cross-origin submissions and closes after use or cancellation (16.582958ms)
infomentor-mcp:test: ✔ session locks exclude live owners, recover dead owners safely, and release only their token (12.836459ms)
infomentor-mcp:test: ℹ tests 15
infomentor-mcp:test: ℹ suites 0
infomentor-mcp:test: ℹ pass 15
infomentor-mcp:test: ℹ fail 0
infomentor-mcp:test: ℹ cancelled 0
infomentor-mcp:test: ℹ skipped 0
infomentor-mcp:test: ℹ todo 0
infomentor-mcp:test: ℹ duration_ms 338.264208
@family-mcp/release-tooling:test: ✔ release generation, version tags, and package-specific assets stay consistent (1060.93ms)
@family-mcp/release-tooling:test: ℹ tests 1
@family-mcp/release-tooling:test: ℹ suites 0
@family-mcp/release-tooling:test: ℹ pass 1
@family-mcp/release-tooling:test: ℹ fail 0
@family-mcp/release-tooling:test: ℹ cancelled 0
@family-mcp/release-tooling:test: ℹ skipped 0
@family-mcp/release-tooling:test: ℹ todo 0
@family-mcp/release-tooling:test: ℹ duration_ms 1146.324958
abler-mcp:test: (pass) separate processes serialize rotating credentials and logout waits for an in-flight request [3184.78ms]
abler-mcp:test: (pass) unsafe session files, malformed pages, stalled cursors, and wrong events fail explicitly [5.93ms]
abler-mcp:test: (pass) failed import retains a rotated candidate without overwriting the existing session [75.96ms]
abler-mcp:test:
abler-mcp:test:  7 pass
abler-mcp:test:  0 fail
abler-mcp:test:  81 expect() calls
abler-mcp:test: Ran 7 tests across 1 file. [3.80s]

 Tasks:    14 successful, 14 total
Cached:    0 cached, 14 total
  Time:    3.826s
```

The release run used the temporary pinned Bun and sandbox-compatible npm cache:

```sh
PATH=/private/tmp/family-mcp-phase1-runtime/node_modules/.bin:$PATH \
npm_config_cache=/private/tmp/family-mcp-phase1-npm-cache \
bunx turbo run test:dist test:binary test:installer --force
```

```text
• turbo 2.10.12

   • Packages in scope: @family-mcp/oxlint-anti-slop, @family-mcp/release-tooling, @family-mcp/tsconfig, abler-mcp, infomentor-mcp
   • Running test:dist, test:binary, test:installer in 5 packages
   • Remote caching disabled (in configuration)

infomentor-mcp:build: cache bypass, force executing a6c7b522ac812dba
abler-mcp:build: cache bypass, force executing 38d0401e88f8a558
infomentor-mcp:build:binary: cache bypass, force executing 1bc5b33f22507bb6
abler-mcp:build:binary: cache bypass, force executing 0201a8cf42516f81
abler-mcp:build: $ rm -rf dist && tsc -p tsconfig.build.json
infomentor-mcp:build: $ node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && tsc -p tsconfig.build.json
abler-mcp:build:binary: $ node ../../tooling/release/build-binary.mjs --package .
infomentor-mcp:build:binary: $ node ../../tooling/release/build-binary.mjs --package .
infomentor-mcp:build:binary:   [12ms]  minify  -1.66 MB (estimate)
infomentor-mcp:build:binary:    [5ms]  bundle  158 modules
abler-mcp:build:binary:   [12ms]  minify  -1.47 MB (estimate)
abler-mcp:build:binary:    [7ms]  bundle  138 modules
abler-mcp:test:dist: cache bypass, force executing c78d0e4817c26055
abler-mcp:test:dist: $ node ../../tooling/release/test-dist.mjs --package .
infomentor-mcp:build:binary:  [101ms] compile  /tmp/infomentor-mcp-binary-AbBicr/infomentor-mcp/bin/infomentor-mcp
abler-mcp:build:binary:  [104ms] compile  /tmp/abler-mcp-binary-Va7td5/abler-mcp/bin/abler-mcp
infomentor-mcp:test:dist: cache bypass, force executing 46d36c5341e45a25
infomentor-mcp:test:dist: $ node ../../tooling/release/test-dist.mjs --package .
abler-mcp:test:dist: MCP smoke passed: 6 tools, Node executable, version/help, missing authentication, and clean protocol.
infomentor-mcp:test:dist: MCP smoke passed: 11 tools, Node executable, version/help, missing authentication, and clean protocol.
infomentor-mcp:build:binary: Built infomentor-mcp-0.5.0-darwin-arm64.tar.gz with Bun 1.4.2; generated notices for 8 bundled dependencies.
infomentor-mcp:test:installer: cache bypass, force executing 5472e5b722f8a9be
infomentor-mcp:test:binary: cache bypass, force executing e93053f08428d6aa
infomentor-mcp:test:binary: $ node ../../tooling/release/mcp-smoke.mjs --package . --bin release/native/infomentor-mcp --standalone
infomentor-mcp:test:installer: $ node ../../tooling/release/installer-test.mjs --package .
abler-mcp:build:binary: Built abler-mcp-0.3.1-darwin-arm64.tar.gz with Bun 1.4.2; generated notices for 10 bundled dependencies.
abler-mcp:test:installer: cache bypass, force executing b46e51790d9de746
abler-mcp:test:binary: cache bypass, force executing cd5596c51e3a30b0
abler-mcp:test:dist: abler-mcp: package allowlist, isolated installation, MCP smoke, consumer types (when exported), and publication dry-run passed.
abler-mcp:test:installer: $ node ../../tooling/release/installer-test.mjs --package .
abler-mcp:test:binary: $ node ../../tooling/release/mcp-smoke.mjs --package . --bin release/native/abler-mcp --standalone
infomentor-mcp:test:binary: MCP smoke passed: 11 tools, standalone executable, version/help, missing authentication, and clean protocol.
infomentor-mcp:test:dist: infomentor-mcp: package allowlist, isolated installation, MCP smoke, consumer types (when exported), and publication dry-run passed.
abler-mcp:test:binary: MCP smoke passed: 6 tools, standalone executable, version/help, missing authentication, and clean protocol.
infomentor-mcp:test:installer: infomentor-mcp: all 12 piped-installer cases and truncated-script check passed.
abler-mcp:test:installer: abler-mcp: all 12 piped-installer cases and truncated-script check passed.
infomentor-mcp:test:installer: MCP smoke passed: 11 tools, standalone executable, version/help, missing authentication, and clean protocol.
infomentor-mcp:test:installer: infomentor-mcp: real archive installation, spaced prefix, reinstall, checksum rejection, previous-command preservation, and MCP smoke passed.
abler-mcp:test:installer: MCP smoke passed: 6 tools, standalone executable, version/help, missing authentication, and clean protocol.
abler-mcp:test:installer: abler-mcp: real archive installation, spaced prefix, reinstall, checksum rejection, previous-command preservation, and MCP smoke passed.

 Tasks:    10 successful, 10 total
Cached:    0 cached, 10 total
  Time:    7.578s
```
