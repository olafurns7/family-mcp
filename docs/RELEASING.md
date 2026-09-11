# Release process

GitHub releases contain prebuilt npm packages and Bun single-file executables.
Do not publish to npm unless that action is explicitly authorized.

1. Update `package.json`, the default version in `install.sh`, and versioned links
   in `README.md`. Use a new version; never rewrite a published tag.
2. With the pinned Bun version, run:

   ```sh
   bun install --frozen-lockfile
   bun run release:check
   bun run build:binary
   bun run test:installer
   ```

3. Review the complete diff and package contents, commit, and push `main` and a
   matching tag such as `v0.2.0`.
4. Run the **Release** workflow on that tag. It verifies the version, runs the
   Node 22/24 checks, validates the npm tarball, and builds/tests native macOS and
   Linux executables on arm64 and x64 runners. It creates a **draft preview**
   release only after the checks pass.
5. Inspect the draft's four platform archives and checksums, npm tarball and
   checksum, and `install.sh`. Verify that asset digests match the checksums and
   that the release notes describe the actual version.
6. Publish the authorized GitHub release and test its public installer in an
   isolated prefix. Use the installed executable to complete an MCP handshake.

The executable is compiled directly from `src/cli.ts` using Bun 1.4.2. It embeds
its runtime and dependencies; the archive includes its license notices and
README. Linux archives also contain the optional WARP installer and launcher
scripts; the Cloudflare client itself is downloaded only during opt-in setup.
CI tests replace administrator commands. Changes to WARP setup also need a
real Debian 13/x64 installation and daemon-recovery check before publication.
The npm artifact still runs on Node 22+ and exports TypeScript types.
Do not include session files, credentials files, investigation captures, browser
profiles, or environment files in any artifact.

The build script checks the pinned Bun version. If upgrading Bun, update
`packageManager`, the CI setup version, and `licenses/Bun.txt` from the same
upstream tag. Test the native builds before release.

## npm publication, only when requested

The package already has MIT licensing, repository metadata, an executable,
prebuilt exports, and a restricted files list. `test:package` performs a dry-run
publication, which does not publish anything. Once npm publication is explicitly
authorized, publish the reviewed release tarball:

```sh
npm publish ./infomentor-mcp-0.2.0.tgz --access public
```

Never treat a dry-run, a GitHub release, or passing CI as permission to publish
to the npm registry.
