# Maintainer release guide

Source: https://github.com/olafurns7/abler-mcp
License: MIT. Package name: `abler-mcp`. Runtime: Node.js 22+.
The first public distribution is a compiled GitHub release archive; npm
publication is a separate, deliberate operation. No npm publish workflow is
configured.

## Prepare and verify

1. Start from the intended clean commit. Review source and dependency changes.
   Never commit session/cookie exports, `.pending` recovery files, or credentials.
2. Update `package.json` version and versioned install links in README and this
   guide's companion `AGENTS.md`. CLI and MCP versions read `package.json`.
3. Install exactly the development dependencies from the Bun lockfile:

   ```sh
   bun install --frozen-lockfile
   npm pack
   ```

   `prepack` checks TypeScript, runs offline regression tests, deletes stale
   build output, and compiles the executable. A failed check blocks packing.
   Bun is a maintainer dependency; release consumers do not need it.
4. Inspect the tarball with `tar -tzf abler-mcp-VERSION.tgz`. It should contain
   only `dist/*.js`, `package.json`, README, LICENSE, and `docs/*.md`.
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

Commit and push the reviewed files, tag the commit `vVERSION`, and upload the
compiled `abler-mcp-VERSION.tgz` plus its SHA-256 checksum to that release.
On macOS, produce the checksum with:

```sh
shasum -a 256 abler-mcp-VERSION.tgz > SHA256SUMS
```

Linux can use `sha256sum` instead. Create a new version for changed bytes;
do not replace an archive under an existing version link. Download the hosted
archive into a clean prefix and repeat the installed-package smoke check.
Consumers can optionally download `SHA256SUMS` and verify the archive before
installing it; the checksum must match the published release asset.

The one-liner installs directly from the versioned GitHub asset using npm's
native tarball support. It performs no build or lifecycle scripts. Registry
access is still needed for the package's declared runtime dependencies.

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
