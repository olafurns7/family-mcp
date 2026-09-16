# Release process

The current preview is `dominos-mcp@0.1.0`. Native binaries are the only
distribution. Live SMS login, refresh, quotes, and saved-card sessions have been
checked. Charging remains untested and bank-verification continuation is not
implemented; retain these limitations in the release notes.

From the repository root:

```sh
bun run --cwd packages/dominos-mcp release:sync
bunx turbo run check test release:check --filter=dominos-mcp
bunx turbo run test:binary test:installer --filter=dominos-mcp
```

The package uses the shared native build, checksum-verifying installer, and
`dominos-mcp@<version>` release workflow. The maintainer must authorize version
changes, commits, tags, pushes, and publication. The workflow produces a draft
prerelease with macOS/Linux arm64/x64 archives, SHA-256 files, and `install.sh`.

After the checks pass, commit the release files, create the matching tag, and push
it. Wait for the draft release, verify all four archives, checksums, and installer,
then publish it as a prerelease.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/dominos-mcp@0.1.0/packages/dominos-mcp/install.sh | sh
```

Archives contain the executable, README, LICENSE, and generated dependency
notices. Never include sessions, checkout records, environment files, SMS codes,
card tokens, browser captures, or test fixtures. Offline binary and installer
checks are not evidence of live account connectivity or a successful purchase.
