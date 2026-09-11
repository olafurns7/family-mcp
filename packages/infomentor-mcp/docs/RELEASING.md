# Release process

Source: https://github.com/olafurns7/family-mcp/tree/main/packages/infomentor-mcp
Package: `infomentor-mcp`. Tags use `infomentor-mcp@<version>`; the current version is `infomentor-mcp@0.5.0`.
The npm package runs on Node.js 22+. Standalone executables embed Bun 1.4.2.

1. Review the intended commit and update only this package's `package.json` version
   when preparing a new release. Never reuse a published version or move its tag.
2. From the monorepo root, with Bun 1.4.2 on PATH, run:

   ```sh
   bun install --frozen-lockfile
   bunx turbo run release:sync --filter=infomentor-mcp
   bunx turbo run build check test --filter=infomentor-mcp
   bunx turbo run test:dist test:binary test:installer --filter=infomentor-mcp
   ```

   `release:sync` generates `install.sh` and updates README/agent/release URLs from
   the manifest. Commit those generated files. CI checks both regeneration and
   version synchronization without modifying files.

3. Inspect the diff and archives. Commit and push only when authorized, then create
   and push the existing commit's `infomentor-mcp@<version>` tag. A current-version example
   is `infomentor-mcp@0.5.0`. Never include sessions, credentials, environment files,
   browser captures, or test fixtures in release assets.
4. The root **Release** workflow runs on package tags or can be dispatched on an
   existing tag. It checks the manifest and installer pin, reuses root CI, and
   drafts a prerelease with `--verify-tag`. CI tests Node 22/24 and builds/tests
   macOS/Linux arm64/x64 archives. The draft contains only this package's npm
   tarball, four native archives, their SHA-256 files, and generated `install.sh`.
5. Verify the draft's bytes, checksums and notes before authorizing publication.
   The installer URL is:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.5.0/packages/infomentor-mcp/install.sh | sh
   ```

   The npm archive URL is:

   ```sh
   npm install --global --ignore-scripts https://github.com/olafurns7/family-mcp/releases/download/infomentor-mcp@0.5.0/infomentor-mcp-0.5.0.tgz
   ```

6. After publication is authorized, test the public installer with a temporary
   prefix and run the shared MCP smoke against the installed executable.
   Offline checks and real account verification are separate evidence.

Native archives contain `infomentor-mcp/bin/infomentor-mcp`, README, LICENSE, and generated
THIRD_PARTY_NOTICES.txt. The builder checks Bun's version, embeds source maps,
and disables dotenv/bunfig autoload. It derives third-party notices from its
metafile and [`tooling/release/Bun.txt`](../../../tooling/release/Bun.txt).
Update that license and the root CI/packageManager pins together when upgrading Bun.
The installer verifies the checksum, extracts named members into fresh regular
files, checks the binary, and switches a symlink into a versioned directory.
Previous version directories are retained.

The npm tarball contains compiled code, README, LICENSE and package metadata, plus the public source and TypeScript declarations. Maintainer docs and release tools are excluded. `test:dist` checks
its allowlist, isolated installation, MCP handshake, and publication dry-run;
InfoMentor additionally checks its public consumer types.

No npm publishing workflow is configured. A dry-run or a passing release workflow
does not publish to the registry. Publish the reviewed tarball to npm only when
that separate action is explicitly authorized. Historical releases in the old
repositories must remain available to users whose installed scripts pin those URLs.

Linux archives also include the optional WARP installer and launcher. `--with-warp`
is explicit opt-in; ordinary upgrades preserve the chosen network mode and
`--without-warp` restores direct access. CI substitutes administrator commands.
Real Debian 13/x64 WARP installation and daemon-recovery verification remain
required before publishing changes to that integration.
