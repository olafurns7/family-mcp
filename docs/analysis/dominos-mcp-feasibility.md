# Domino’s Iceland MCP investigation

Investigated 2026-09-16. An unofficial MCP is feasible: public catalogue data and
stores are accessible, and authenticated profile and receipt reads worked.
SMS login and refresh now work through the MCP client. An authorized iPhone
capture confirmed that the iOS saved-card list comes from an Adyen session-setup
response. The MCP subsequently created its own unpaid session through Domino’s
and retrieved a saved Visa. No payment request was sent. The implementation is an
unreleased preview in `packages/dominos-mcp`; validation boundaries are recorded below.

The initial browser investigation used the existing signed-in Chrome tab, a read-only profile
request, anonymous public HTTP requests, and the website’s deployed JavaScript.
No SMS was requested, account information edited, cart populated, or order or
payment submitted. Loading the website itself also emits analytics and an
`orders/recommendation/send` request. Tokens and personal response data are not
included in this report or saved to repository files.

## Verified access and endpoint map

API base: `https://api.dominos.is/api/`. Authenticated browser requests use
`Authorization: bearer <access_token>`. Some website requests contain a double
slash after `/api/`; the single-slash profile and store URLs also returned 200.

| Request | Purpose | Evidence |
| --- | --- | --- |
| `GET https://www.dominos.is/panta/pizzur` | Menu, topping choices, sizes, prices, offers, allergens, availability, settings | Anonymous HTTP 200; structured JSON embedded in the React hydration call |
| `GET /store` | Stores, opening hours, pickup/delivery status and waiting estimates | Anonymous HTTP 200; 22 records |
| `GET /user/newuser` | Profile, saved addresses/stores/orders, saved-card metadata, credit | Authenticated HTTP 200; `savedCards` exists and is an empty array for this browser account |
| `GET /user/getreceipts` | Receipt and order history | Authenticated browser HTTP 200; response is an array |
| `GET /giftcard/getgiftcards` | Gift-card information | Authenticated browser HTTP 200 |
| `POST /login/sendPin?phoneNumber=354…` | Request an Icelandic SMS code | User completed the CLI SMS flow; saved session verified live |
| `POST /login/sendPinForeign?phoneNumber=…&recaptchaValue=…` | Request a foreign-number SMS code | Client source only; not called |
| `POST /token` | Exchange SMS code or refresh token | CLI sign-in succeeded; live refresh rotated both tokens and the refreshed session verified |
| `GET /addresses?q=…` | Address search | Anonymous live request and MCP tool succeeded |
| `GET /addresses/GetAddressStoreWithWaitingTimes?address=…&postalCode=…` | Resolve delivery store and waiting time | Anonymous live request and MCP tool succeeded |
| `GET /timeslot/getavailabletimeslots?storeid=…&date=…` | Scheduled ordering availability | Client source only |
| `GET /orders/cart/latest` | Latest account order/cart | Live order-guid query returned 200 with `OrderData: ""` before payment; paid result remains untested live |
| `GET /tracker` | Account order tracking | Live client returned `OrderState: Unknown`, `OrderID: null`; active-order transitions remain untested |
| `POST /orders` | Price calculation and unpaid session creation, controlled by `IsFinal` | Both variants returned 200; a small Pepperoni Veisla quote was 2,490 ISK and the unpaid session returned a saved Visa |
| `POST /webcoupon/price` | Coupon price calculation | Client source only; not called |

Receipt item fields include `Id`, `ReceiptData`, `Amount`, `DateOf`, `OrderData`,
`IsOneSystem`, and `PulseData`. Outputs should select useful fields and exclude
unnecessary personal data instead of forwarding the upstream response wholesale.

The anonymous menu contains 34 menu-pizza records, 38 toppings, and 10 package
offers. These are raw catalogue counts: visibility and store/delivery
availability still need filtering. Pizza and side data distinguish pickup and
delivery prices. No separate menu API was identified in this browser flow;
extracting the embedded JSON is a workable initial source. Parse it as data;
never evaluate the upstream script.

## SMS authentication

The deployed SMS component selects `sendPin` for Iceland and `sendPinForeign`
for other countries. Its CAPTCHA condition is the foreign-country branch.
It requires a six-digit code before submitting the token request.

The client constructs this form-style token body:

```text
grant_type=password
username=354<phone-number>
password=<six-digit-SMS-code>
authentication_type=sms
```

The current serializer additionally emits `auth_identifier=undefined` in this
branch. Its `fetch` call passes a string body without explicitly setting a
Content-Type. The CLI successfully used `application/x-www-form-urlencoded`
without the `auth_identifier=undefined` field during the user's live sign-in.

The refresh request uses `grant_type=refresh_token` and `refresh_token` at the
same `/token` endpoint. Source handles `access_token`, `refresh_token`,
`token_type`, `username`, and `expires_in`, and refreshes on an unauthorized
response. The saved live session had approximately 24 hours remaining; an explicit
refresh rotated both access and refresh tokens, persisted them, and successfully
verified the account afterward. Long-term renewal, OTP expiry, and rate limits
remain untested. The source also uses `authentication_type=app` for an
Auðkenni company-login flow; that is not evidence about Domino’s native app login.

The implementation uses `dominos-mcp auth login`: prompt locally for
phone number and SMS code, verify the profile, and save the returned session
using the existing private session store. Lock around refresh and persist any
rotated token before releasing the lock. Live CLI login and refresh succeeded
without browser automation.

## Why the website’s card list is empty

The browser account API returns `savedCards: []`, and “Mitt Domino’s” displays
“Engin vistuð kort.” The frontend assigns the profile’s `savedCards` to its
older credit-card model; there is no observed populated array being hidden.

The public site configuration currently has `IsStraumurEnabledWeb: true` and
`PayOnlineEnabled: false`. The payment-model code enables its Straumur model
using the former flag and disables the older card model. The Straumur flow
loads Adyen Checkout/Drop-in and consumes `AdyenSessionId`, `AdyenSessionData`,
and `AdyenClientId` from the order response. The account page still reads the
older model’s saved-card list.

The iOS app was inspected directly through iPhone Mirroring. Its existing
checkout has separate Apple Pay and “Kort” choices. Tapping “Kort” opens a
payment sheet with a masked saved Visa card and a payment button. “Breyta
greiðslumáta” opens a list with the saved card under “GEYMT” and a separate
new-card option under “AÐRAR”. This is a saved-payment-method selector, not
card-number-field autofill. No payment button was clicked, and the sheet was
dismissed after inspection. Opening it initializes an Adyen session, as verified
below; any upstream unpaid Domino’s order creation remains unverified.

The subsequent phone capture confirmed this request while opening “Kort”:

```http
POST https://checkoutshopper-live.adyen.com/checkoutshopper/v1/sessions/{sessionId}/setup?clientKey=<clientKey>
Content-Type: application/json

{"sessionData":"<opaque session data>"}
```

It returned HTTP 200. The request body contains only `sessionData`; there is no
Authorization or Cookie header. The response includes `id`, updated
`sessionData`, `expiresAt`, `amount`, `countryCode`, `shopperLocale`, `returnUrl`,
`configuration`, and `paymentMethods`. The returned `sessionData` differs from
the submitted value.

`paymentMethods.storedPaymentMethods` contains one saved Visa (`type: scheme`).
Its fields are `id`, `brand`, `type`, `name`, `holderName`, `lastFour`,
`expiryMonth`, `expiryYear`, `supportedRecurringProcessingModels`, and
`supportedShopperInteractions`. Card identifiers, holder information, expiry,
and session credentials are intentionally omitted here. The separate
`paymentMethods.paymentMethods` array advertises `applepay`, `scheme`, and
`googlepay`.

This proves the saved-card list is supplied through an Adyen payment session,
independently of the empty profile `savedCards` array. The capture contains no
Domino’s app API request, so the source of the session ID/data is still unknown.
The website’s order-response fields did not prove that the app uses the same
request. The later MCP validation obtained a valid shopper session from the
website's order endpoint and retrieved a saved Visa. Domino’s bearer tokens are
sent only to Domino’s; Adyen setup receives its own session data and client key.

The observed setup request agrees with Adyen’s public iOS SDK implementation.
See [SessionSetupRequest.swift](https://github.com/Adyen/adyen-ios/blob/develop/AdyenSession/API/Session%20Setup/SessionSetupRequest.swift)
and [Adyen’s iOS Sessions guide](https://docs.adyen.com/online-payments/build-your-integration/sessions-flow?integration=Drop-in&platform=iOS&version=5.20.2).

The checkout source can automatically invoke `fetchSendOrder(true, …)` to
initialize the Adyen flow, and that helper also updates profile information.
Consequently, reaching a populated payment screen is not necessarily a
read-only action. Even `IsFinal: false` needs its side effects verified before
being exposed as a read-only MCP tool.

## iPhone capture options

Apple supports USB packet capture through Remote Virtual Interface (`rvictl`),
then `tcpdump` or Wireshark. USB capture alone does not decrypt HTTPS request
paths, headers, or bodies. See [Apple’s packet-trace guide](https://developer.apple.com/documentation/network/recording-a-packet-trace).

For the “Kort” endpoint, the successful approach was a local HTTPS debugging proxy:
route the iPhone’s Wi-Fi HTTP proxy through the Mac, install and trust the local
debugging CA on the phone, then enable decryption for the relevant Domino’s
domains. Start a short capture before opening the app/card list so an initial
prefetch is not missed. Keep captures private and redact credentials and card
references from any derived report. Remove the proxy and debugging trust when
finished. [Proxyman’s device setup](https://docs.proxyman.com/debug-devices/ios-device)
documents this flow; [domain-specific SSL proxying](https://docs.proxyman.com/basic-features/ssl-proxying)
limits decryption to selected hosts.

Certificate pinning or an app that ignores the system proxy can prevent this.
The Adyen setup call accepted the trusted local CA in this run. Domino’s own
app API traffic was not observed; this capture does not establish why it was
absent or whether it uses pinning or bypasses the system proxy.

This Mac has `rvictl` and `tcpdump`, and its USB device tree contains an iPhone.
Wireshark, Proxyman, and Charles were absent from `/Applications`; their command
line tools and mitmproxy were initially not found in PATH. USB capture requires
administrator access here: no readable BPF devices were available and
non-interactive sudo required a password.

During the follow-up, mitmproxy 12.2.3 was prepared using `uvx`, outside the
repository. Its temporary configuration and generated CA use a private local
directory, and capture files use mode `0600`. Decryption and saved-flow filters
are limited to Domino’s, Straumur, and Adyen domains. A loopback HTTPS probe of
the public `/store` endpoint returned 200 through the proxy using its CA file.
The user approved temporary proxy/certificate setup, a private capture of the
card flow, and restoration afterward. The local `http://mitm.it` onboarding
page loaded on the phone, and the downloaded CA’s serial number matched the
locally generated certificate. The user entered the device passcode locally
for installation and removal. Full trust was enabled only for the capture.

The finalized capture has six flows: the anonymous Mac `/store` probe, one
Adyen session-setup call, the card-brand image, and three Adyen analytics calls.
An offline check verified the host filter, setup status/body shape, one stored
Visa, absence of Authorization/Cookie on setup, and capture mode `0600`.
No `/payments` request was observed and no payment button was clicked.

Cleanup was verified in the phone UI: certificate trust was turned off, the
Wi-Fi proxy was restored to its original Off setting, and the mitmproxy profile
was removed. The local proxy process exited successfully. The raw capture
remains in its private local temporary directory, outside the repository.

## Implementation and validation

`packages/dominos-mcp` reuses `@family-mcp/mcp-runtime`,
`@family-mcp/session-store`, Zod, and the native packaging pipeline without new
external dependencies. It provides 13 tools for menu/store/address discovery,
profile, receipts, tracking, quotes, checkout, and explicitly confirmed saved-card
payment. Local SMS login hides both inputs and saves verified credentials in a
private file. Shared locking serializes token refresh and checkout operations.

The source-based order payload uses `IsFinal: false` for quotes and
`IsFinal: true, PayWithStraumur: true, Payonline: false` for Adyen session creation.
The website's `ClientID` is a Google Analytics client ID; without analytics the
website sends null, which this implementation also sends. On Adyen authorization
the site clears its cart and navigates to tracking; no separate order-submission
callback was identified in that handler.

Adyen setup rotates `sessionData`; subsequent payment uses the updated value.
The observed 5,190 ISK checkout had an Adyen amount of 519,000, so the client
requires `adyenAmount === quotedISK * 100` as well as matching Domino’s totals
and session IDs. Payment sends a scheme `storedPaymentMethodId` to the shopper
session endpoint. The request shape is based on Adyen's
[PaymentsRequest.swift](https://github.com/Adyen/adyen-ios/blob/develop/AdyenSession/API/Payments/PaymentsRequest.swift),
not a captured or completed charge.

Quotes and checkout records are private local files. A quote reuses its single
checkout; payment intent is persisted before network transmission. A timeout,
restart, bank-verification action, or ambiguous response cannot replay payment
for that checkout. Tools return the reviewed cart and masked card aliases, not
access tokens, refresh tokens, Adyen session credentials, or saved-card vault IDs.

Validation on 2026-09-16:

- Live MCP calls succeeded for `list_stores` (22 records), `search_menu`
  (Pepperoni Veisla), `search_addresses` (Skeifan), and `get_delivery_store`
  (Skeifan 11, 108 → store 1). No account or order mutation was used for these.
- The compiled macOS arm64 executable also completed a live `get_menu_item`
  lookup for Pepperoni Veisla: four sizes, 36 visible toppings, and clean stderr.
- The user completed hidden-input CLI SMS login. The session file is mode 0600.
  Profile, receipt history, and the no-active-order tracker response then parsed
  successfully. Saved addresses use `AddressID`/`Address`, unlike address-search
  `ID`/`Name`; the client now normalizes these fields, with a synthetic regression
  case that reproduces the observed shape without personal data.
- A live `IsFinal: false` request quoted a small Pepperoni Veisla on classic crust
  for pickup at Skeifan at 2,490 ISK. One `IsFinal: true` request initialized its
  unpaid Adyen session. Setup returned 200 with one saved Visa, matching the quote
  amount and session ID. The response contained no assigned `OrderID`.
- A private offline comparison against the earlier iPhone capture confirmed that
  both the masked card identity and Adyen vault reference match. No card details
  or vault references were printed or copied into this repository.
- Reopening that same quote reused the existing checkout without another POST.
  A live refresh rotated both tokens; the saved replacement session verified,
  and the tracker remained `Unknown`. These checks explicitly rejected payment
  endpoints. No `/payments` or `/paymentDetails` call was made.
- Looking up the unpaid checkout by its order GUID returned `OrderData: ""`.
  Reconciliation accepts that response and preserves the prior state; it does
  not infer a failed payment. A synthetic regression checks an empty response
  followed by `IsPayed: true`, without replaying the payment.
- Eight offline tests cover SMS request shape/private persistence, safe errors,
  menu parsing without script execution, tool schemas, offers with different
  pizzas sharing one quantity slot, serialized refresh, checkout reuse, exact
  amounts, bank-verification states, and lost order/payment responses.
- Type checking, lint, formatting, release generation checks, four release-tooling
  tests, and macOS arm64 standalone/installer checks passed locally. Installer
  checks cover 12 piped cases plus real-archive installation and MCP protocol.
  Hosted CI and the other operating-system/architecture combinations were not run.

Direct saved-card charging, active-order tracker transitions, delivery-order
pricing, and long-term session renewal still need live validation. The user
explicitly deferred any completed order or payment; only an unpaid test checkout
was initialized. Its session has a short expiry and must not be reused for a
later purchase without a fresh reviewed quote and explicit confirmation.
Bank-verification / 3-D Secure continuation is not implemented: such payments
stop at `requires_action` and must not be retried. Apple Pay, adding cards, and
scheduled ordering are also outside this preview. It is not an end-to-end
verified ordering integration yet.

Public source examined:
[client.fc1fe2beaeda44dfcea3.js](https://www.dominos.is/build/client.fc1fe2beaeda44dfcea3.js),
SHA-256 `a2417891d708f8e5f60531ec3f9c398f9c4af602c370b02d715ccc30ca4b8a71`.
Useful source symbols are `fetchLoginData`, `fetchUserInfo`, `setUser`,
`setSavedCards`, `setVisibility`, `fetchSendOrder`, and `renderSavedCards`.
