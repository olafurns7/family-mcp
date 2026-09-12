# Changelog

## 0.6.0

First release from the `family-mcp` monorepo. Install URLs moved to
`https://github.com/olafurns7/family-mcp/releases/download/infomentor-mcp@0.6.0/...`;
releases under the old repository are not updated.

Breaking changes:

- `infomentor_login`, `infomentor_setup_status`, `infomentor_cancel_setup`, and
  `infomentor_logout` are registered only when `serve` runs with `--allow-setup-tools`.
  By default the server exposes seven read tools and a missing session points to the CLI.
- An explicit `login` or `import` refuses to replace a session verified for a
  different account, or an unreadable session file, unless `--allow-account-change`
  (or `allowAccountChange`) is given.
- `infomentor_setup_status` no longer returns `loginUrl`; the local form URL is
  printed on the server's standard error only.
- New installs store the session at `~/.config/infomentor-mcp/session.json`
  (XDG). An existing `~/.infomentor-mcp/session.json` keeps working.
- Migrated to `@modelcontextprotocol/server` v2. The npm package and library
  entry points are gone; the native executable is the only distribution.

Other changes:

- Feed items (timetable, messages, notifications) are parsed independently: a
  malformed item is skipped and counted in `skipped` and `skippedByFeed`, display
  names may be `null`, and unknown notification `state` values pass through.
  Collection keeps the previous baseline for any feed with skipped rows, so a
  transient upstream glitch cannot produce false "missing" reports.
- A `429 Retry-After` pause is capped at one hour, saved with the session, and
  honoured by every process using that session file.
- The login `--timeout` now covers waiting for the session lock.
- Session, import, and credentials files are read through the shared
  `@family-mcp/session-store` with owner, mode, symlink, hard-link, and size checks;
  writes are `fsync`ed; the lock waits up to 30 seconds and never expires a live process.
- Logout also removes collection snapshots.
- Tool errors are fixed, reviewed messages; upstream text never reaches tool output.
- Tests run under `bun test` with injected seams; a loopback HTTP fixture covers
  redirects, cookies, rate limits, and oversized bodies.

## 0.5.0

Last release from the standalone `infomentor-mcp` repository.
