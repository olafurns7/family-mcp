# abler-mcp

Unofficial, read-only [Abler](https://www.abler.io) MCP server. Written in TypeScript, managed with Bun, distributed as an npm executable. Requires Node.js 22+ to run the installed executable; Bun is used for development. The running MCP server uses HTTP and needs no browser.

## Install the prebuilt release

Node.js **22+** and npm are required. No Bun, checkout, build step, browser download, or npm publication is needed:

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts 'https://github.com/olafurns7/abler-mcp/releases/download/v0.3.0/abler-mcp-0.3.0.tgz'
```

Then run `"$HOME/.local/bin/abler-mcp" --version`. Add `$HOME/.local/bin` to your PATH to use `abler-mcp` directly. Runtime dependencies are fetched from npm; the compiled release itself is hosted on GitHub. [Release assets and checksums](https://github.com/olafurns7/abler-mcp/releases/tag/v0.3.0) are available for verification. Use the versioned `.tgz` asset, not GitHub's source ZIP/tarball.

On Windows, omit `--prefix "$HOME/.local"` and use `abler-mcp.cmd`; Windows has not been verified. macOS and Linux are the supported installation examples.

For agent setup and reporting rules, read **[docs/AGENTS.md](docs/AGENTS.md)**. For a future npm publication, read **[docs/PUBLISHING.md](docs/PUBLISHING.md)**.

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

On macOS, home paths normally start `/Users/you`. JSON configurations generally do not expand `~` or `$HOME`. Node must be on the MCP host's PATH; alternatively use its absolute executable path and pass the installed `lib/node_modules/abler-mcp/dist/cli.js` as an argument.

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

These cookies are HttpOnly, so `document.cookie` cannot export them. Treat the JSON as a credential; keep it out of source control and chat, and remove the temporary export after importing. A failed verification leaves the previous file intact and retains a private `.pending` candidate, because Abler may already have rotated the imported credential. The earlier credential may no longer work upstream; follow the recovery instructions below.

### Move to a server without a browser

Securely copy the saved `session.json` to the headless machine, give it owner-only permissions, and set `ABLER_SESSION_FILE` to its absolute path. Install the package there and launch it over stdio from your MCP host. The package creates new session files with mode `0600` and new configuration directories with `0700` on Unix.

Processes using the same local session path coordinate refresh, reads, imports, and logout with a file lock. A lock held for more than 30 seconds returns a busy error; retry later. After a hard process crash, allow two minutes for its lock to become stale. Do not remove an active lock. Copied files on other machines and browser sessions are not coordinated: use one active copy of a rotating session, or sign in separately for each independent host. Network filesystems and multi-host lock behavior are not supported or verified. Browser sessions can expire or be revoked: capture/import again when Abler rejects renewal. `auth logout` deletes only this package's local session, without signing out other devices.

The credential has the account's normal Abler permissions; the package itself exposes only read tools. It sends credentials exclusively to `https://www.abler.io`, refuses redirects, and never returns tokens through MCP tools.

## Tools

| Tool | Result |
| --- | --- |
| `auth_status` | Verifies API access and returns the account ID/name, with no credentials |
| `get_profile` | Your ID/name, linked children, and `childNamesById` mapping Abler child IDs to names |
| `list_groups` | Age groups, sports, and nested subgroups |
| `list_schedule` | Paginated events, times, locations, and linked participants' attendance |
| `list_child_schedules` | A separate schedule for each linked child, with their ID/name, attendance, and pagination |
| `get_event` | One event, using `eventId` and `ageGroup.id` from a schedule result |

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

| Symptom | Action |
| --- | --- |
| `abler-mcp` or `node` not found | Use the absolute installed executable path; ensure the MCP host can find Node 22+. |
| Server appears to wait in the terminal | Server mode waits for MCP input on stdio. Use an MCP host, or run `--help` / `auth status` for a CLI response. |
| No saved session | Capture/import into the same `ABLER_SESSION_FILE` used by the MCP host. |
| Cannot read session / unsafe permissions | Use a regular file, not a symlink; run `chmod 600 /absolute/path/session.json` on Unix. Its parent must be writable for atomic rotation and locking. Windows users must restrict access with OS ACLs. |
| Expired or revoked session | Sign in again and capture/import. A refresh token is not permanent. |
| Session busy | Retry when the active request ends. After a hard crash, wait two minutes; do not delete an active lock. |
| Capture cannot list tabs | Launch a separate Chrome profile with the documented flags, keep it open, and use the exact loopback port. |
| No Abler tab found | Open and sign in at `https://www.abler.io` in that debugging profile. |
| Failed import with a retained candidate | Run `ABLER_SESSION_FILE=/absolute/path/to/candidate.pending abler-mcp auth status`. If it succeeds, use that path in the MCP host or stop users of the old session and move the candidate into place. Remove unused private candidates after recovery. If it fails again, capture a fresh session. |
| Abler rejects a query or returns unexpected data | Check inputs and account access. Retry transient connection errors; an upstream API change may require a package update. Failures are not empty schedules. |
| HTTP 429 / service error | Back off and retry later. No automatic retry loop is implemented for service errors. |

## Development and packaging

The server uses the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server), native `fetch`, `tough-cookie` for cookie handling, and `proper-lockfile` for session coordination. No browser dependency or download is required.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
node dist/cli.js --help
npm pack
```

`npm pack` runs the checks and builds a fresh `dist` before creating `abler-mcp-0.3.0.tgz`; it does not publish anything. The archive contains only compiled code, README, LICENSE, agent/maintainer documentation, and package metadata. The installed executable runs with Node; Bun is needed only for development and packing from source.

Offline tests use synthetic credentials and include real MCP stdio, local Chrome protocol capture, concurrent processes, logout during refresh, failed-import recovery, private file permissions, invalid filters, malformed pagination, sibling ID/name collisions, and shared events. See the [review record](docs/REVIEW.md) for verified scope and remaining limitations.

This project is not affiliated with or endorsed by Abler.
