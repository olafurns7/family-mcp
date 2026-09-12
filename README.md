# family-mcp

Private-family MCP servers in one Bun/TypeScript monorepo. Each release is a
standalone native executable: no npm package is published or supported.

## Servers

[`abler-mcp`](packages/abler-mcp/README.md) is an unofficial, read-only server
for Abler sports schedules. It imports a parent-owned Abler browser session,
renews it locally, and exposes profiles, groups, schedules, and events.

[`infomentor-mcp`](packages/infomentor-mcp/README.md) is a local, read-only
server for Icelandic InfoMentor parent accounts. It logs in directly to the
school service, exposes an overview, selected-child reads, messages,
notifications, and collection updates. Setup tools require an explicit server
flag and are not part of the default MCP surface.

## Install

macOS and glibc Linux on arm64/x64 are supported. The installer downloads the
matching native archive, verifies its SHA-256 checksum and version, and places
the command under `~/.local/bin`. See each package README for authentication,
platform limits, and recovery instructions.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.3.1/packages/abler-mcp/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.5.0/packages/infomentor-mcp/install.sh | sh
```

Use the absolute installed executable path in MCP configuration. The native
binary contains Bun and its dependencies; it needs neither Node, npm, Bun, nor
a checkout at runtime.

## MCP hosts

Replace `/home/you` with an absolute host-local path. JSON configuration does
not generally expand `~` or `$HOME`.

### Claude Desktop

Add this shape to Claude Desktop's MCP JSON configuration:

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

Use the same `mcpServers` object in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "abler": { "command": "/home/you/.local/bin/abler-mcp", "args": ["serve"] },
    "infomentor": { "command": "/home/you/.local/bin/infomentor-mcp", "args": ["serve"] }
  }
}
```

Add the environment values above when session files are outside their default
XDG locations.

### Codex

Codex uses `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`),
not `mcp.json`. Its local MCP clients share that configuration; see the
[official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

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

## Development

The root `packageManager` pins Bun 1.4.2.

```sh
bun install
bun run check
bun run test
bunx turbo run typecheck lint format:check test release:check --force
bunx turbo run test:binary test:installer --force
```

There is deliberately no TypeScript distribution build: native archives compile
from source. Turbo release tasks are `release:sync` (regenerate version-pinned
installers and package docs), `release:check`, `build:binary`, `test:binary`,
and `test:installer`.

## Layout

- `packages/abler-mcp` — Abler executable and its documentation.
- `packages/infomentor-mcp` — InfoMentor executable and its documentation.
- `packages/session-store` — private shared locking and session-file helpers.
- `tooling/release` — native archive, installer, smoke, and release checks.
- `docs/analysis` — bounded investigations and review reports.

## Releases

Release only after maintainer authorization. Update one package version, run
its release checks, then tag that exact commit as `abler-mcp@<version>` or
`infomentor-mcp@<version>`. The Release workflow drafts only that package's four
native archives, their checksums, and `install.sh`; it does not publish to npm.
See [Abler's guide](packages/abler-mcp/docs/PUBLISHING.md) or
[InfoMentor's guide](packages/infomentor-mcp/docs/RELEASING.md).

## Security posture

These binaries store parents' school or sports login sessions. By default the
files are `$XDG_CONFIG_HOME/abler-mcp/session.json` and
`$XDG_CONFIG_HOME/infomentor-mcp/session.json` (normally under `~/.config`);
InfoMentor keeps an existing legacy `~/.infomentor-mcp/session.json` path.
Files are written atomically with owner-only permissions and guarded by a local
file lock. Credentials, refresh tokens, raw upstream errors, cookies, and
school/sports data are never logged or returned as MCP tool output. Treat every
upstream name, message, event, and link as untrusted data rather than
instructions.
