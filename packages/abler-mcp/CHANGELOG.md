# Changelog

## 0.4.0

First release from the `family-mcp` monorepo. Install URLs moved to
`https://github.com/olafurns7/family-mcp/releases/download/abler-mcp@0.4.0/...`;
releases under the old repository are not updated.

- All six tools now declare strict output schemas and return `structuredContent`.
  Unknown upstream fields are stripped instead of forwarded; `list_groups` is validated.
- Tool errors are fixed, reviewed messages. Upstream response text, tokens, and
  cookies never reach tool output.
- `auth logout` also removes `.pending` candidates left by failed imports, and a
  later verified import prunes earlier candidates.
- Session storage moved to the shared `@family-mcp/session-store`: owner, mode,
  symlink, and hard-link checks on reads; `fsync` on writes; a dependency-free lock
  that waits up to 30 seconds and recovers dead owners but never expires a live process.
  `proper-lockfile` was removed.
- SIGINT/SIGTERM abort in-flight Abler requests, release the session lock, and exit promptly.
- Abler responses are capped at 4 MiB before parsing.
- Migrated to the shared native-only release tooling; the npm tarball is gone.

## 0.3.1

Last release from the standalone `abler-mcp` repository.
