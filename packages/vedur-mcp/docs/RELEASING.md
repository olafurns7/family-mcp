# Release process

The first version is `vedur-mcp@0.1.0`. Native binaries are the only
distribution. The executable is built from `rust/vedur-mcp`, using the pinned
Rust compiler, locked dependencies and rustls, with default features only.
There is no TypeScript implementation. Never enable `test-origin` in a release
build.

Before a release, run one short live check of each tool against the public IMO
services (a handful of requests, for example station 1, Reykjavík) and confirm
that the gottvedur.is forecast API still has the recorded shape. Offline tests
use recorded fixtures and are not evidence that the live services are unchanged.

From the repository root:

```sh
bun run --cwd packages/vedur-mcp release:sync
bunx turbo run release:check --filter=vedur-mcp
bunx turbo run build:binary test:binary test:installer --filter=vedur-mcp --force
```

Run the Rust fmt, Clippy and all-feature tests documented in the package README
before the native build. The package README and this guide are already included
in release version synchronization.

The package uses the shared native build, checksum-verifying installer, and
`vedur-mcp@<version>` release workflow. The maintainer must authorize version
changes, commits, tags, pushes, and publication. The workflow produces a draft
prerelease with macOS/Linux arm64/x64 archives, SHA-256 files, and `install.sh`.

After the checks pass, commit the release files, create the matching tag, and push
it. Wait for the draft release, verify all four archives, checksums, and installer,
then publish it as a prerelease.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/vedur-mcp@0.1.0/packages/vedur-mcp/install.sh | sh
```

Archives contain the executable, README, LICENSE, and generated dependency
notices. Never include test fixtures or captured responses.
