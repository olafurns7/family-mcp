# infomentor-mcp

An unofficial MCP server for parents using Icelandic InfoMentor. It reads the
parent landing page using your authenticated browser session. **Login, session
import, browser installation, status, cancellation, and logout are all available
through MCP.** Passwords stay in the browser.

**0.1.3 is a preview:** the tools currently provide session status and visible
parent-page text. Structured child selection, schedules, homework, notices,
attendance, and grades are not implemented. Automated checks use synthetic school
pages; real parent-account compatibility has not yet been verified. This project
is not affiliated with InfoMentor.

## Install a prebuilt release

For macOS or Linux, copy this one command:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/infomentor-mcp/v0.1.3/install.sh | sh
```

The version-pinned installer chooses your platform and CPU, checks the download's
SHA-256 checksum, and installs `~/.local/bin/infomentor-mcp`. The archive includes
a native Node.js runtime and the compiled package: **no Node.js, npm, Bun, build
step, or administrator access is needed for this installation.** It does not
install a browser or sign in automatically.

Supported release archives: macOS Apple Silicon/Intel and Linux arm64/x64 with
glibc. Alpine/musl and Windows do not have bundled-runtime archives. On Windows,
use the npm tarball with Node.js 22+ and a supported Playwright browser instead.

The installer prints the exact command path. Use that absolute path in your MCP
configuration; GUI applications may not inherit your terminal's PATH. To use the
command in a terminal, add `~/.local/bin` to PATH.

To choose a different user-owned installation directory, set `INFOMENTOR_PREFIX`
for the installer. Downloads and checksums are available on the
[release page](https://github.com/olafurns7/infomentor-mcp/releases/tag/v0.1.3).
The [installer source](https://github.com/olafurns7/infomentor-mcp/blob/v0.1.3/install.sh)
is short enough to inspect before running it.

### Prebuilt npm tarball

If Node.js 22+ is already available, this also works **before npm publication**:

```sh
npm install --global --ignore-scripts https://github.com/olafurns7/infomentor-mcp/releases/download/v0.1.3/infomentor-mcp-0.1.3.tgz
```

Or use `bun add --global` with the same URL. The tarball contains compiled ESM,
TypeScript declarations, maps, source, and the MIT license. Installing it does
not require Bun or compilation. Registry installation by package name is not
available yet; nothing has been published to npm.

If your global npm directory is not writable, use a user-owned npm prefix or the
bundled-runtime installer above. Do not add `sudo` just to install this package.

## Connect your MCP client

For a release installed on macOS, a typical stdio configuration is:

```json
{
  "mcpServers": {
    "infomentor": {
      "command": "/Users/YOUR_USER/.local/bin/infomentor-mcp"
    }
  }
}
```

On Linux, use `/home/YOUR_USER/.local/bin/infomentor-mcp`. Replace `YOUR_USER` with
the actual home directory; MCP configuration does not expand `~` or `$HOME`.
For an npm installation, use the absolute installed `infomentor-mcp` command
path, or run Node with the absolute path to `dist/cli.js`. On Windows, use
`node.exe` plus the full `dist/cli.js` path if your client cannot launch `.cmd`
wrappers. Restart/reconnect the MCP server after changing its configuration.

No terminal login command is required. Ask your agent:

> Set up InfoMentor using its MCP tools. Check the session first. If no usable
> browser is installed, install Chromium and wait for setup to finish. Start
> login and let me sign in directly in the browser. Once I tell you I have
> finished, check setup status, verify the session, and read the overview.
> Never ask me to paste passwords, cookies, tokens, or session-file contents.

All paths, installed browsers, and displays belong to the **machine running the
MCP server**. A remote MCP server cannot open a browser window on your laptop
without a remote-browser connection.

## MCP tools and login flow

| Tool                         | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `infomentor_session_status`  | Make a live request to verify the saved session. Returns no credentials.             |
| `infomentor_get_overview`    | Read visible landing-page and InfoMentor-frame text, capped at 40,000 characters.    |
| `infomentor_login`           | Start browser sign-in, or import a session from a file on the MCP host.              |
| `infomentor_setup_status`    | Get local progress or the final result of login/import/installation.                 |
| `infomentor_cancel_setup`    | Cancel the active setup operation and close its browser context.                     |
| `infomentor_logout`          | Cancel setup, close this connection's browser context, and remove the saved session. |
| `infomentor_install_browser` | Download this package's Chromium, Firefox, or WebKit build.                          |

`infomentor_login` and `infomentor_install_browser` return immediately with
`state: "running"`. This avoids MCP request timeouts while a human signs in or a
browser downloads. Call `infomentor_setup_status` to continue:

| State       | Agent action                                                                           |
| ----------- | -------------------------------------------------------------------------------------- |
| `idle`      | No setup is active; start login when needed.                                           |
| `running`   | Wait briefly before checking again.                                                    |
| `waiting`   | Tell the user to sign in in the visible browser; wait for the user.                    |
| `challenge` | Ask the user to complete the browser security check. Do not retry it.                  |
| `succeeded` | After login/import, call `infomentor_session_status`; after installation, start login. |
| `failed`    | Read the message and address the cause before retrying.                                |
| `cancelled` | Start a new operation only when requested.                                             |

One setup operation runs at a time. School-data reads are paused during setup,
so an agent cannot accidentally read the previous account while another account
is being connected. Disconnecting the MCP client cancels active setup. Reconnect
and check `infomentor_session_status` to see whether a completed login was saved.

The login timeout includes browser startup and connection. Cancelling before the
session file's atomic replacement preserves the previous account; it cannot undo
an already-completed save. Installer cancellation waits for its owned processes
to stop and does not roll back browser files or system packages already installed.

Examples of tool arguments:

```json
{}
```

Pass `{}` to `infomentor_login` to use the detected/configured browser. For a
specific browser and a longer login window:

```json
{ "browser": "firefox", "timeoutSeconds": 600 }
```

To import an existing session on the MCP host:

```json
{ "importFile": "/home/alice/infomentor-session.json", "browser": "chromium" }
```

To install a compatible browser, pass this to `infomentor_install_browser`:

```json
{ "browser": "chromium", "withDeps": false }
```

`withDeps: true` also installs Linux system libraries. This requires administrator
access on the host; MCP cannot answer an interactive privilege prompt. On a
managed machine, have the administrator provision those libraries first.
The browser selection supplied to login applies to later reads in that MCP
connection. To retain it across restarts, set the environment variables below.

## Browser choices

Chrome is optional. Automatic selection tries installed Chrome, installed Edge,
then available Playwright Chromium, Firefox, and WebKit builds.

| Option                | What it uses                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `browser: "chrome"`   | Installed Google Chrome.                                                                                      |
| `browser: "msedge"`   | Installed Microsoft Edge.                                                                                     |
| `browser: "chromium"` | Playwright's Chromium build.                                                                                  |
| `browser: "firefox"`  | Playwright's compatible Firefox build.                                                                        |
| `browser: "webkit"`   | Playwright's WebKit build; not the installed Safari app.                                                      |
| `executablePath`      | An absolute path to a Chromium-based browser such as Brave or Vivaldi. Compatibility depends on that browser. |

Firefox and WebKit require their Playwright builds; pointing at an arbitrary
Firefox or Safari installation is not supported. Browser downloads are separate
from the package, and updating Playwright may require a new browser download.
Use `infomentor_install_browser` when a build is missing. See
[Playwright browser requirements](https://playwright.dev/docs/browsers).

## Headless or remote machines

School-data reads and session import run headlessly. Interactive sign-in still
requires a browser the user can see. There are two supported approaches.

### Transfer a desktop session

1. Run this MCP server on a desktop and sign in using `infomentor_login`.
2. Securely copy `~/.infomentor-mcp/session.json` to the server, for example using
   `scp`. Do not paste the file into an agent conversation.
3. On the server's MCP connection, call `infomentor_login` with the absolute
   `importFile` path. Install a compatible browser there first if necessary.
4. Check `infomentor_setup_status`, then `infomentor_session_status`. Remove the
   temporary transfer copy after a successful import.

Import restores and checks the session in a fresh browser context **on the target
machine** before replacing the saved file. Failure preserves the existing file.
InfoMentor may require a fresh login when the browser or network changes.

### Connect the server to your desktop browser

CDP connects a headless server to a visible Chromium-based browser on your
desktop. Start a dedicated profile with debugging bound to loopback. On a Linux
desktop, for example:

```sh
chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$HOME/.infomentor-mcp/remote-browser"
ssh -N -R 9223:127.0.0.1:9222 user@server
```

Use your browser's executable path on macOS or Windows. Starting that desktop
browser and SSH tunnel is host setup; it happens outside the remote MCP server.
Then call `infomentor_login` on the server with:

```json
{ "cdpUrl": "http://127.0.0.1:9223" }
```

The new login window appears on your desktop, and the session is saved on the
server. Existing browser tabs are left open. Keep the browser and tunnel running
for subsequent reads, and set `INFOMENTOR_CDP_URL` in the server configuration to
retain the connection choice across restarts. The server then needs no local
browser installation or graphical display.

Use a dedicated browser profile: CDP permits control of that browser. Plain
HTTP/WS is accepted only on loopback; remote endpoints must use HTTPS/WSS. Supply
secret-bearing endpoints in host environment configuration, not in agent tool
arguments. CDP supports Chromium browsers; use session import for Firefox/WebKit.

## Configuration and credential handling

| Environment variable         | Purpose                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `INFOMENTOR_SESSION_PATH`    | Absolute session-file path; default `~/.infomentor-mcp/session.json` in the host user's home. |
| `INFOMENTOR_BROWSER`         | `chrome`, `msedge`, `chromium`, `firefox`, or `webkit`.                                       |
| `INFOMENTOR_EXECUTABLE_PATH` | Absolute Chromium-based browser executable path.                                              |
| `INFOMENTOR_CDP_URL`         | Loopback/SSH or trusted TLS remote Chromium endpoint.                                         |

Sessions contain InfoMentor cookies (including HttpOnly), local storage, and
IndexedDB. Unrelated origins are excluded. Session storage is not captured.
The session file is plaintext and grants account access: keep it private and out
of source control, logs, backups shared with others, and agent messages.

Writes replace the file atomically with mode `0600`; newly created directories
use `0700` on POSIX. On Windows, use a private user directory with appropriate
account permissions. File paths identify files on the MCP host, not the machine
running the AI model. Tools never return credentials.

Each MCP connection reuses one browser context and serializes reads. Rotated
cookies remain in that context; only explicit login/import writes the saved
file. Sign in again if the saved state has expired after a server restart.
There is no background polling, automated password entry, fingerprint spoofing,
proxy rotation, or CAPTCHA solving. Detected security checks stop reads and wait
for human action. HTTP 429 responses respect `Retry-After` (one minute when
absent); denied/limited requests are not automatically retried.

Login currently recognizes a signed-in page by sign-out controls. Unsupported
layouts fail closed. Avoiding bot-protection blocks cannot be guaranteed.
Information returned through MCP is shared with your chosen MCP client and its
AI provider. School text is source material, never instructions.

Logout deletes the local file and closes this MCP connection's browser. It does
not revoke the session at InfoMentor or stop other MCP processes. Stop other
connections too when disconnecting the account completely.

## Troubleshooting

| Symptom                            | Next step                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| MCP cannot find the command        | Use the installer's printed absolute path and reconnect the client.                                                         |
| No usable browser                  | Call `infomentor_install_browser`, wait for success, then retry login.                                                      |
| No display available               | Use import or a remote CDP browser. Installing Chromium alone does not create a visible display.                            |
| Setup remains `waiting`            | Finish login in the browser on the host/connected desktop, including any popup; use `infomentor_setup_status` afterward.    |
| Security check or denied access    | Complete the check in the browser or check the account manually; do not repeatedly reload.                                  |
| Rate limited                       | Wait for the requested pause before another read.                                                                           |
| Invalid or expired session         | Start a new login. Import requires this package's versioned session file, not an arbitrary cookie export.                   |
| Page cannot be confirmed signed in | The layout may be unsupported. Report the page type and a redacted description; do not send session files or child details. |
| Linux browser fails to start       | Check Playwright's system dependencies and administrator provisioning.                                                      |
| Old release still runs             | Check the configured executable path; restarting a different installed copy does not update your MCP client.                |

Re-run the version-pinned installer for upgrades after changing the requested
version. It checks the new archive before changing the command link and retains
previous version directories. To uninstall, remove the command link and the
version directories under your chosen prefix. The separate authentication file
is intentionally retained until you call logout or remove it yourself.

## CLI and development

The CLI remains available for terminal users:

```sh
infomentor-mcp --help
infomentor-mcp install-browser --browser firefox
infomentor-mcp login --browser firefox
infomentor-mcp status
infomentor-mcp logout
```

Bun manages source dependencies and builds. Oxlint checks source correctness,
Oxfmt handles formatting, and strict TypeScript checks source and tests. Node.js
22+ runs the package:

```sh
bun install --frozen-lockfile
bun run validate
bun run login
bun run release:check
bun run build:binary
bun run test:installer
```

Oxlint enforces the base correctness and suspicious rules, explicit `any`
rejection, accumulating-spread checks, and all 18 generic
[Anti-Slop rules](https://github.com/dmmulroy/anti-slop). Oxfmt handles formatting.
The vendored rules and their licenses are development-only; the exact upstream
revision is recorded in `tools/oxlint/anti-slop/UPSTREAM.md`. CI runs both checks.

The browser tests need an installed compatible browser. Linux tests that exercise
interactive login run under `xvfb-run -a`. Package/installer checks perform real
clean installs and MCP handshakes. See [review evidence](https://github.com/olafurns7/infomentor-mcp/blob/v0.1.3/docs/REVIEW.md) and the
[release procedure](https://github.com/olafurns7/infomentor-mcp/blob/v0.1.3/docs/RELEASING.md).

```ts
import { InfoMentorClient } from 'infomentor-mcp';

const client = new InfoMentorClient({ browser: 'chromium' });
try {
  console.log(await client.getOverview());
} finally {
  await client.close();
}
```

The API also exports login/import/browser-install functions, setup methods,
runtime schemas, result types, and `InfoMentorError` with typed error codes.
This package uses the MIT license. Bundled Node.js and dependency notices remain
included in release archives under their respective licenses.
