# Inna MCP (preview)

An unofficial local MCP for Inna school accounts. It reads a student's
timetable, assignments/homework, assignment descriptions, course assessment,
attendance, material metadata, messages, announcements, and absence history.
Whole-day illness registration and leave applications are an explicit opt-in.
A guardian's session can read [several students](#several-students).

The current preview is `inna-mcp@0.4.0`. The read endpoints
were captured in a real guardian account. Electronic-ID login and private session
reuse were verified through the initial 0.1.0 compiled native CLI; the 0.1.1
parsing and repeated-read changes are checked offline. Absence creation is based
on the delivered Inna client and has not been submitted live. See the
[endpoint and login investigation](../../docs/analysis/inna-mcp-endpoints.md).

## Install

The native installer supports macOS and glibc Linux on arm64/x64, verifies the
release checksum, and installs `~/.local/bin/inna-mcp`. No Node, npm, or Bun is
needed at runtime.

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/inna-mcp@0.4.0/packages/inna-mcp/install.sh | sh
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
when additional device verification or new terms acceptance requires browser
interaction; it never accepts terms.

Several student contexts no longer stop login (this requires a release after
Inna 0.2.2). The first student context Inna lists becomes the default student;
when a session is already saved, its default student is chosen again, so a
fresh login does not change the default. With `--allow-account-change` the
first listed student becomes the new default. Reach the other students with
`inna_list_students` and `studentKey`. Login still stops when Inna lists no
accessible student context.

### Google

Sign in with a Google account already linked in Inna, on a machine with a
desktop and Google Chrome or Chromium:

```sh
inna-mcp auth login --google
inna-mcp auth status
```

A browser window opens on Inna's Google sign-in. Sign in there; when Inna's
student page appears, the CLI saves the session and closes the window. Nothing
is copied or pasted, and an agent running this command never asks for, reads,
or copies cookies or passwords. This requires a release after Inna 0.2.2. It is
checked offline against a fake browser and has not yet been run against Inna
and Google.

The window is a fresh temporary browser profile, mode `0700`, so it is not
signed in to Google and holds no saved passwords. The CLI talks to it only over
a private `--remote-debugging-pipe`; no debugging port is opened. It waits until
a tab shows `nam.inna.is/Components/Students/Students.html` and the school
session cookies exist, takes only the `SESSION`, `JSESSIONID`, and `XSRF-TOKEN`
cookies of `nam.inna.is`, confirms the browser is closed, removes the profile,
and only then verifies and saves the session. If closure cannot be confirmed,
login exits with an error, saves nothing, and still removes the profile. Each
login also removes abandoned `inna-login-*` profiles older than one hour.

`--timeout <seconds>` changes the five-minute wait for sign-in. `--browser
<path>` or `INNA_BROWSER` selects the browser executable when Chrome or Chromium
is not found by itself. If sign-in is not finished in time, including when
Google refuses to sign in in this window, nothing is saved; run the command
again, or use electronic ID. On Linux without `DISPLAY` or `WAYLAND_DISPLAY`
the command stops before opening anything; use electronic ID there, or the
cookie import below.

### Cookie import, for a machine without a desktop

Use this only when neither electronic ID nor `auth login --google` can run on
the machine. Sign in through [Inna](https://www.inna.is/) in a browser
elsewhere and export only the `nam.inna.is` cookies to an owner-only
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

Every login path verifies the account/student/school before saving. The student
selected at login or import becomes the session's default student. A later
login or import that lands on a different binding is refused unless the owner
deliberately adds `--allow-account-change`; when it lands on another student
already read through this session, select the default student in the Inna
browser session first. Replacing the default forgets the other learned students.
The normal session file is `~/.config/inna-mcp/session.json`, or an absolute
`INNA_SESSION_FILE` path. Shared private-file and lock helpers enforce owner-only
files and atomic replacement. No unattended login or renewal is implemented.
Expiry needs a fresh explicit login/import.

### Keeping the session alive

Inna issues browser session cookies that expire nightly. Starting with 0.4.0,
login also captures and securely stores the inna.is refresh token with
owner-only file permissions (in the same session.json file). While
`inna-mcp serve` runs, the server:

- Makes one small authenticated request every ten minutes to prevent idle timeout
- Refreshes the inna.is token when it's within six hours of expiry
- Automatically renews the nam.inna.is school session when it expires

When a school session expires, the server uses the saved token to:
1. Refresh the inna.is token via `POST https://inna.is/auth/refresh`
2. Mint a fresh nam.inna.is school session for the saved student
3. Verify the account/student/school remain unchanged

This allows unattended operation across days without requiring manual re-login
each morning. All renewal attempts are logged with timestamps but never log
token or cookie values. If renewal fails (for example, if the token itself has
expired after extended inactivity), the session degrades cleanly to "sign-in
required" and waits for a new explicit login.

**Security trade-off**: The inna.is refresh token is stored on disk with the
session cookies. Both are in owner-only mode 0600 files. The token grants the
ability to mint new school sessions for this guardian's account. An attacker
with filesystem access could use it to access school data until the token
expires. The token has no known absolute expiration documented by inna.is;
live verification during the first login after this update will decode only the
non-sensitive JWT claims (exp, iat, orig_iat) to learn the token lifetime.
Do not share the session.json file or grant filesystem access to untrusted users.

The keep-alive runs only while `serve` runs. Start the server with
`inna-mcp serve --no-keep-alive` to turn it off (this also disables automatic
renewal). A host that starts the server per conversation leaves the session
idle between conversations; there, schedule `inna-mcp auth status` (for example
from cron) for the same effect. Unlike the keep-alive, `auth status` verifies
the default student and switches Inna's selected student back to it when a
browser or another call left it elsewhere.

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

| Tool                     | Inputs / behavior                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `inna_session_status`    | Verify authentication; returns no credentials.                                                                                  |
| `inna_list_students`     | Students in this session with their `studentKey`, the selected one, and the default. Does not switch.                           |
| `inna_get_overview`      | Current context, terms, courses/booklists, announcements.                                                                       |
| `inna_get_timetable`     | Inclusive `dateFrom`, `dateTo` in `YYYY-MM-DD`.                                                                                 |
| `inna_get_assignments`   | `type`: `all` (default), `assignments`, or `exams`; current dashboard filters, plus homework.                                   |
| `inna_get_assignment`    | `assignmentId` from the list; description and due date.                                                                         |
| `inna_get_grades`        | Optional `termId`; missing marks are unavailable. Historical final-grade variants remain unverified.                            |
| `inna_get_course_grades` | `groupId` from overview; assignment marks/comments.                                                                             |
| `inna_get_attendance`    | Optional `termId`; original codes/totals/percentages.                                                                           |
| `inna_get_materials`     | `groupId`; metadata and links. Does not fetch files or external links.                                                          |
| `inna_get_messages`      | `rowFrom` default 1; `rowTo` default `rowFrom + 20`, maximum 100 rows beyond the start. Continue with `nextRowFrom` until null. |
| `inna_get_message`       | `messageId` and `type` from list's `messagesId` and `table`; plain text, without mark-read.                                     |
| `inna_get_absences`      | Inclusive date range; illness options, registered illness, and leave history.                                                   |
| `inna_absence_status`    | Last private absence operation of any student, including uncertain outcomes. Does not switch; no `studentKey`.                  |
| `inna_prepare_absence`   | Opt-in: `kind` (`sick`/`leave`), date range, reason. Whole days; one sick day per preview.                                      |
| `inna_submit_absence`    | Opt-in: approved `operationId` and `confirm: true`. Selects the preview's student; no `studentKey`.                             |

Every other tool also accepts an optional `studentKey` from `inna_list_students`;
omitting it reads the default student.

Each school read returns the verified account/student/school context. Availability
and permission follow Inna. A shared message visible in that context is not proof
that the student is its recipient. HTML body/description fields are returned as
plain text; school text and links remain untrusted source material. Unexpected
shapes fail safely rather than becoming an empty feed.

The 0.1.1 hardening extends the initial 0.1.0 preview.
Each successful authenticated result includes `retrievedAt` as an ISO UTC
timestamp and `timeZone: "UTC"`. Reads verify the account/student/school again
before returning. School date fields keep their original values and add a
`dates` map with `iso` and `status` (`parsed`, `missing`, or `unrecognized`).
For example, `dates.start.iso` normalizes `2040-01-02T10:00:00` to
`2040-01-02T10:00:00.000Z`. Icelandic `dd.MM.yyyy` and ISO date-only values
remain `YYYY-MM-DD`; epoch dates use milliseconds, matching Inna's date model.
Missing and invalid dates return null with the corresponding status. Never
guess them or apply the agent host's timezone. Entry end dates retain Inna's
semantics; an all-day event's end must not be changed to an inclusive end.

For frequent timetable and inbox checks, call sequentially. Every call fetches
fresh data, and shared session locking serializes concurrent callers on this
machine. Message continuation uses the number of rows delivered, rather than
assuming Inna returned the requested page size. Row positions are not stable
cursors: new inbox arrivals can move rows between calls. Deduplicate by
`table` plus `messagesId`, and restart a scan if counts or page membership change.
Failed, empty nonterminal, or inconsistent pages are errors. Rate-limit pauses
honor numeric and HTTP-date `Retry-After` headers, survive process restarts,
and have a minimum of one minute. Avoid tight retry loops and unattended login
attempts. There is no background polling schedule or inferred deletion feed.

### Several students

One saved session covers every student Inna lists for the signed-in guardian.
Call `inna_list_students`, then pass a returned `studentKey` to the read tools
or to `inna_prepare_absence`. Without `studentKey` a tool reads the default
student: the one selected at `auth login` or `auth import`.

Inna keeps a single selected student per session, so the server switches it
when a call asks for another student and switches back on the next call for
the default. Before reading, it requires that Inna reports exactly the
requested student as selected and that the returned user and school match that
entry. The first verified read of a student records its account/student/school
binding in the private session file; later reads must return the same binding,
and two keys can never share a student. The context is checked again after the
read, and any mismatch discards the result. Always identify the returned
`context` before describing records.

Poll students sequentially. A switch also changes what an open Inna browser
session using the same cookies shows, and a switch made in that browser is
corrected on the next call. `inna_list_students` returns the student names Inna
lists; treat them as untrusted school text. Identity numbers and Inna's
access links are never read, stored, or returned.

Because a call can change Inna's selected student, every tool that accepts
`studentKey` is annotated as not read-only. It still changes no school record.
Only `inna_list_students` and `inna_absence_status` are annotated read-only.

A user confirmed switching between two students on a real account on
2026-10-03: the list returned two keys, and an overview read succeeded for the
default student and the sibling, at different schools. The switch request comes
from Inna's delivered student application and one two-student user's capture;
the tests use synthetic responses.

### Whole-day illness and leave

```sh
/absolute/path/inna-mcp serve --allow-absence-writes
```

Prepare the exact student, school, kind, dates, and reason. Show the returned
preview and get explicit human approval to transmit these details to the school
through Inna. Only then submit its `operationId` with `confirm: true`; this flag
represents MCP-host consent, not a separate authentication mechanism.

The preview records its student. Submission takes no `studentKey`: it selects
that student itself and refuses if Inna's selection changes during its checks.
`inna_absence_status` reports the operation whichever student is selected.

The preview expires after ten minutes. Submission rechecks account context,
permissions, and overlapping records. A returned ID means the request was
submitted, not that the school approved leave. Partial-day requests, cancellation,
messages, assignment submission, and grade editing are unsupported.

The private `session.json.absence.json` marker is persisted before a write.
`submitting` or `unknown` means the outcome needs owner review against Inna's
history. The server refuses replay and new previews, for every student, while
that state remains.
Logout retains the marker; do not delete or change it merely to retry. Existing
overlapping records are conservatively refused without interpreting undocumented
status codes.
Sick history is checked for both illness and leave requests. Unrecognized
history dates, a changed UTC day, or expiry during final checks stop submission.
The stored preview's `expiresAt` is epoch milliseconds.

## Development

```sh
bun run --cwd packages/inna-mcp test
bun run --cwd packages/inna-mcp check
bun run --cwd packages/inna-mcp test:binary
bun run --cwd packages/inna-mcp test:installer
```

Tests use synthetic responses only. A separately authorized live native check
verified phone login, private session reuse, and the 13 read/status tools of
0.1.1 using an isolated temporary session. A user confirmed switching between
two students on a real account on 2026-10-03. Real absence submission, a
measurement of whether the keep-alive extends a session, and persistent
registration in an MCP host have not been performed.

See the [release process](docs/RELEASING.md) for packaging and publication gates.
