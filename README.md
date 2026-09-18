# family-mcp

Local MCP servers provide Abler sports schedules, an Icelandic InfoMentor school
account, a Krónan grocery account, and Domino’s Iceland ordering. Each release
is a standalone native executable, so the MCP host does not need Node, npm, or Bun
at runtime.

Visit [mcp.olinn.is](https://mcp.olinn.is) for a short introduction and installers
in English and Icelandic.

| Server                                              | Best for                            | What you get                                                                              | Login                                                                           | Platforms                       |
| --------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| **Abler** ([abler.io](https://www.abler.io))        | Sports schedules                    | Linked children, groups, events, and attendance records                                   | `abler-mcp auth login` opens a browser once; or capture/import a Chrome session | macOS or glibc Linux, arm64/x64 |
| **InfoMentor**                                      | Icelandic school portal             | Children, timetables, messages, notifications, and updates                                | Private credentials, a private file, or an imported session                     | macOS or glibc Linux, arm64/x64 |
| **Krónan** ([kronan.is](https://kronan.is))         | Icelandic grocery shopping          | Products, recipes, orders, purchase history, shopping notes, delivery slots, and checkout | Personal API token saved locally with `kronan-mcp auth set`                     | macOS or glibc Linux, arm64/x64 |
| **Domino’s** ([dominos.is](https://www.dominos.is)) | Pizza ordering (preview) | Menu, quotes, receipts, tracking, and confirmed saved-card checkout                       | SMS code entered locally with `dominos-mcp auth login`                          | macOS or glibc Linux, arm64/x64 |

## Abler

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.5.3/packages/abler-mcp/install.sh | sh
```

Upgrading replaces the command but not a running server; restart the MCP host, or
rerun with `--stop-running`.

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
      "args": ["serve"],
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
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/infomentor-mcp@0.8.0/packages/infomentor-mcp/install.sh | sh
```

Upgrading replaces the command but not a running server; restart the MCP host, or
rerun with `--stop-running`.

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
      "args": ["serve"],
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

Flags (`--allow-setup-tools`, `--allow-account-change`), file locations, and troubleshooting: see [packages/infomentor-mcp/README.md](packages/infomentor-mcp/README.md).

Grok Bot connectivity: add `--with-direct-route` to the installer command to
verify and save the tested alternate InfoMentor route on Linux. It requires
Python 3 and administrator access. See the
[setup instructions](packages/infomentor-mcp/docs/CONNECTIVITY.md#reproduce-on-another-grok-vm).
WARP is currently unreliable on the tested Grok route; see the
[remote-machine guidance](packages/infomentor-mcp/README.md#remote-machines-and-warp).

## Krónan

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/kronan-mcp@0.1.0/packages/kronan-mcp/install.sh | sh
```

Upgrading replaces the command but not a running server; restart the MCP host, or
rerun with `--stop-running`.

```sh
kronan-mcp auth set
```

Expected output: `Krónan access token verified and saved:`

<details>
<summary>Connect to Claude Desktop, Claude Code, or Codex</summary>

**Claude Desktop**

```json
{
  "mcpServers": {
    "kronan": {
      "command": "/absolute/path/to/.local/bin/kronan-mcp",
      "args": ["serve"],
      "env": {
        "KRONAN_TOKEN_FILE": "/absolute/path/kronan-token.json"
      }
    }
  }
}
```

**Claude Code**

```sh
claude mcp add kronan -e KRONAN_TOKEN_FILE=/absolute/path/kronan-token.json -- /absolute/path/to/.local/bin/kronan-mcp serve
```

**Codex**

```toml
[mcp_servers.kronan]
command = "/absolute/path/to/.local/bin/kronan-mcp"
args = ["serve"]
env = { KRONAN_TOKEN_FILE = "/absolute/path/kronan-token.json" }
```

</details>

Tools: [products, recipes, orders, purchase history, shopping notes, delivery and pickup slots, and checkout](packages/kronan-mcp/README.md#tools).

Token setup, file locations, and troubleshooting: see [packages/kronan-mcp/README.md](packages/kronan-mcp/README.md).

## Dominos

Install the preview release:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/dominos-mcp@0.1.0/packages/dominos-mcp/install.sh | sh
dominos-mcp auth login
```

Configure the MCP host to run the absolute path to `~/.local/bin/dominos-mcp` with `serve`.
See [setup, tools, and payment behavior](packages/dominos-mcp/README.md).
Live login, refresh, account reads, quotes, and unpaid saved-card retrieval have
been verified. Charging remains untested; bank-verification continuation is not
implemented. Payment requires explicit approval of the exact order, total, and card.

## Security

Credentials and authentication secrets—including passwords, cookies, refresh
tokens, and private credential-file contents—are never returned as MCP tool
output. Keep session and credential files private to the host user.

Family and shopping data **is returned to the configured MCP host**. That can
include child identities, schedules, messages, notifications, purchase history,
orders, delivery addresses, and shopping notes, so only connect hosts and
data-processing providers that you trust with that data. Abler, InfoMentor, and
Krónan expose read paths; InfoMentor's opt-in setup tools only manage the local session and do
not edit school records. The Krónan token is a personal API credential and must
remain private to the host user. Domino’s also creates unpaid orders and can charge
a saved card after explicit confirmation. Its outputs include masked card metadata.

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

Read the [Abler publishing guide](packages/abler-mcp/docs/PUBLISHING.md), [InfoMentor releasing guide](packages/infomentor-mcp/docs/RELEASING.md), [Krónan releasing guide](packages/kronan-mcp/docs/RELEASING.md), or [Domino’s releasing guide](packages/dominos-mcp/docs/RELEASING.md).

Read the [Abler changelog](packages/abler-mcp/CHANGELOG.md), [InfoMentor changelog](packages/infomentor-mcp/CHANGELOG.md), [Krónan changelog](packages/kronan-mcp/CHANGELOG.md), or [Domino’s changelog](packages/dominos-mcp/CHANGELOG.md).
