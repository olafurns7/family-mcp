# Release process

The unreleased preview is `dominos-mcp@0.1.0`. Native binaries are the only
distribution. Live SMS login, refresh, quotes, and saved-card sessions have been
checked. Do not publish until direct payment and the documented bank-verification
limitations have been reviewed; no purchase has been made for validation.

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

Archives contain the executable, README, LICENSE, and generated dependency
notices. Never include sessions, checkout records, environment files, SMS codes,
card tokens, browser captures, or test fixtures. Offline binary and installer
checks are not evidence of live account connectivity or a successful purchase.
