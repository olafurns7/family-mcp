# family-mcp

Two local, read-only MCP servers for a parent's Abler sports schedules and
InfoMentor school account. Each release is a standalone native executable, so
your MCP host can read the family data you request without installing Node, npm,
or Bun at runtime. See the detailed [Abler](packages/abler-mcp/README.md) and
[InfoMentor](packages/infomentor-mcp/README.md) references for recovery and
service-specific limits.

## Install

macOS and glibc Linux on arm64/x64 are supported. Run the installer for each
server you use:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.3.1/packages/abler-mcp/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.5.0/packages/infomentor-mcp/install.sh | sh
```

Each installer downloads the matching archive, verifies its SHA-256 checksum and
executable version, installs it under `~/.local/share/<package>/`, then updates
the `~/.local/bin/<package>` symlink only after validation. Add
`~/.local/bin` to your `PATH` for shell use; configure MCP hosts with the
absolute path instead.

Upgrade by running the same package's command again. It preserves its session
file and replaces the command only after the new download passes validation.
To remove an executable, stop its MCP host, then remove its command and release
directory; this does not remove its session file:

```sh
rm -f ~/.local/bin/abler-mcp ~/.local/bin/infomentor-mcp
rm -rf ~/.local/share/abler-mcp ~/.local/share/infomentor-mcp
```

If you installed InfoMentor with `--with-warp`, follow its
[connection instructions](packages/infomentor-mcp/docs/CONNECTIVITY.md) before
removing the separately managed WARP setup.

## Connect to your MCP host

Replace `/home/you` with an absolute path on the computer running the MCP host.
JSON and TOML configuration usually do not expand `~` or `$HOME`.

### Claude Desktop

Add this to Claude Desktop's MCP JSON configuration:

```json
{
  "mcpServers": {
    "abler": {
      "command": "/home/you/.local/bin/abler-mcp",
      "args": ["serve"],
      "env": { "ABLER_SESSION_FILE": "/home/you/.config/abler-mcp/session.json" }
    },
    "infomentor": {
      "command": "/home/you/.local/bin/infomentor-mcp",
      "args": ["serve"],
      "env": { "INFOMENTOR_SESSION_PATH": "/home/you/.config/infomentor-mcp/session.json" }
    }
  }
}
```

### Claude Code

Run these in the project where Claude Code should use the servers:

```sh
claude mcp add abler -e ABLER_SESSION_FILE=/home/you/.config/abler-mcp/session.json -- /home/you/.local/bin/abler-mcp serve
claude mcp add infomentor -e INFOMENTOR_SESSION_PATH=/home/you/.config/infomentor-mcp/session.json -- /home/you/.local/bin/infomentor-mcp serve
```

### Codex

Add this to `~/.codex/config.toml` (or a trusted project's
`.codex/config.toml`):

```toml
[mcp_servers.abler]
command = "/home/you/.local/bin/abler-mcp"
args = ["serve"]

[mcp_servers.abler.env]
ABLER_SESSION_FILE = "/home/you/.config/abler-mcp/session.json"

[mcp_servers.infomentor]
command = "/home/you/.local/bin/infomentor-mcp"
args = ["serve"]

[mcp_servers.infomentor.env]
INFOMENTOR_SESSION_PATH = "/home/you/.config/infomentor-mcp/session.json"
```

## First login

Abler sign-in happens in Abler's own browser. Start a separate browser profile
with its debugging port bound to loopback, sign in normally, then capture or
import that host-local browser session:

```sh
abler-mcp auth capture http://127.0.0.1:9222
abler-mcp auth import /absolute/path/cookies.json
```

The saved session defaults to `~/.config/abler-mcp/session.json` (or
`$XDG_CONFIG_HOME/abler-mcp/session.json`). The detailed Abler README explains
the private browser profile and safe import process.

InfoMentor normally signs in on the MCP host with private credentials supplied
outside chat:

```sh
infomentor-mcp login
```

Its session defaults to `~/.config/infomentor-mcp/session.json` (or
`$XDG_CONFIG_HOME/infomentor-mcp/session.json`). The default MCP server has no
setup tools. Add `--allow-setup-tools` to `infomentor-mcp serve` only when you
intentionally want the server to expose its login, status, cancellation, and
logout tools; see the detailed InfoMentor README for the credential options.

## What the tools return

### Abler

| Tool                   | Data                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `auth_status`          | Authenticated account status without credentials               |
| `get_profile`          | Parent profile and linked children, including stable child IDs |
| `list_groups`          | Sports, age groups, and nested subgroups                       |
| `list_schedule`        | Paginated events, times, locations, and attendance records     |
| `list_child_schedules` | A separate paginated schedule for each linked child            |
| `get_event`            | One event from its schedule ID and age group                   |

### InfoMentor

| Tool                                                                                          | Data                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `infomentor_session_status`                                                                   | Saved-session authentication status                                  |
| `infomentor_get_overview`                                                                     | Children and the selected child's timetable                          |
| `infomentor_select_child`                                                                     | A fresh overview after changing the selected-child context           |
| `infomentor_get_messages` / `infomentor_get_message`                                          | Available message summaries or one full plain-text message           |
| `infomentor_get_notifications`                                                                | Available notification feed and upstream read state                  |
| `infomentor_collect_updates`                                                                  | All-child timetable, message, and notification changes with a cursor |
| `infomentor_login`, `infomentor_setup_status`, `infomentor_cancel_setup`, `infomentor_logout` | Setup operations, only with `--allow-setup-tools`                    |

## Security

Credentials and authentication secrets—including passwords, cookies, refresh
tokens, and private credential-file contents—are never returned as MCP tool
output. Keep session and credential files private to the host user.

Requested school and sports data is returned to the configured MCP host. That
can include child identities, schedules, messages, and notifications, so only
connect a host and its data-processing providers that you trust with that family
data. Both servers expose read paths; InfoMentor's explicitly opt-in setup tools
only manage the local session and do not edit school records.

## Development

Use Bun 1.4.2, which is pinned by the root `packageManager`:

```sh
bun install
bun run check
bun run test
bunx turbo run typecheck lint format:check test release:check --force
bunx turbo run test:binary test:installer --force
```

Tests use fixtures and loopback services; they must not contact live Abler or
InfoMentor services. Native checks build and exercise the standalone releases.

## Repository layout

- `packages/abler-mcp` — Abler executable and detailed setup reference.
- `packages/infomentor-mcp` — InfoMentor executable and detailed setup reference.
- `packages/mcp-runtime` — shared MCP response helpers.
- `packages/session-store` — private session storage and file locking.
- `tooling/release` — native archive, installer, and release checks.
- `docs/analysis` — review and phase reports.

## Releases

Releases use per-package tags such as `abler-mcp@0.3.1` and
`infomentor-mcp@0.5.0`. Before a maintainer tags a selected package version, run
its `release:sync` task to refresh its installer and documentation pins, then
run `release:check`. The release workflow validates the matching native assets
and creates a draft release; it does not publish a package to npm.
