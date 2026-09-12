# abler-mcp

Unofficial, read-only [Abler](https://www.abler.io) MCP server. Written in TypeScript and compiled with Bun into a single executable, including its runtime and dependencies. The running MCP server uses HTTP and needs no browser.

## Install the prebuilt release

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.3.1/packages/abler-mcp/install.sh | sh
```

No runtime, checkout, build step, sudo, or browser download is needed.
The installer selects your operating system and CPU, downloads the standalone
release, verifies its SHA-256 checksum and executable version, then installs
`~/.local/bin/abler-mcp`. Existing installations are replaced only after validation.
Temporary downloads are removed. The command is a symlink into
`~/.local/share/abler-mcp/<version>-<checksum>/bin/`; license notices are stored
in that versioned directory. Previous version directories are retained.
Set `ABLER_VERSION` to select another released package version.

Supported downloads: macOS arm64 (Apple Silicon) and x64 (Intel), and Linux
arm64 and x64 with glibc. Alpine/musl and Windows standalone binaries are not
provided. The executable includes its Bun runtime and dependencies.
See [release assets and checksums](https://github.com/olafurns7/family-mcp/releases/tag/abler-mcp@0.3.1).

Then run `"$HOME/.local/bin/abler-mcp" --version`. Add `$HOME/.local/bin` to your
PATH to use `abler-mcp` directly. Use the full executable path printed by the
installer in your MCP configuration. The installer leaves shell settings and
Abler sessions alone.

To choose another installation directory, pass an absolute `ABLER_PREFIX` to
`sh`, for example `curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/abler-mcp@0.3.1/packages/abler-mcp/install.sh | ABLER_PREFIX="/absolute/path" sh`.

For agent setup and reporting rules, read **[docs/AGENTS.md](docs/AGENTS.md)**.

Configure an MCP host to launch the installed server, replacing both paths with real absolute paths:

```json
{
  "mcpServers": {
    "abler": {
      "command": "/home/you/.local/bin/abler-mcp",
      "args": ["serve"],
      "env": {
        "ABLER_SESSION_FILE": "/home/you/.config/abler-mcp/session.json"
      }
    }
  }
}
```

On macOS, home paths normally start `/Users/you`. JSON configurations generally do not expand `~` or `$HOME`. The standalone executable needs no JavaScript runtime on the MCP host's PATH.

Omit `ABLER_SESSION_FILE` to use `$XDG_CONFIG_HOME/abler-mcp/session.json`, defaulting to `~/.config/abler-mcp/session.json`. Stdout is reserved for the MCP protocol. Auth commands print human-readable output separately from server mode.

## Authenticate once, then run headlessly

Initial sign-in happens in Abler's own browser UI using phone/email and a code, or Google. After importing the session, the package renews the access cookie automatically and saves cookie rotation. The refresh credential is an Abler session; no Google credentials are collected.

### Capture from Chrome

Start a separate Chrome profile with a debugging port bound to loopback. For example, on macOS:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.config/abler-mcp/chrome" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  https://www.abler.io/sign-on/login
```

On Linux, use your Chrome/Chromium executable with the same flags. The separate profile is required by [Chrome's current debugging rules](https://developer.chrome.com/blog/remote-debugging-port).

Sign in normally, leave an Abler tab open, then run in another terminal:

```sh
abler-mcp auth capture http://127.0.0.1:9222
```

This captures the Abler session, retains only its `refreshToken` and `id_token` cookies, verifies renewal and API access, and saves them. Close that Chrome instance after capture. The MCP server does not use the debugging port.

### Import an existing browser session

If your browser tooling can export cookies, import its JSON directly:

```sh
abler-mcp auth import /private/path/cookies.json
```

Accepted formats are a cookie array or an object with a `cookies` array, including Playwright storage state and CDP `Network.getCookies` output. Browser exports with `expirationDate` are also accepted. Only the two Abler auth cookies are retained; cookies for other sites and analytics are ignored.

With a browser that only provides developer tools, open **Application → Cookies → https://www.abler.io**, copy the `refreshToken` value into a private JSON file, and import it:

```json
{
  "cookies": [
    {
      "name": "refreshToken",
      "value": "PASTE_THE_COOKIE_VALUE_HERE",
      "domain": "www.abler.io",
      "path": "/"
    }
  ]
}
```

These cookies are HttpOnly, so `document.cookie` cannot export them. Treat the JSON as a credential; keep it out of source control and chat, and remove the temporary export after importing. A failed verification leaves the previous file intact and retains a private `.pending` candidate, because Abler may already have rotated the imported credential. The earlier credential may no longer work upstream; follow the recovery instructions below. A later successful import removes retained candidates.

### Move to a server without a browser

Securely copy the saved `session.json` to the headless machine, give it owner-only permissions, and set `ABLER_SESSION_FILE` to its absolute path. Install the package there and launch it over stdio from your MCP host. The package creates new session files with mode `0600` and new configuration directories with `0700` on Unix, and it refuses to read a session file that is a symlink, has hard links, is accessible to other users, or is owned by another user.

Processes using the same local session path coordinate refresh, reads, imports, and logout with a file lock, the `session.json.lock` directory beside the session file. A request waits up to 30 seconds for a busy lock and then fails with a busy error; retry later. After a hard process crash, the lock is released as soon as its PID no longer exists. A live process is never expired based on the lock's age, including while suspended. If the OS reuses a crashed owner's process ID for another live program, the lock can remain busy; remove it with `rm -r <file>.lock` only when no process is using that session file. Hard-linked session files are unsupported. Do not remove an active lock: a request whose lock is taken away fails and must be retried. Temporary files left behind by a crash are removed after five minutes. Copied files on other machines and browser sessions are not coordinated: use one active copy of a rotating session, or sign in separately for each independent host. Network filesystems and multi-host lock behavior are not supported or verified. Browser sessions can expire or be revoked: capture/import again when Abler rejects renewal. `auth logout` deletes only this package's local session, without signing out other devices.

The credential has the account's normal Abler permissions; the package itself exposes only read tools. It sends credentials exclusively to `https://www.abler.io`, refuses redirects, and never returns tokens through MCP tools.

## Tools

| Tool                   | Result                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `auth_status`          | Verifies API access and returns the account ID/name, with no credentials                  |
| `get_profile`          | Your ID/name, linked children, and `childNamesById` mapping Abler child IDs to names      |
| `list_groups`          | Age groups, sports, and nested subgroups                                                  |
| `list_schedule`        | Paginated events, times, locations, and linked participants' attendance                   |
| `list_child_schedules` | A separate schedule for each linked child, with their ID/name, attendance, and pagination |
| `get_event`            | One event, using `eventId` and `ageGroup.id` from a schedule result                       |

Example `list_schedule` arguments:

```json
{
  "from": "2026-09-11",
  "to": "2026-09-30",
  "types": ["TRAINING"],
  "first": 20
}
```

Dates use `YYYY-MM-DD`, matching Abler's date filter. Event times are returned as Abler's ISO timestamps; consumers should display them in the desired timezone. Supported types are `TRAINING`, `MATCH`, `GENERAL`, and `CLASSES`.

Use `groupIds` for **nested subgroup IDs**, not the parent age-group IDs. Use `participantIds` from `get_profile` to filter a player's schedule. `first` is bounded to 1–100. When `pageInfo.hasNextPage` is true, pass `pageInfo.endCursor` as `after` with the same filters. One response is one page, not the entire schedule. Without dates, Abler chooses its default upcoming schedule.

There is no generic GraphQL tool, attendance mutation, messaging, booking, or payment operation. Event descriptions are untrusted third-party text, not agent instructions.

### Reports per child

Use `list_child_schedules` with the same date/type/group filters to get every linked child's schedule in one call. No names or IDs need to be supplied for the default family report:

```json
{ "from": "2026-09-11", "to": "2026-09-30", "first": 20 }
```

The response is `{ "children": [{ "child": { "id": "…", "displayName": "…" }, "events": [], "pageInfo": { "hasNextPage": false, "endCursor": null } }] }`. Each entry identifies the child explicitly, including children with no events in the requested range. An account with no linked children returns `children: []`. Use the stable ID to distinguish children who share a name; display the name in reports.

`first` applies **per child**. Each child's page is fetched with Abler's participant filter, so one child's events cannot crowd another child out of a combined page. Shared events appear in each relevant child's schedule. Each event's `attendance` contains only that child's records, retaining Abler's raw `status` and `coachStatus` codes; an empty attendance array means no matching record was returned, not that the child is absent.

`get_profile` includes an explicit key/value lookup, fetched fresh from Abler:

```json
{ "childNamesById": { "ABLER_CHILD_ID_A": "Alex", "ABLER_CHILD_ID_B": "Alex" } }
```

The keys are **Abler's assigned IDs**, not locally generated IDs. The values are current display names, so duplicate names remain separate entries. Use the keys in `childIds` (or `participantIds` for `list_schedule`); filtering never uses a name or array position. This map is returned alongside the profile's `children` array and is not persisted as a second, potentially stale child directory.

Use optional `childIds` from `get_profile` to select children. To continue a child's schedule, pass just their ID in `childIds` and their cursor in `afterByChild`, keeping the original filters:

```json
{
  "from": "2026-09-11",
  "to": "2026-09-30",
  "childIds": ["CHILD_ID_FROM_GET_PROFILE"],
  "afterByChild": { "CHILD_ID_FROM_GET_PROFILE": "THAT_CHILDS_END_CURSOR" }
}
```

Unknown input keys, empty participant/child/group filters, unknown child IDs, and non-advancing pagination cursors fail explicitly. Follow each child's `hasNextPage` before reporting their schedule as complete. Failed requests return an error rather than an empty schedule.

## What was verified

On **2026-09-11**, against an authorized existing account:

- Browser OTP sign-in issued HttpOnly `refreshToken` and `id_token` cookies.
- A browser-independent `POST /oauth/token` returned HTTP 201 and updated both cookies. Access-token lifetime was 600 seconds. The captured refresh cookie initially expired about 80 days later; this is an observation, not a guaranteed lifetime.
- Cookie-authenticated `POST /graphql` fetched profile/group data and practices. Date and training filters, pagination, and event lookup were verified against live results.
- Per-child filtering was verified for all three children on the account, including children with no events in the requested range.
- The website sends OTP initiation to `/auth/graphql` with an `x-recaptcha-token` header. The package uses normal browser login; unattended SMS initiation is not implemented.
- Google sign-in is offered by Abler's UI; its resulting session is intended to use the same cookie import route. A separate Google login was not tested.

These are observed website endpoints, not a documented public API contract. GraphQL introspection is disabled. Abler's sign-in bundle also contains OAuth consent UI with `offline_access`, but public client registration and schedule access through that flow were not established. An approved Abler OAuth integration would be the route to investigate for a future distributed service.

The Chrome capture transport is covered by a local protocol test; live session capture in this investigation used the browser's CDP tool. Live API proof is separate from the offline tests.

## Troubleshooting

| Symptom                                          | Action                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abler-mcp` not found                            | Use the absolute installed executable path printed by the installer.                                                                                                                                                                                                                                     |
| Server appears to wait in the terminal           | Server mode waits for MCP input on stdio. Use an MCP host, or run `--help` / `auth status` for a CLI response.                                                                                                                                                                                           |
| No saved session                                 | Capture/import into the same `ABLER_SESSION_FILE` used by the MCP host.                                                                                                                                                                                                                                  |
| Cannot read session / unsafe permissions         | Use a regular file owned by your user, not a symlink or hard link; run `chmod 600 /absolute/path/session.json` on Unix. Its parent must be writable for atomic rotation and locking. Windows users must restrict access with OS ACLs; the Windows branches are unverified.                               |
| Expired or revoked session                       | Sign in again and capture/import. A refresh token is not permanent.                                                                                                                                                                                                                                      |
| Session busy                                     | Requests already wait up to 30 seconds; retry when the active request ends. A crashed process releases its lock when its PID no longer exists. A reused PID can keep a lock busy; remove it with `rm -r <file>.lock` only when no process is using the session file.                                     |
| Capture cannot list tabs                         | Launch a separate Chrome profile with the documented flags, keep it open, and use the exact loopback port.                                                                                                                                                                                               |
| No Abler tab found                               | Open and sign in at `https://www.abler.io` in that debugging profile.                                                                                                                                                                                                                                    |
| Failed import with a retained candidate          | Run `ABLER_SESSION_FILE=/absolute/path/to/candidate.pending abler-mcp auth status`. If it succeeds, use that path in the MCP host or stop users of the old session and move the candidate into place. A later successful import removes retained candidates. If it fails again, capture a fresh session. |
| Abler rejects a query or returns unexpected data | Check inputs and account access. Retry transient connection errors; an upstream API change may require a package update. Failures are not empty schedules.                                                                                                                                               |
| HTTP 429 / service error                         | Back off and retry later. No automatic retry loop is implemented for service errors.                                                                                                                                                                                                                     |

## Development and packaging

Maintainers use the pinned Bun 1.4.2 toolchain. Oxlint, Oxfmt, the type-aware
lint engine, and TypeScript are pinned in the repository root. Consumers run the
standalone Bun executable.

The server uses the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server), native `fetch`, `tough-cookie` for cookie handling, and the private `@family-mcp/session-store` workspace package for session locking and owner-only file storage (its README states the security contract). No browser dependency or download is required.

From the monorepo root:

```sh
bun install --frozen-lockfile
bunx turbo run build typecheck lint format:check test --filter=abler-mcp --force
bunx turbo run test:dist test:binary test:installer --filter=abler-mcp
```

`bun test` runs the eight offline integration tests, including the MCP stdio,
Chrome protocol, and loopback HTTP fixtures. Build/release output and the Bun lockfile are
excluded from formatting; runtime dependencies are excluded from linting.

Use `bun run lint:fix` for safe lint fixes and `bun run format` to format files
and sort imports. `bun run lint`, `bun run format:check`, and
`bun run typecheck` can also run independently.

The rules reject unused code, unsafe `any` and type assertions, unhandled
promises (including `void` escapes), redundant classes and generics, unnecessary
conditions, import cycles, and nesting deeper than four levels. Bun's
`test`/`it`/`describe` focused, skipped, and placeholder methods are forbidden.
Unused lint suppressions fail the check; TypeScript error expectations need an
explanation. Use existing functions and platform APIs before adding wrappers.

Intentional exceptions: cookie updates and child requests may run sequentially;
authentication errors omit original causes that could expose credentials;
console output is allowed only in the CLI and package smoke check. Do not
weaken rules or hide failures to make a check pass. Linter and formatter settings
live in [`.oxlintrc.json`](../../.oxlintrc.json) and [`.oxfmtrc.json`](../../.oxfmtrc.json).
See the official [Oxlint type-aware guide](https://oxc.rs/docs/guide/usage/linter/type-aware)
and [Oxfmt configuration reference](https://oxc.rs/docs/guide/usage/formatter/config-file-reference).

Every tool declares a strict output schema and returns validated `structuredContent`; upstream fields outside those schemas are discarded. Offline tests use synthetic credentials and include real MCP stdio, local Chrome protocol capture, concurrent processes, logout during refresh, failed-import recovery, private file permissions, invalid filters, malformed pagination, sibling ID/name collisions, shared events, and a loopback HTTP fixture. See the [review record](docs/REVIEW.md) for verified scope and remaining limitations.

This project is not affiliated with or endorsed by Abler.

`bun run build:binary` creates a standalone executable and checksummed archive
for the current machine in `release/`. It uses [Bun's compiler](https://bun.com/docs/bundler/executables),
with automatic `.env` and `bunfig.toml` loading disabled. Configuration comes
from the process environment. GitHub Actions builds and checks macOS 15 and
Ubuntu 24.04 on both CPU architectures, including a copied executable running
outside the checkout without the repository toolchain.

Installer regressions run separately as `test:installer`; package and native MCP
smokes run as `test:dist` and `test:binary`. The shared builder generates notices
from the actual bundle. Run `release:sync` after editing the package version;
CI checks that generated installers and documented URLs are current.
