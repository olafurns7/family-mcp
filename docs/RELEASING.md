# Release procedure

GitHub releases distribute prebuilt commands and an npm-compatible tarball. npm
publication is a separate, explicit step. No workflow publishes to npm.

## Before a release

1. Update `package.json` and the default `INFOMENTOR_VERSION` in `install.sh`.
   Update version-pinned README links, then refresh `bun.lock` with Bun.
2. Read the full change and verify account/session boundaries. Run
   `bun run release:check`, `bun audit`, `bun run build:binary`, and
   `bun run test:installer`. Install the test browser first. On Linux, use a
   virtual display for interactive-login tests.
3. Verify CI at the exact commit being released. Browser tests cover Chromium,
   Firefox, and WebKit; binary jobs build on native macOS/Linux x64/arm64 runners.
   Do not describe synthetic fixtures as live InfoMentor acceptance.
4. Keep preview limitations in the release notes until an actual parent account
   has verified login, restoration after restart, and the returned overview.

## GitHub release

Create and push a version tag only after reviewing the commit. Run the Release
workflow against that existing tag. The workflow checks that the tag matches
`package.json`, runs the checks, and creates a **draft** with:

- The prebuilt npm tarball and its SHA-256 checksum.
- Bundled-runtime archives for macOS/Linux, x64/arm64, and their checksums.
- The shell installer and release notes with copyable install commands.

Review the draft assets and validation results, then publish the draft. Release
URLs are not public while the release is a draft. Keep version tags and released
assets immutable; use a new version for changes. The shell installer references
an explicit version and verifies the archive before changing the command link.

After publishing, run the README command against the real download in an isolated
prefix, check `--version`, and perform an MCP handshake. This proves the public
installation path as well as the locally built artifact.

## Optional npm publication

The package is named `infomentor-mcp` with public access, an MIT license, repository
metadata, an executable entry point, and TypeScript exports. A registry lookup on
2026-09-11 returned 404 for the name; that is not a reservation or a guarantee of
future availability.

Only publish after explicit approval. Use a current npm client and an account
allowed to publish the package. Complete npm's account/authentication requirements
outside an agent conversation. Never commit or paste npm tokens.

Publish the exact tarball already validated in the GitHub release:

```sh
npm publish ./infomentor-mcp-0.1.3.tgz --dry-run --ignore-scripts --access public
# Only after deciding to publish:
npm publish ./infomentor-mcp-0.1.3.tgz --ignore-scripts --access public
```

The validation script already ran package-content checks, a clean npm install
with build scripts disabled, CLI/API/MCP smoke checks, strict consumer type checks,
and npm's publication dry-run. `--ignore-scripts` prevents rebuilding the reviewed
artifact during publication. npm does not allow replacing an already published
name/version; bump the version for a new artifact.

For later automated publication, configure npm trusted publishing for this exact
repository and a dedicated workflow. Trusted publishing uses OIDC and can attach
provenance; it requires npm 11.5.1+ and Node 22.14+. This is not configured by the
GitHub-release workflow and should not be implied by a successful GitHub release.

References: [npm tarball installation](https://docs.npmjs.com/cli/install/),
[npm publishing](https://docs.npmjs.com/cli/commands/npm-publish/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[GitHub release CLI](https://cli.github.com/manual/gh_release_create).
