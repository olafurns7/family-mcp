# Release process

Source: https://github.com/olafurns7/family-mcp/tree/main/packages/abler-mcp
Tags use `abler-mcp@<version>`; the current version is `abler-mcp@0.3.1`.
Native binaries are the only distribution.

1. With Bun 1.4.2 on PATH, review the intended commit, update only this
   package's version when authorized, then run:

   ```sh
   bun install --frozen-lockfile
   bunx turbo run release:sync --filter=abler-mcp
   bunx turbo run check test --filter=abler-mcp
   bunx turbo run test:binary test:installer --filter=abler-mcp
   ```

2. `release:sync` regenerates `install.sh` and version-pinned package docs.
   Commit those generated files. Inspect the diff and native archive before
   pushing an exact-commit `abler-mcp@<version>` tag.
3. The Release workflow verifies the tag and installer pin, reuses CI, and
   drafts a prerelease containing four native archives, their SHA-256 files,
   and `install.sh`. Verify the draft before authorizing it.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.3.1/packages/abler-mcp/install.sh | sh
```

Archives contain the executable, README, LICENSE, and generated third-party
notices. The installer verifies the checksum and version before replacing the
command; previous version directories remain. Never include sessions,
credentials, environment files, browser captures, or fixtures in release assets.
