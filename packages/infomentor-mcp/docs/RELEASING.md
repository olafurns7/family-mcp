# Release process

Source: https://github.com/olafurns7/family-mcp/tree/main/packages/infomentor-mcp
Tags use `infomentor-mcp@<version>`; the current version is `infomentor-mcp@0.5.0`.
Native binaries are the only distribution.

1. With Bun 1.4.2 on PATH, review the intended commit, update only this
   package's version when authorized, then run:

   ```sh
   bun install --frozen-lockfile
   bunx turbo run release:sync --filter=infomentor-mcp
   bunx turbo run check test --filter=infomentor-mcp
   bunx turbo run test:binary test:installer --filter=infomentor-mcp
   ```

2. `release:sync` regenerates `install.sh` and version-pinned package docs.
   Commit those generated files. Inspect the diff and native archive before
   pushing an exact-commit `infomentor-mcp@<version>` tag.
3. The Release workflow verifies the tag and installer pin, reuses CI, and
   drafts a prerelease containing four native archives, their SHA-256 files,
   and `install.sh`. Verify the draft before authorizing it.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.5.0/packages/infomentor-mcp/install.sh | sh
```

Archives contain the executable, README, LICENSE, and generated third-party
notices. The installer verifies the checksum and version before replacing the
command; previous version directories remain. Never include sessions,
credentials, environment files, browser captures, or fixtures in release assets.

Linux archives also include the optional WARP installer and launcher. `--with-warp`
is explicit opt-in; ordinary upgrades preserve the chosen network mode and
`--without-warp` restores direct access. CI substitutes administrator commands.
Real Debian 13/x64 WARP installation and daemon-recovery verification remain
required before releasing changes to that integration.
