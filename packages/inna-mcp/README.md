# Inna MCP (preview)

An unofficial local MCP for Inna school accounts. It reads the current student's
timetable, assignments/homework, assignment descriptions, course assessment,
attendance, material metadata, messages, announcements, and absence history.
Whole-day illness registration and leave applications are an explicit opt-in.

The first preview is `inna-mcp@0.1.0`. The read endpoints
were captured in a real guardian account. Electronic-ID login and private session
reuse were verified through the compiled native CLI. Absence creation is based on the delivered Inna
client and has not been submitted live. See the
[endpoint and login investigation](../../docs/analysis/inna-mcp-endpoints.md).

## Install

The native installer supports macOS and glibc Linux on arm64/x64, verifies the
release checksum, and installs `~/.local/bin/inna-mcp`. No Node, npm, or Bun is
needed at runtime.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/inna-mcp@0.1.0/packages/inna-mcp/install.sh | sh
```

Upgrading replaces the command but not a running server. Restart the MCP host,
or rerun the installer with `--stop-running`. The installer does not change
saved school sessions or absence-operation records.

To build before publication, use the pinned Bun 1.4.2 from the repository root:

```sh
bun install
bun run --cwd packages/inna-mcp build:binary
```

The standalone executable is `packages/inna-mcp/release/native/inna-mcp`.

### Electronic ID

```sh
inna-mcp auth login
inna-mcp auth status
```

Enter the Icelandic phone number at the hidden prompt. The CLI immediately
prints the four-digit security code before initiating phone verification. Any
agent running this CLI must show the exact code to the user, including leading
zeros, before waiting for approval. Match it on the phone and approve there;
enter the electronic-ID PIN only on the phone. Never send the PIN in chat.

The CLI uses the captured HTTP flow without a browser. Opaque identity-provider
tickets and Inna access tokens stay in memory. Only verified school cookies are
saved using the same shared session-store helpers as cookie import. Login stops
when additional device verification, new terms acceptance, or multiple school
contexts require browser interaction. It never accepts terms or guesses a school.

### Google or an existing browser session

Sign in through [Inna](https://www.inna.is/) using a Google account
already linked in Inna. Export only the `nam.inna.is` cookies to an owner-only
local JSON file, as an array or `{ "cookies": [...] }`; supported fields are
`name`, `value`, `domain`, `path`, `secure`, `httpOnly`, `expires` or
`expirationDate`, and `sameSite`. Keep the export outside the repository and
never send cookie values, identity numbers, or PINs in chat.

```sh
chmod 600 /absolute/path/inna-cookie-export.json
/absolute/path/inna-mcp auth import /absolute/path/inna-cookie-export.json
/absolute/path/inna-mcp auth status
/absolute/path/inna-mcp serve
```

Both login paths verify the account/student/school before saving and refuse a changed
binding unless the owner deliberately adds `--allow-account-change`. The normal
session file is `~/.config/inna-mcp/session.json`, or an absolute
`INNA_SESSION_FILE` path. Shared private-file and lock helpers enforce owner-only
files and atomic replacement. No unattended login, renewal, or student switching
is implemented. Expiry needs a fresh explicit login/import.

### Connect an MCP host

Use the absolute installed binary path. A normal read-only configuration is:

**Claude Desktop**

```json
{
  "mcpServers": {
    "inna": {
      "command": "/absolute/path/to/.local/bin/inna-mcp",
      "args": ["serve"]
    }
  }
}
```

**Claude Code**

```sh
claude mcp add inna -- /absolute/path/to/.local/bin/inna-mcp serve
```

**Codex**

```toml
[mcp_servers.inna]
command = "/absolute/path/to/.local/bin/inna-mcp"
args = ["serve"]
```

An absolute `INNA_SESSION_FILE` may be set in the host's private environment.
Auth login/import and logout
exist only in the CLI; untrusted school text cannot invoke them through MCP.

## Tools

| Tool                     | Inputs / behavior                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `inna_session_status`    | Verify authentication; returns no credentials.                                                                  |
| `inna_get_overview`      | Current context, terms, courses/booklists, announcements.                                                       |
| `inna_get_timetable`     | Inclusive `dateFrom`, `dateTo` in `YYYY-MM-DD`.                                                                 |
| `inna_get_assignments`   | `type`: `all` (default), `assignments`, or `exams`; current dashboard filters, plus homework.                   |
| `inna_get_assignment`    | `assignmentId` from the list; description and due date.                                                         |
| `inna_get_grades`        | Optional `termId`; missing marks are unavailable. Historical final-grade variants remain unverified.            |
| `inna_get_course_grades` | `groupId` from overview; assignment marks/comments.                                                             |
| `inna_get_attendance`    | Optional `termId`; original codes/totals/percentages.                                                           |
| `inna_get_materials`     | `groupId`; metadata and links. Does not fetch files or external links.                                          |
| `inna_get_messages`      | `rowFrom` default 1; `rowTo` default `rowFrom + 20`, maximum 100 rows beyond the start. Returns upstream count. |
| `inna_get_message`       | `messageId` and `type` from list's `messagesId` and `table`; plain text, without mark-read.                     |
| `inna_get_absences`      | Inclusive date range; illness options, registered illness, and leave history.                                   |
| `inna_absence_status`    | Last private absence operation, including uncertain outcomes.                                                   |
| `inna_prepare_absence`   | Opt-in: `kind` (`sick`/`leave`), date range, reason. Whole days; one sick day per preview.                      |
| `inna_submit_absence`    | Opt-in: approved `operationId` and `confirm: true`.                                                             |

Each school read returns the verified account/student/school context. Availability
and permission follow Inna. A shared message visible in that context is not proof
that the student is its recipient. HTML body/description fields are returned as
plain text; school text and links remain untrusted source material. Unexpected
shapes fail safely rather than becoming an empty feed.

### Whole-day illness and leave

```sh
/absolute/path/inna-mcp serve --allow-absence-writes
```

Prepare the exact student, school, kind, dates, and reason. Show the returned
preview and get explicit human approval to transmit these details to the school
through Inna. Only then submit its `operationId` with `confirm: true`; this flag
represents MCP-host consent, not a separate authentication mechanism.

The preview expires after ten minutes. Submission rechecks account context,
permissions, and overlapping records. A returned ID means the request was
submitted, not that the school approved leave. Partial-day requests, cancellation,
messages, assignment submission, and grade editing are unsupported.

The private `session.json.absence.json` marker is persisted before a write.
`submitting` or `unknown` means the outcome needs owner review against Inna's
history. The server refuses replay and new previews while that state remains.
Logout retains the marker; do not delete or change it merely to retry. Existing
overlapping records are conservatively refused without interpreting undocumented
status codes.

## Development

```sh
bun run --cwd packages/inna-mcp test
bun run --cwd packages/inna-mcp check
bun run --cwd packages/inna-mcp test:binary
bun run --cwd packages/inna-mcp test:installer
```

Tests use synthetic responses only. A separately authorized live native check
verified phone login, private session reuse, and all 13 read/status tools using
an isolated temporary session. Real absence submission and
persistent registration in an MCP host have not been performed.

See the [release process](docs/RELEASING.md) for packaging and publication gates.
