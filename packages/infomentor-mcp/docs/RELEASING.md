# Release process

Source: https://github.com/olafurns7/family-mcp/tree/main/packages/infomentor-mcp
Tags use `infomentor-mcp@<version>`; the current version is `infomentor-mcp@0.6.1`.
Native binaries are the only distribution.

1. Bump this package's `version` in `package.json`.
2. From the repository root, run `bun run release:sync`.
3. Commit the version and synchronized files.
4. Create the matching `infomentor-mcp@<version>` tag.
5. Push the tag.
6. Wait for the draft release to appear.
7. Verify its four native archives, SHA-256 files, and `install.sh` asset.
8. Publish the draft release.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.1/packages/infomentor-mcp/install.sh | sh
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
