# family-mcp

Two local MCP servers give a parent read-only access to Abler sports schedules
and an Icelandic InfoMentor school account. Each release is a standalone native
executable, so the MCP host does not need Node, npm, or Bun at runtime.

| Server | Best for | What you get | Login | Platforms |
| --- | --- | --- | --- | --- |
| **Abler** ([abler.io](https://www.abler.io)) | Sports schedules | Linked children, groups, events, and attendance records | Sign in in Chrome once, then capture or import its Abler session | macOS or glibc Linux, arm64/x64 |
| **InfoMentor** | Icelandic school portal | Children, timetables, messages, notifications, and updates | Private credentials, a private file, or an imported session | macOS or glibc Linux, arm64/x64 |

Paths written as `/absolute/path/...` are absolute paths on the computer that
runs the MCP host. Configuration files do not reliably expand `~` or `$HOME`.

## Quick start for agents

### Abler

1. **Install.**

   ```sh
   curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.4.0/packages/abler-mcp/install.sh | sh
   ```

2. **Verify the installed version.**

   ```sh
   /absolute/path/to/.local/bin/abler-mcp --version
   ```

   Expected output:

   ```text
   0.4.0
   ```

3. **Sign in on a computer with Chrome, then capture its loopback-only profile.**

   ```sh
   /absolute/path/to/.local/bin/abler-mcp auth capture http://127.0.0.1:9222
   ```

   Expected output starts with `Abler session saved and verified:`.

4. **Configure one MCP host** with the Abler-only Claude Desktop, Claude Code, or Codex block in [Abler MCP](#abler-mcp).

5. **Call `auth_status` with `{}`.** Expected result: authenticated account status and no credentials.

### InfoMentor

1. **Install.**

   ```sh
   curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh
   ```

2. **Verify the installed version.**

   ```sh
   /absolute/path/to/.local/bin/infomentor-mcp --version
   ```

   Expected output:

   ```text
   0.6.0
   ```

3. **Sign in with privately supplied credentials.**

   ```sh
   /absolute/path/to/.local/bin/infomentor-mcp login --credentials /absolute/path/credentials.json
   ```

   Expected output starts with `Signed in. Session saved to`.

4. **Configure one MCP host** with the InfoMentor-only Claude Desktop, Claude Code, or Codex block in [InfoMentor MCP](#infomentor-mcp).

5. **Call `infomentor_session_status` with `{}`.** Expected result: an active saved session and no credentials.

## Abler MCP

### Install

**Install the current release.**

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.4.0/packages/abler-mcp/install.sh | sh
```

The installer verifies the archive checksum and executable version, then installs
`abler-mcp` under `~/.local/bin`. Set `ABLER_PREFIX` to an absolute installation
prefix or `ABLER_VERSION` to a released version before running the installer.

**Upgrade.** The session file stays in place.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.4.0/packages/abler-mcp/install.sh | sh
```

**Uninstall** the command and release directories; this keeps the session file
so a later reinstall can reuse it.

```sh
rm -f /absolute/path/to/.local/bin/abler-mcp
```

```sh
rm -rf /absolute/path/to/.local/share/abler-mcp
```

### Sign in

**Start a separate Chrome profile with loopback debugging.** Sign in normally
at Abler and leave the signed-in tab open.

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/absolute/path/abler-chrome-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 https://www.abler.io/sign-on/login
```

On Linux, use the Chrome or Chromium executable with the same flags.

**Capture the signed-in browser session.**

```sh
/absolute/path/to/.local/bin/abler-mcp auth capture http://127.0.0.1:9222
```

**Or import a private browser cookie export.**

```sh
/absolute/path/to/.local/bin/abler-mcp auth import /absolute/path/cookies.json
```

The default session is `$XDG_CONFIG_HOME/abler-mcp/session.json`, normally
`~/.config/abler-mcp/session.json`. To run on a headless server, securely copy
that file to the server and set `ABLER_SESSION_FILE` to its absolute path there.

### Connect to your MCP host

**Claude Desktop** — add only this Abler entry to its MCP JSON configuration.

```json
{
  "mcpServers": {
    "abler": {
      "command": "/absolute/path/to/.local/bin/abler-mcp",
      "args": ["serve"],
      "env": {
        "ABLER_SESSION_FILE": "/absolute/path/abler-session.json"
      }
    }
  }
}
```

**Claude Code** — run this in the project where Claude Code should use Abler.

```sh
claude mcp add abler -e ABLER_SESSION_FILE=/absolute/path/abler-session.json -- /absolute/path/to/.local/bin/abler-mcp serve
```

**Codex** — add only this Abler entry to `/absolute/path/to/.codex/config.toml`.

```toml
[mcp_servers.abler]
command = "/absolute/path/to/.local/bin/abler-mcp"
args = ["serve"]

[mcp_servers.abler.env]
ABLER_SESSION_FILE = "/absolute/path/abler-session.json"
```

### Tools

| Tool | Returns |
| --- | --- |
| `auth_status` | Authenticated account status without credentials |
| `get_profile` | Parent profile, linked children, and stable child IDs |
| `list_groups` | Sports, age groups, and nested subgroups |
| `list_schedule` | Paginated events, times, locations, and attendance records |
| `list_child_schedules` | A separate paginated schedule for each linked child |
| `get_event` | One event from its schedule ID and age group |

### Where files live

`ABLER_SESSION_FILE` overrides the session location. Otherwise the server uses
`$XDG_CONFIG_HOME/abler-mcp/session.json`, or
`~/.config/abler-mcp/session.json` when `XDG_CONFIG_HOME` is unset.

### Troubleshooting

Use the package [troubleshooting guide](packages/abler-mcp/README.md#troubleshooting)
for unsafe session permissions, failed imports, busy sessions, and Chrome
capture failures.

## InfoMentor MCP

### Install

**Install the current release on your own laptop or desktop.**

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh
```

The installer verifies the archive checksum and executable version, then installs
`infomentor-mcp` under `~/.local/bin`. Set `INFOMENTOR_PREFIX` to an absolute
installation prefix or `INFOMENTOR_VERSION` to a released version before running
the installer.

**Upgrade.** The session file stays in place.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh
```

**Uninstall** with:

```sh
rm -f /absolute/path/to/.local/bin/infomentor-mcp
```

```sh
rm -rf /absolute/path/to/.local/share/infomentor-mcp
```

This keeps the session file.

### Remote machines and WARP

Use the standard install on your own laptop or desktop. Use `--with-warp` **only**
on a remote Debian 13 x64 machine, such as a VPS or the Grok bot VM, when its
network path to `infomentor.is` fails before HTTP.

**Install WARP mode.**

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh -s -- --with-warp
```

It requires administrator or `sudo` access and acceptance of
[Cloudflare's terms](https://www.cloudflare.com/application/terms/). It sets up
Cloudflare WARP in local-proxy mode, and only this MCP command uses that proxy.
It does not change the default route or Tailscale settings.

**Revert to direct access.**

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh -s -- --without-warp
```

**Do not use WARP** on a normal working connection, on a non-Debian-13-x64
machine, or as a workaround for credentials or a failed login. Read the
[connectivity guide](packages/infomentor-mcp/docs/CONNECTIVITY.md) before using
it on a remote host.

### Sign in

**Run normal login on the MCP host** after its private secret input has injected
`INFOMENTOR_USERNAME` and `INFOMENTOR_PASSWORD`.

```sh
/absolute/path/to/.local/bin/infomentor-mcp login
```

**Or use a private credentials file.** It must contain a `username` and
`password`, be owned by the MCP-host user, have mode `0600`, and not be a
symlink.

```sh
/absolute/path/to/.local/bin/infomentor-mcp login --credentials /absolute/path/credentials.json
```

**Import a session on a headless host** only from a private host-local file.

```sh
/absolute/path/to/.local/bin/infomentor-mcp login --import /absolute/path/session.json
```

| Flag | Use it when | Effect |
| --- | --- | --- |
| `--local-form` | A user explicitly wants same-computer browser login | Opens a private loopback form; never use it on a remote VM |
| `--allow-account-change` | The user explicitly wants to replace a different saved account | Allows login or import to replace that account's session |
| `--allow-setup-tools` | The MCP host must expose setup operations to an agent | Adds login, setup status, cancellation, and logout tools to `serve` |

The setup tools are absent by default. Do not expose `--allow-setup-tools` or
use `--allow-account-change` without that explicit user request.

### Connect to your MCP host

**Claude Desktop** — add only this InfoMentor entry to its MCP JSON configuration.

```json
{
  "mcpServers": {
    "infomentor": {
      "command": "/absolute/path/to/.local/bin/infomentor-mcp",
      "args": ["serve"],
      "env": {
        "INFOMENTOR_SESSION_PATH": "/absolute/path/infomentor-session.json",
        "INFOMENTOR_CREDENTIALS_FILE": "/absolute/path/credentials.json"
      }
    }
  }
}
```

**Claude Code** — run this in the project where Claude Code should use InfoMentor.

```sh
claude mcp add infomentor -e INFOMENTOR_SESSION_PATH=/absolute/path/infomentor-session.json -e INFOMENTOR_CREDENTIALS_FILE=/absolute/path/credentials.json -- /absolute/path/to/.local/bin/infomentor-mcp serve
```

**Codex** — add only this InfoMentor entry to `/absolute/path/to/.codex/config.toml`.

```toml
[mcp_servers.infomentor]
command = "/absolute/path/to/.local/bin/infomentor-mcp"
args = ["serve"]

[mcp_servers.infomentor.env]
INFOMENTOR_SESSION_PATH = "/absolute/path/infomentor-session.json"
INFOMENTOR_CREDENTIALS_FILE = "/absolute/path/credentials.json"
```

To expose the opt-in setup tools, append `--allow-setup-tools` to the configured
`serve` arguments.

### Tools

| Tool | Returns |
| --- | --- |
| `infomentor_session_status` | Saved-session authentication status |
| `infomentor_get_overview` | Children and the selected child's timetable |
| `infomentor_select_child` | A fresh overview after selecting `<child-id>` |
| `infomentor_get_messages` / `infomentor_get_message` | Available message summaries or one full plain-text message |
| `infomentor_get_notifications` | Available notification feed and upstream read state |
| `infomentor_collect_updates` | All-child timetable, message, and notification changes with a cursor |
| `infomentor_login`, `infomentor_setup_status`, `infomentor_cancel_setup`, `infomentor_logout` | Setup operations, only with `--allow-setup-tools` |

`<child-id>` is the stable ID returned by `infomentor_get_overview`; it is not a
child's name or list position.

### Where files live

`INFOMENTOR_SESSION_PATH` overrides the session location. Otherwise the server
uses `$XDG_CONFIG_HOME/infomentor-mcp/session.json`, normally
`~/.config/infomentor-mcp/session.json`. If the legacy
`~/.infomentor-mcp/session.json` already exists, it continues to be used.

### Troubleshooting

Use the package [README](packages/infomentor-mcp/README.md) for private-file
requirements, login recovery, session locking, collection cursors, and detailed
compatibility limits.

## Security

Credentials and authentication secrets—including passwords, cookies, refresh
tokens, and private credential-file contents—are never returned as MCP tool
output. Keep session and credential files private to the host user.

Family data **is returned to the configured MCP host**. That can include child
identities, schedules, messages, and notifications, so only connect hosts and
data-processing providers that you trust with that data. Both servers expose
read paths; InfoMentor's opt-in setup tools only manage the local session and do
not edit school records.

## Development

Use Bun 1.4.2, pinned by the root `packageManager`.

```sh
bun install
```

```sh
bun run check
```

```sh
bun run test
```

```sh
bunx turbo run typecheck lint format:check test release:check --force
```

```sh
bunx turbo run test:binary test:installer --force
```

Tests use fixtures and loopback services. They must not contact live Abler or
InfoMentor services. Native checks build and exercise standalone releases.

## Repository layout

- `packages/abler-mcp` — Abler executable and detailed setup reference.
- `packages/infomentor-mcp` — InfoMentor executable and detailed setup reference.
- `packages/mcp-runtime` — shared MCP response helpers.
- `packages/session-store` — private session storage and file locking.
- `tooling/release` — native archive, installer, and release checks.
- `docs/analysis` — review and phase reports.

## Releases

Releases use per-package tags: `abler-mcp@0.4.0` and `infomentor-mcp@0.6.0`.
Read the [Abler changelog](packages/abler-mcp/CHANGELOG.md) or
[InfoMentor changelog](packages/infomentor-mcp/CHANGELOG.md) for the selected
package.

1. **Update only the selected package's version and changelog.**
2. **Synchronize release pins and the installer.**

   ```sh
   bun run release:sync
   ```

3. **Run the selected package's release check.**

   ```sh
   bunx turbo run release:check --filter=abler-mcp --force
   ```

   Replace `abler-mcp` with `infomentor-mcp` for an InfoMentor release.

4. **Build and test the selected native release.**

   ```sh
   bunx turbo run test:binary test:installer --filter=abler-mcp --force
   ```

   Replace `abler-mcp` with `infomentor-mcp` for an InfoMentor release.

5. **Have a maintainer create the matching package tag and draft release.** The
   workflow validates matching native assets; it does not publish an npm package.
