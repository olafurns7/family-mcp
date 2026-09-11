# Direct InfoMentor access: investigation and recommendation

Investigated on 11 September 2026. Scope: the Icelandic InfoMentor parent site,
this MCP package, and one authorized Grok Bot VM. No passwords, session cookies,
message contents, or pupil names are included in these results.

## Recommendation

Keep the MCP as a direct HTTPS client. It already works without a proxy from the
tested Mac. Direct access from the Grok VM remains unresolved after controlled
route and TLS compatibility tests. Those tests establish a route-dependent
TLS failure, but do not identify the responsible network component.

Provider-side traces are unavailable and are not a prerequisite for using or
developing the MCP. Within the controls tested here, there is no demonstrated
code-only repair for the VM. The practical choices are to keep the existing
working route, run the MCP directly on a reachable host, or trial a managed
outbound VPN on the VM to remove the dependency on a user-operated exit node.
The last option still uses another network provider and is not proxy-free.
It has not been installed or proven to work with InfoMentor.

No tested TLS setting justified a transport change. A different HTTP User-Agent
or automatic retry has no demonstrated benefit for this pre-HTTP failure. The
current working exit-node configuration was preserved during investigation.

## Controlled measurements

Both `im1.infomentor.is` (sign-in) and `minn.infomentor.is` (parent data) resolved
to `213.180.87.183`. The public marketing site, `www.infomentor.is`, resolved to
`213.180.76.16`. Success on the marketing site alone therefore does not prove
the authentication/data service is reachable.

The first comparison ran from the same VM, with the same Python/OpenSSL client,
certificate verification enabled, HTTP/1.1 ALPN, and pinned destination IPs.
Only the route changed. The normal-route probes used Tailscale's existing
bypass routing rule on individual test sockets; the VM's global routes and
exit-node setting were not changed. Requests were anonymous.

| Destination                            | VM normal route                                            | VM exit-node route                                         |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `im1.infomentor.is`, `213.180.87.183`  | TCP connected; TLS ended with unexpected EOF after 5.015 s | Verified TLS 1.2; HTTP 200 sign-in page                    |
| `minn.infomentor.is`, `213.180.87.183` | TCP connected; TLS ended with unexpected EOF after 5.017 s | Verified TLS 1.2; HTTP 302                                 |
| `www.infomentor.is`, `213.180.76.16`   | Verified TLS 1.3; HTTP 200                                 | Verified TLS 1.3; HTTP 200                                 |
| `im1.infomentor.is`, forced TLS 1.2    | TLS ended with unexpected EOF after 5.017 s                | Not repeated in this row; default negotiated TLS 1.2 above |

A second comparison separated initial TCP timing from TLS completion and varied
SNI on the same destination. Both tested names are covered by the server's
wildcard certificate; certificate validation remained enabled.

| Route     | Destination IP   | SNI                 | TCP setup | TLS result / total time     |
| --------- | ---------------- | ------------------- | --------- | --------------------------- |
| Normal    | `213.180.87.183` | `im1.infomentor.is` | 15 ms     | EOF / 5,021 ms              |
| Normal    | `213.180.87.183` | `www.infomentor.is` | 16 ms     | EOF / 5,022 ms              |
| Normal    | `213.180.76.16`  | `www.infomentor.is` | 17 ms     | Verified TLS 1.3 / 447 ms   |
| Exit node | `213.180.87.183` | `im1.infomentor.is` | 367 ms    | Verified TLS 1.2 / 1,023 ms |
| Exit node | `213.180.87.183` | `www.infomentor.is` | 294 ms    | Verified TLS 1.2 / 931 ms   |
| Exit node | `213.180.76.16`  | `www.infomentor.is` | 342 ms    | Verified TLS 1.3 / 687 ms   |

The repeated approximately five-second closure and short initial TCP setup are
consistent with an intermediary accepting a connection before an upstream
failure. This is a hypothesis, not identification of a particular proxy or
firewall. The socket measurements do not reveal which hop generated the EOF.
The SNI comparison also does not establish that every possible TLS fingerprint
has been tested.

Five additional normal-route profiles all closed with the same TLS EOF after
5.019–5.027 seconds: default TLS without ALPN; TLS 1.2 without ALPN; TLS 1.2
restricted to the server's working AES-128-GCM cipher; TLS 1.2 with the P-256
curve; and TLS 1.2 restricted to AES-256-GCM. Certificate and hostname validation
stayed enabled. These tests found no usable compatibility setting to ship.

Independent anonymous Mac checks succeeded with Node 24.12.0, Bun 1.4.2, and
curl. The authentication host presented a valid wildcard certificate and
negotiated TLS 1.2. Both Bun's default User-Agent and a Safari-style User-Agent
received the sign-in form on that working route. Those checks establish that
these clients can communicate with the service; they do not establish the
reason the VM route fails.

## What the evidence rules out, and what remains open

| Explanation                                                                     | Assessment                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP login, form fields, cookie serialization, message parsing                   | Cannot explain an anonymous TLS failure before HTTP. The earlier empty-cookie saving bug is separately fixed in 0.2.2.                                                                                                                                                                              |
| Different DNS answers between the two routes                                    | Excluded for the controlled comparison: both routes used the same pinned destination IP.                                                                                                                                                                                                            |
| HTTP User-Agent rejection                                                       | Cannot explain that pre-HTTP failure. An ordinary fresh TLS handshake precedes HTTP application data; User-Agent is an HTTP field. See [TLS 1.3 protocol overview](https://www.rfc-editor.org/rfc/rfc8446#section-2) and [HTTP User-Agent](https://www.rfc-editor.org/rfc/rfc9110#name-user-agent). |
| A missing trusted root certificate                                              | No certificate was received on the failing route. The same client verified the server on the working route. Disabling certificate validation has no demonstrated benefit.                                                                                                                           |
| TLS 1.3 negotiation alone                                                       | Forcing TLS 1.2 did not fix the VM route.                                                                                                                                                                                                                                                           |
| A filter based only on the tested SNI names                                     | Changing SNI while keeping the authentication IP did not restore TLS.                                                                                                                                                                                                                               |
| Shared datacenter source IP blocked downstream                                  | Plausible, not proven. Grok's [security FAQ](https://docs.x.ai/grok-bot/security-faq) acknowledges that some destinations flag datacenter addresses.                                                                                                                                                |
| Hosted network gateway, TLS inspection, routing, or upstream reachability issue | Plausible, not proven. Needs hosting-side connection evidence.                                                                                                                                                                                                                                      |

No ordinary `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` environment variable was
present in the inspected VM shell, including lowercase variants. That does not
exclude transparent infrastructure outside the VM. No packet capture or
provider firewall logs were collected, and no security policy was disabled.

## Options against the preference for no proxy

| Option                                                   | Proxy-free on the Grok VM?            | Assessment                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repair the normal hosted path                            | Yes, if successful                    | Theoretical resolution; provider-side traces are unavailable, so this is not the current action plan.                                                                                      |
| InfoMentor approves the hosting provider's source ranges | Yes, if source filtering is the cause | Conditional on operator confirmation and approval, neither available here.                                                                                                                 |
| Alternate supported InfoMentor parent API                | Possibly                              | No independent, documented Icelandic parent API with verified equivalent authentication and data was found. Do not replace working endpoints with a guessed host.                          |
| Run this MCP on a computer whose normal connection works | Direct from that computer             | Already demonstrated on the Mac, but a cloud-only agent still needs a supported way to invoke that local MCP and the computer must be available.                                           |
| Grok's optional desktop egress setting                   | No                                    | The installed desktop bundle labels it “Route egress through this desktop.” It still depends on the desktop and its network. Availability and live operation were not verified or changed. |
| Tailscale exit node or app connector                     | No                                    | A working workaround, with another machine remaining in the route. A narrower app connector can limit routed destinations but still requires a connector host.                             |
| Cloudflare Tunnel to a private MCP                       | No for this requirement               | Exposes or connects to a service elsewhere; it does not repair the VM's direct connection to InfoMentor.                                                                                   |
| Managed outbound VPN on the VM                           | No                                    | Can remove the user-operated exit-node dependency. Compatibility with this VM and InfoMentor remains untested.                                                                             |

Grok documents shared static outbound IP ranges, no dedicated customer IPs, and
destination controls rather than a source-IP selector. It directs customers to
their account team for current ranges. There is no documented source-IP setting
the MCP can select to repair this connection.
[Grok security documentation](https://docs.x.ai/grok-bot/security).

Grok's [settings documentation](https://docs.x.ai/grok-bot/settings-and-notifications)
mentions optional egress controls depending on rollout. The desktop-specific
interpretation above comes from the installed application's own setting label,
not a successful live test. Its [private networking guide](https://docs.x.ai/grok-bot/private-networks)
describes customer-operated network clients. Tailscale's
[exit-node documentation](https://tailscale.com/docs/features/exit-nodes) and
[app-connector documentation](https://tailscale.com/docs/features/app-connectors)
describe the remaining routing dependency.

InfoMentor's official Icelandic [parent handbook](https://www.infomentor.is/wp-content/uploads/2024/03/Handbok-fyrir-adstandendur_september_23_2.pdf)
describes the app as a way into the parent service and advises parents to start
with their school for help. Its public documentation did not establish an
alternate API that would avoid this network path. This is a search limitation,
not proof that no private or partner API exists.

Cloudflare documents a [Linux WARP client](https://developers.cloudflare.com/warp-client/get-started/linux/)
that tunnels from the machine to Cloudflare without a user-operated exit host.
Its [mode documentation](https://developers.cloudflare.com/warp-client/warp-modes/)
distinguishes traffic tunneling from DNS-only mode; changing DNS alone would not
address the pinned-IP failure above. WARP is a candidate fallback, not a verified
recommendation for this VM. A trial would need to preserve SSH/Tailscale access
and compare anonymous TLS results before using the existing InfoMentor session.

## Message and notification tools

These are implemented in the MCP package and reuse its existing authenticated
HTTP transport, cookie jar, cancellation, account queue, and response validation.
No remote helper or proxy is part of their implementation.

| MCP tool                       | Verified read endpoint                     | Behavior                                                              |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------------- |
| `infomentor_get_messages`      | `/Message/message/GetMessages`             | Inbox/sent filters, text search, page and page size.                  |
| `infomentor_get_message`       | `/Message/message/GetMessage`              | Numeric message ID; plain-text body and participants.                 |
| `infomentor_get_notifications` | `/NotificationApp/NotificationApp/appData` | Current notification feed with original states and pupil association. |

The live site's [published application script](https://minn.infomentor.is/dist/scripts/scripts.js)
identifies separate mutation endpoints for marking messages viewed and changing
notification states. The package never calls those endpoints. Reads use form
POSTs accepted by the live service; JSON transport was unnecessary.

Live structural probes verified a populated message list, a full detail,
page-two exhaustion, an unmatched search, and an empty sent folder. The server
honored paging but reported `page: 0`; the MCP reports the requested 1-based
page and preserves the server's `more` flag. A populated sent folder and a
multi-page account have not been verified live.

The notification bootstrap embedded in the parent HTML was empty while the
notification app endpoint returned a populated feed. The tool therefore reads
the latter. Original `Seen` and `Read` states were observed; these are kept
distinct. No complete-history guarantee is inferred from the available feed.

Message read state was compared before and after a detail fetch and was
unchanged. Dedicated live coverage of a previously unread message was not
recorded. The explicit absence
of the site's separate viewed-state request is additionally checked in the
synthetic MCP integration test with an unread message. New/Cleared notification
filtering is also covered synthetically rather than claimed as live evidence.

A live MCP handshake with the built server exposed all nine tools. Calls through
MCP validated message listing, a message detail, the notification feed, and its
selected-child filter. Repeated reads preserved the observed message and
notification states. This live check used the VM's existing working exit route;
it is functional proof of the new tools, not proof of direct VM connectivity.
