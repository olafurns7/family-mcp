# Changelog

## Unreleased

- Upgrades now report old running server processes and can stop them with
  `--stop-running`; otherwise restart the MCP host to use the new binary.

## 0.5.1

- Fix `list_schedule`, `list_child_schedules`, and `get_event` rejecting every
  event: Abler sends `arrivalTime` as a number (minutes before the start), and the
  0.5.0 output schema only accepted a string. Numeric and string values are both
  accepted now; the value is passed through unchanged.

## 0.5.0

- Added `auth login` with isolated temporary profiles: browser login uses a
  private pipe transport; no debugging port is opened.
- Close the browser before verification, keep signal cleanup idempotent through
  profile removal, and sweep abandoned login profiles older than one hour.
- Keep `--keep-browser` available for debugging while detaching the CLI; its
  retained browser has no debugging endpoint after the pipe closes.

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
