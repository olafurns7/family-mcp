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
control; unattended renewal requires credentials configured for the MCP process.

## Mobile OAuth renewal investigation (2026-09-16)

InfoMentor's mobile app has a separate OAuth renewal flow that this MCP does not
implement. The earlier cookie-only experiment above did not exercise this flow
and does not establish that passwordless renewal is unavailable.

The publisher's [iOS release notes](https://apps.apple.com/is/app/infomentor-hub/id1388965431)
describe automatic login until logout. Static inspection of the Android app
confirmed an authorization-code exchange, persisted access and refresh tokens,
and an SSO bridge back into the website. This is evidence about the Android
implementation; the iOS binary was not inspected.

### Observed Android flow

1. `WebLoginKt` selects
   `https://im1.infomentor.is/Production/Mentor/?isimhapp=1` for Iceland.
2. After web login, `WebLoginActivity` posts an empty body to
   `account/pair/GetAuthenticationData` on the parent site. The response model
   contains `apiUrl`, `authenticationUrl`, `clientId`, `expirationTime`,
   `tokenUrl`, and `revokeRefreshTokenUrl`. The authentication URL contains a
   temporary `authGuid`.
3. `NetworkAPIManager.auth` calls `GET /Authentication/Authentication/LoginOAuth2`
   on the discovered authentication origin with the GUID, device identifier/name,
   platform, client ID, scope, response type, and callback URI. The app expects
   a 302 carrying an authorization code in the custom-scheme callback.
4. `AuthAPI.authToken` exchanges that code using a form-encoded
   `POST /Authentication/OAuth2/Token`. `AuthPresenter` saves `access_token` and
   `refresh_token`. The app uses client ID `notificationapp`, scope
   `IM2-API-NOTIFICATION`, and callback `InfomentorNotification://oauth2Callback`.
5. `MainPresenter` requests `GET /NA1/Authentication/sso` on the discovered API
   origin with a bearer access token and receives a web sign-in URL. On HTTP 401,
   it posts `grant_type=refresh_token` and the saved refresh token to the token
   endpoint, saves both returned tokens, and retries SSO.

The API paths, HTTP methods, and form field names were checked in the app's
Retrofit annotations as well as its calling code. No push-notification
registration is needed to describe this authentication sequence.

### Evidence and remaining verification

The inspected package was `net.infomentor.android`, version 1.0.85, matching the
publisher's [Google Play listing](https://play.google.com/store/apps/details?id=net.infomentor.android).
It was downloaded from an [APKPure mirror](https://apkpure.net/infomentor-hub/net.infomentor.android/download)
for static inspection, without installation or execution. The downloaded XAPK's
SHA-256 was `9267eae9ae8286ac850701d1f55e4e7906c77133d6786c4fc45302c4fa1d9ad6`,
matching the mirror's published hash; this is not independent publisher-signature
verification.

The Icelandic app-login URL was fetched successfully without credentials.
The public [parent JavaScript](https://minn.infomentor.is/dist/scripts/scripts.js)
also publishes native-app session-expiry notifications. Neither observation
proves a successful token exchange. No account was paired, no user tokens were
requested or refreshed, and refresh-token lifetime/rotation rules remain untested.

Before adding this flow to the MCP, verify discovery, pairing, token exchange,
expired-access-token renewal, and SSO restoration with an Icelandic account.
Preserve the existing account/child checks and cross-process lock. Rotated tokens
must be saved privately before subsequent SSO/data requests can fail. Validate
discovered origins and SSO redirects without forwarding bearer tokens or
passwords to redirect destinations. Existing cookie-only sessions will need an
explicit upgrade while authenticated, or a new login, to acquire a refresh token.

## Scope and consequence

Direct HTTP authentication and timetable access work for the tested account.
Playwright and Bun WebView are unnecessary for these verified operations.
Version 0.2.0 implements this flow and removes Playwright, replacing roughly
18 MiB of browser-package files with a small cookie jar and HTML parser.
Authentication and data retrieval no longer require a browser engine.

This check does not establish every account's SSO/MFA flow, security-challenge
behavior, long-term session lifetime, or every school-data endpoint. The older
0.1.3 release used Playwright; version 0.2.0 uses the verified HTTP flow.
