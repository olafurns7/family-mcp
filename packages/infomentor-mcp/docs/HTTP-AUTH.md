# Direct HTTP compatibility check

Verified against the Icelandic parent service on 2026-09-11 using a parent account.
The check used Python's standard HTTP client, cookie jar, and HTML parser. No
Playwright, WebView, browser engine, or page JavaScript was used for authentication
or data retrieval. Credentials were entered through a private local prompt and
sent directly to InfoMentor; no password was saved.

## Observed authentication flow

1. `GET https://im1.infomentor.is/production/mentor/` obtains the login form and
   initial cookies.
2. `POST` that form back to its declared action. Submit the fresh `__VIEWSTATE`,
   `__VIEWSTATEGENERATOR`, and `__EVENTVALIDATION` values, the username/password
   fields, and the login button field. Preserve cookies through redirects.
3. The response redirects to
   `https://minn.infomentor.is/authentication/authentication/login`.
4. That page contains an automatically submitted `openid_message` form with an
   `oauth_token` field. Submit its hidden fields to its declared action at
   `https://im1.infomentor.is/Production/Mentor/`. This reproduces the form
   submission without evaluating its JavaScript.
5. InfoMentor redirects through
   `https://minn.infomentor.is/Authentication/Authentication/LoginCallback` and
   finishes at `https://minn.infomentor.is/`.

Callback query parameters and authentication cookies are credentials. Their
values are deliberately omitted here. Do not hard-code hidden fields or tokens;
read them from each fresh response and validate every redirect/form destination.

## Verified authenticated requests

| Request                                                                        | Result                                                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `POST /authentication/authentication/isauthenticated/` on `minn.infomentor.is` | JSON `true` with the saved cookies; JSON `false` without them.                                              |
| `GET /` on `minn.infomentor.is`                                                | Parent bootstrap JSON includes the current account, child list, selected child, and available applications. |
| `POST /timetable/timetable/appData` on `minn.infomentor.is`                    | Timetable JSON with an `items` array containing lesson dates/times, titles, and details.                    |

The cookie jar was saved privately and reloaded in a separate process before the
authenticated checks. The timetable request follows the POST behavior in the
site's own `IMHome.core.loadView` implementation in `/dist/scripts/scripts.js`.
Without authenticated cookies, that same timetable endpoint returned a login
handoff and no timetable items.
The parent page contains templates and bootstrap data; rendering its initial
HTML as text is not a replacement for reading the application's JSON endpoints.

## Renewal for scheduled reads

Abler MCP was used as a reference for renewal policy: serialize the whole
read/renew/write operation across processes, persist rotated cookies, and replay
a read at most once after an authentication failure. Abler's `/oauth/token`
and refresh-token cookies belong to Abler; they are not InfoMentor endpoints.

An isolated-cookie test against InfoMentor removed the parent `IMHome` cookie
and followed the existing login/OpenID handoff. It reached a password form and
did not renew authentication. The handoff also affected shared server session
state: the original cookies still returned `true` from `isauthenticated`, while
the parent page redirected to the login relay. Cookie-jar isolation therefore
does not guarantee independent upstream state. No cookie-only renewal contract
was established, and that experiment is not part of the implementation.

Version 0.5.0 instead uses the verified password login flow after a confirmed
authentication failure, using a private credentials file or environment secrets
already configured for the MCP process. A known login-page redirect also counts
as an authentication failure, even if `isauthenticated` returned `true`.
The renewed account must match its previously verified parent ID. The original
child selection is restored before replaying the read once. Network errors,
rate limits, access denials, and security challenges do not trigger password
retries. A missing/deleted session still requires explicit login. An expired
legacy session without a verified account ID requires one explicit login;
an authenticated legacy session acquires that identity on its next read.

Successful renewal and rotated cookies are saved atomically under the same
session lock used for collection, login, import, and logout. The MCP does not
save the password. A configured credentials file remains under the user's
control; a one-time local form cannot provide credentials for unattended renewal.

## Scope and consequence

Direct HTTP authentication and timetable access work for the tested account.
Playwright and Bun WebView are unnecessary for these verified operations.
Version 0.2.0 implements this flow and removes Playwright, replacing roughly
18 MiB of browser-package files with a small cookie jar and HTML parser.
Authentication and data retrieval no longer require a browser engine.

This check does not establish every account's SSO/MFA flow, security-challenge
behavior, long-term session lifetime, or every school-data endpoint. The older
0.1.3 release used Playwright; version 0.2.0 uses the verified HTTP flow.
