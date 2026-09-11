# Direct InfoMentor access: investigation and recommendation

Investigated on 11 September 2026. Scope: the Icelandic InfoMentor parent site,
this MCP package, and one authorized Grok Bot VM. No passwords, session cookies,
message contents, or pupil names are included in these results.

## Recommendation

The existing Grok Bot VM can run this MCP without a user-operated Tailscale
exit node: **Cloudflare WARP in local proxy mode passed a live test with the
published 0.3.0 executable.** Authentication, overview, message listing, message
details, and notifications all worked. The MCP used only the standard
`HTTPS_PROXY` environment setting; no transport code or dependency was added.

WARP remains a managed network intermediary, so this is not a proxy-free result.
The VM's normal TCP route still fails before HTTP. A proxy-free repair was not
found, and neither rebuilding the VM nor obtaining provider-side traces is part
of the solution. The MCP already works directly from the tested Mac.

The successful WARP test used the VM's normal interface for its tunnel, with
certificate validation enabled for InfoMentor. Temporary routing rules made
that path independent of the configured exit node. Test processes, routing
rules, and the temporary WARP registration were removed afterward. The optional
installer's setup component was subsequently installed with authorization on the
same VM. Its persistent daemon and automatic restart passed live MCP checks.

No tested TLS setting justified a transport change. A different HTTP User-Agent
or automatic retry has no demonstrated benefit for this pre-HTTP failure.

## Verified WARP configuration

Version 0.4.0 adds an optional `install.sh --with-warp` setup for Debian 13/x64.
It installs the verified headless client under `/opt/infomentor-warp`, with only
its daemon libraries; the desktop GUI and browser libraries are not installed.
The installed MCP command starts a healthy local proxy when needed and sets the
proxy environment for its own process. Regular installer upgrades preserve the
choice; `--without-warp` restores the direct MCP command without uninstalling WARP.

The root helper is installed at `/usr/local/libexec/infomentor-warp`. On systemd
hosts it enables `infomentor-warp.service`; on the tested Grok VM it starts the
daemon independently of the SSH session and the MCP launcher restarts it on the
next launch when needed. That restart requires the VM's existing noninteractive sudo access.
The installer does not grant new sudo permissions or change existing WARP
installations. Network preparation adds narrow main-table rules for WARP's proxy
endpoint range and resolved registration API addresses, preserving the global
default route and Tailscale settings.

The persistent setup was tested with the published 0.3.0 binary behind the new
launcher, with no proxy setting supplied by the MCP test client. All nine tools
were listed and session verification, overview, messages, message detail, and
notifications passed. An initial restart exposed a healthy-tunnel status before
the MCP's first request could succeed. Ordinary restarts now reuse the saved
configuration and wait for verified HTTPS to both InfoMentor hosts. After
stopping the owned daemon and removing its three routing rules, the launcher
restored them and all these MCP reads passed with empty standard error.
This validates daemon recovery on the existing VM, not a VM reboot. The systemd
branch is provided for Debian hosts using systemd; live validation here covers
the Grok VM's non-systemd branch.

The tested client was Cloudflare WARP 2026.7.1377.0 for Debian 13, using MASQUE
and a loopback proxy on port 18443. The tunnel connected over the VM's native
interface to `162.159.198.2:500` using QUIC. Its log identified Cloudflare's EWR
location. A tunneled Cloudflare trace returned `warp=on`.

Anonymous InfoMentor requests succeeded through both SOCKS5 and HTTP CONNECT.
The latter is supported by the standalone MCP's embedded Bun runtime:

```sh
# Requires a running WARP daemon and a registered device.
warp-cli mode proxy
warp-cli proxy port 18443
warp-cli connect

# Set this in the environment of this MCP process only.
HTTPS_PROXY=http://127.0.0.1:18443 infomentor-mcp
```

These are the relevant application settings, not a complete daemon installation
procedure. Follow the [official Linux client setup](https://developers.cloudflare.com/warp-client/get-started/linux/)
for installation and registration. This Grok VM does not run systemd, so a
persistent setup must also arrange the daemon's lifecycle on that existing VM.
[WARP local proxy mode](https://developers.cloudflare.com/warp-client/warp-modes/#local-proxy)
limits tunneled application traffic to clients configured to use it.
[Bun documents `HTTPS_PROXY` support](https://bun.com/guides/http/proxy).
The npm/Node executable's proxy-environment behavior was not tested here.

The final test downloaded the public Linux x64 release, verified its SHA-256,
then exercised it through MCP with the existing session file. All nine tools
were listed; authenticated overview and all three new data tools passed their
output schemas. Observed message read states stayed unchanged. This was saved
session reuse, not a fresh password login through WARP.

The route check matters: an earlier tunnel initially used the exit node and was
excluded as proof of independence. The accepted run explicitly routed WARP's
actual proxy endpoint range, `162.159.198.0/24`, through the VM's native gateway.
The final run also routed the resolved registration API addresses that way.
The tunnel log confirmed the native source interface. The VM's global default
route, Tailscale exit-node setting, installed MCP command, and session file were
preserved. No VM rebuild, reset, or restart was performed.

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

The initial timing suggested an intermediary. Later tests established that one
is present: native TCP connections succeeded with an IP TTL of one, and packet
metadata showed a roughly 0.3 ms connection setup followed by acknowledgments
with no TLS response payload and a closure around five seconds later. Delaying
ClientHello by two seconds produced a plaintext HTTP 400 response with
`Server: Pingora`, even though the socket targeted the HTTPS port. This identifies
an intermediary in the observed path; it does not prove which upstream component
caused the original handshake failure.

The VM's existing root service environment contained
`SAND_HTTP_PROXY_NAME=bd-isp-shared-unlimited-us`. This is evidence of a selected
shared proxy path, despite the lack of ordinary shell proxy variables. No
supported control for changing that selection on this existing VM was found.
Setting a similarly named environment variable in the MCP would not establish
that the infrastructure's proxy selection had changed.

Five additional normal-route profiles all closed with the same TLS EOF after
5.019–5.027 seconds: default TLS without ALPN; TLS 1.2 without ALPN; TLS 1.2
restricted to the server's working AES-128-GCM cipher; TLS 1.2 with the P-256
curve; and TLS 1.2 restricted to AES-256-GCM. Certificate and hostname validation
stayed enabled. These tests found no usable compatibility setting to ship.

Reducing TCP maximum segment size to 1200, 1000, and 536 bytes did not fix the
failure. A fresh sandboxed Google Chrome profile also received connection-closed
errors on the native route before any TLS response bytes; a public TLS control
site worked. Splitting ClientHello across TCP writes or TLS records did not
restore the connection. These results cover several concrete compatibility
hypotheses, not every possible TLS fingerprint.

Independent anonymous probes from New York, Nuremberg, and Stockholm all
received HTTP 200 from the same authentication IP. This rules out a blanket
outside-Iceland restriction for those locations, while leaving filtering of
particular source networks possible.
[Public three-location result](https://check-host.net/check-report/4b0b3333k1e3).

Independent anonymous Mac checks succeeded with Node 24.12.0, Bun 1.4.2, and
curl. The authentication host presented a valid wildcard certificate and
negotiated TLS 1.2. Both Bun's default User-Agent and a Safari-style User-Agent
received the sign-in form on that working route. Those checks establish that
these clients can communicate with the service; they do not establish the
reason the VM route fails.

## What the evidence rules out, and what remains open

| Explanation                                                   | Assessment                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP login, form fields, cookie serialization, message parsing | Cannot explain an anonymous TLS failure before HTTP. The earlier empty-cookie saving bug is separately fixed in 0.2.2.                                                                                                                                                                              |
| Different DNS answers between the two routes                  | Excluded for the controlled comparison: both routes used the same pinned destination IP.                                                                                                                                                                                                            |
| HTTP User-Agent rejection                                     | Cannot explain that pre-HTTP failure. An ordinary fresh TLS handshake precedes HTTP application data; User-Agent is an HTTP field. See [TLS 1.3 protocol overview](https://www.rfc-editor.org/rfc/rfc8446#section-2) and [HTTP User-Agent](https://www.rfc-editor.org/rfc/rfc9110#name-user-agent). |
| A missing trusted root certificate                            | No certificate was received on the failing route. The same client verified the server on the working route. Disabling certificate validation has no demonstrated benefit.                                                                                                                           |
| TLS 1.3 negotiation alone                                     | Forcing TLS 1.2 did not fix the VM route.                                                                                                                                                                                                                                                           |
| A filter based only on the tested SNI names                   | Changing SNI while keeping the authentication IP did not restore TLS.                                                                                                                                                                                                                               |
| Shared datacenter source IP blocked downstream                | Plausible, not proven. Grok's [security FAQ](https://docs.x.ai/grok-bot/security-faq) acknowledges that some destinations flag datacenter addresses.                                                                                                                                                |
| Intermediary on the hosted normal path                        | Established by TTL/timing, a Pingora HTTP response, and the proxy-selection environment value. The failing upstream component and reason remain unknown.                                                                                                                                            |
| Blanket restriction on access outside Iceland                 | Excluded for the three independent US, German, and Swedish probes, which all returned HTTP 200.                                                                                                                                                                                                     |

No ordinary `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` environment variable was
present in the inspected VM shell, including lowercase variants. The service
environment and packet metadata establish an intermediary despite that absence.
The leaf certificate on working routes matched, with no observed replacement
certificate. Provider firewall logs were unavailable; no security policy was
disabled.

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
| WARP local proxy on the existing VM                      | No                                    | Verified with the public 0.3.0 MCP binary through the native VM interface. Persistent setup and recovery through the new launcher also passed.                                             |

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

Changing DNS alone would not address the pinned-IP failure above. A native WARP
tunnel was verified instead. Its presence does not identify the original
provider-side fault, but it supplies an independently tested connection option
on the existing machine.

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
notification states. That first live check used the existing exit route.
A subsequent test with the published standalone executable validated the same
three tools and the overview through native-interface WARP, as described above.
