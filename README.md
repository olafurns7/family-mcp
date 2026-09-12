# family-mcp

Two local MCP servers give a parent read-only access to Abler sports schedules
and an Icelandic InfoMentor school account. Each release is a standalone native
executable, so the MCP host does not need Node, npm, or Bun at runtime.

| Server | Best for | What you get | Login | Platforms |
| --- | --- | --- | --- | --- |
| **Abler** ([abler.io](https://www.abler.io)) | Sports schedules | Linked children, groups, events, and attendance records | `abler-mcp auth login` opens a browser once; or capture/import a Chrome session | macOS or glibc Linux, arm64/x64 |
| **InfoMentor** | Icelandic school portal | Children, timetables, messages, notifications, and updates | Private credentials, a private file, or an imported session | macOS or glibc Linux, arm64/x64 |

## Abler

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.4.0/packages/abler-mcp/install.sh | sh
```
```sh
abler-mcp auth login
```
Expected output: `Sign in to Abler in the browser window that opened.`
<details>
<summary>Connect to Claude Desktop, Claude Code, or Codex</summary>

**Claude Desktop**

```json
{
  "mcpServers": {
    "abler": {
      "command": "/absolute/path/to/.local/bin/abler-mcp",
      "args": [
        "serve"
      ],
      "env": {
        "ABLER_SESSION_FILE": "/absolute/path/abler-session.json"
      }
    }
  }
}
```

**Claude Code**

```sh
claude mcp add abler -e ABLER_SESSION_FILE=/absolute/path/abler-session.json -- /absolute/path/to/.local/bin/abler-mcp serve
```

**Codex**

```toml
[mcp_servers.abler]
command = "/absolute/path/to/.local/bin/abler-mcp"
args = ["serve"]
env = { ABLER_SESSION_FILE = "/absolute/path/abler-session.json" }
```

</details>

Tools: [account status, profile, groups, schedules, and events](packages/abler-mcp/README.md#tools).

Other sign-in paths (capture an existing Chrome session, import cookies), headless servers, file locations, troubleshooting: see [packages/abler-mcp/README.md](packages/abler-mcp/README.md).

## InfoMentor

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh
```
```sh
infomentor-mcp login --credentials /absolute/path/credentials.json
```
Expected output starts with `Signed in. Session saved to`.
<details>
<summary>Connect to Claude Desktop, Claude Code, or Codex</summary>

**Claude Desktop**

```json
{
  "mcpServers": {
    "infomentor": {
      "command": "/absolute/path/to/.local/bin/infomentor-mcp",
      "args": [
        "serve"
      ],
      "env": {
        "INFOMENTOR_SESSION_PATH": "/absolute/path/infomentor-session.json",
        "INFOMENTOR_CREDENTIALS_FILE": "/absolute/path/credentials.json"
      }
    }
  }
}
```

**Claude Code**

```sh
claude mcp add infomentor -e INFOMENTOR_SESSION_PATH=/absolute/path/infomentor-session.json -e INFOMENTOR_CREDENTIALS_FILE=/absolute/path/credentials.json -- /absolute/path/to/.local/bin/infomentor-mcp serve
```

**Codex**

```toml
[mcp_servers.infomentor]
command = "/absolute/path/to/.local/bin/infomentor-mcp"
args = ["serve"]
env = { INFOMENTOR_SESSION_PATH = "/absolute/path/infomentor-session.json", INFOMENTOR_CREDENTIALS_FILE = "/absolute/path/credentials.json" }
```

</details>

Tools: [session, children, timetables, messages, notifications, and scheduled updates](packages/infomentor-mcp/README.md#mcp-tools).

Flags (`--allow-setup-tools`, `--allow-account-change`, `--local-form`), file locations, and troubleshooting: see [packages/infomentor-mcp/README.md](packages/infomentor-mcp/README.md).

Remote machines (VPS, Grok bot VM): if the host's network path to `infomentor.is` fails before HTTP, use the WARP installer variant, Debian 13 x64 only:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.6.0/packages/infomentor-mcp/install.sh | sh -s -- --with-warp
```

Read the [WARP guidance](packages/infomentor-mcp/README.md#remote-machines-and-warp) and [connectivity guide](packages/infomentor-mcp/docs/CONNECTIVITY.md) first.

## Security

Credentials and authentication secrets—including passwords, cookies, refresh
tokens, and private credential-file contents—are never returned as MCP tool
output. Keep session and credential files private to the host user.

Family data **is returned to the configured MCP host**. That can include child
identities, schedules, messages, and notifications, so only connect hosts and
data-processing providers that you trust with that data. Both servers expose
read paths; InfoMentor's opt-in setup tools only manage the local session and do
not edit school records.

## For agents and contributors

Using these servers from an agent? Each section above is self-contained; tool schemas are strict and documented in the package READMEs.

Working on this repo with a coding agent? Read [docs/AGENTS.md](docs/AGENTS.md) and [CLAUDE.md](CLAUDE.md).

## Development

```sh
bun install
bun run check
bun run test
```

See [CLAUDE.md](CLAUDE.md) for the full gate.

## Releases

Read the [Abler publishing guide](packages/abler-mcp/docs/PUBLISHING.md) or [InfoMentor releasing guide](packages/infomentor-mcp/docs/RELEASING.md).

Read the [Abler changelog](packages/abler-mcp/CHANGELOG.md) or [InfoMentor changelog](packages/infomentor-mcp/CHANGELOG.md).
