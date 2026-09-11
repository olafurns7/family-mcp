# Maintainer release guide

Source: https://github.com/olafurns7/abler-mcp
License: MIT. Package name: `abler-mcp`. Standalone runtime: embedded Bun 1.4.2.
Alternative npm package runtime: Node.js 22+.
The first public distribution is a compiled GitHub release archive; npm
publication is a separate, deliberate operation. No npm publish workflow is
configured.

## Prepare and verify

1. Start from the intended clean commit. Review source and dependency changes.
   Never commit session/cookie exports, `.pending` recovery files, or credentials.
2. Update `package.json`, the pinned `version` in `install.sh`, and versioned
   install links in README and this guide's companion `AGENTS.md`. CLI and MCP
   versions read `package.json`; installer tests catch a mismatched script pin.
3. Install exactly the development dependencies from the Bun lockfile:

   ```sh
   bun install --frozen-lockfile
   npm pack
   ```

   `prepack` checks the installer's shell syntax and enforces type-aware linting, formatting, and TypeScript for source
   and tests, runs offline regression tests, deletes stale
   build output, and compiles the executable. A failed check blocks packing.
   Bun is a maintainer dependency; release consumers do not need it.

4. Inspect the tarball with `tar -tzf abler-mcp-VERSION.tgz`. It should contain
   only `dist/*.js`, `package.json`, README, LICENSE, and documentation/notices in `docs/`.
5. Install that archive into a temporary prefix with `npm install --global
--prefix /temporary/prefix --ignore-scripts ./abler-mcp-VERSION.tgz`. Run:

   ```sh
   bun test/pack-smoke.ts /temporary/prefix/bin/abler-mcp
   ```

   This starts the installed executable with Node, checks its version, makes a
   real MCP stdio connection, enumerates tools, and verifies a missing-session
   error. The check uses a private temporary directory and no live account.

6. Review runtime advisories (`npm audit --omit=dev` in a temporary npm install).
   Do not generate or commit a second root lockfile just for auditing.
7. If using authorized live credentials, separately check auth, profile, groups,
   filtering, pagination, per-child reporting, and event lookup. Never include
   account data in CI, release notes, or committed fixtures. Offline tests and
   live account verification are different evidence.

## GitHub distribution

Commit and push the reviewed files and wait for all package and standalone
jobs in `.github/workflows/ci.yml`. The standalone jobs build and smoke-test
on macOS 15 and Ubuntu 24.04, both arm64 and x64. Each uploads its verified
`.tar.gz` archive and matching `.tar.gz.sha256` as a workflow artifact. Download
those artifacts from the exact commit being released. For a local native build:

```sh
bun run build:native
bun test/pack-smoke.ts release/native/abler-mcp --standalone
```

Each native archive contains `abler-mcp`, `LICENSE`, and `THIRD_PARTY_NOTICES.txt`.
The executable includes its runtime and package dependencies. The smoke check
copies it outside the checkout, removes Node/Bun from PATH, and checks MCP
startup and errors. Update the third-party notices when bundled dependencies
or Bun change; retain the upstream source and rebuilding references.

Tag the verified commit `vVERSION`. Upload all four native archives and their
individual checksum files, plus the separately tested npm `.tgz` and its
`SHA256SUMS`, to the GitHub release. Each native checksum file must have exactly
one line: `HEX_DIGEST  abler-mcp-VERSION-PLATFORM-ARCH.tar.gz`. Create a new
version for changed bytes; never move a release tag or replace published assets.

The one-liner fetches `install.sh` from the release tag, downloads the matching
platform asset, verifies its digest and filename, and checks the binary before
replacing an existing installation. It needs curl, tar, and a SHA-256 utility,
with no Node/npm or registry access. Test the exact public command with an
isolated `ABLER_PREFIX` after publishing, then run `test/pack-smoke.ts` with
`--standalone` against that installed executable. Session files are never
release assets. npm publication remains a separate operation.

## Publish to npm only when authorized

The metadata and tarball are prepared, but the name is not reserved. Check its
availability and the intended npm account again immediately before publication.
Review the exact same tested archive and use `npm publish ./abler-mcp-VERSION.tgz
--dry-run --access public` first. An actual `npm publish` makes that version
public; do it only after deciding to publish and meeting npm's current account
and authentication requirements.

For future automated releases, prefer npm trusted publishing with GitHub OIDC
rather than a long-lived registry token. Configure the exact repository and
workflow filename on npm, grant `id-token: write` to the publish job, and use
an eligible GitHub-hosted runner with a supported npm version. Current npm
documentation requires npm 11.5.1+ / Node 22.14.0+; check it again when setting
up the workflow. Public source repository metadata must match for provenance.

References:

- [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [npm install from a tarball URL](https://docs.npmjs.com/cli/v11/commands/npm-install/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)

After publication, verify the registry's version and integrity and smoke-test
`npx --yes abler-mcp@VERSION --version` in a clean environment before changing
the main install guidance to the registry command.
