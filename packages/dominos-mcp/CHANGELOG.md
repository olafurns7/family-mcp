# Changelog

## 0.2.0

- Builds the native executable from Rust with rustls and locked dependencies.
  Installed hosts need neither Bun nor Node.
- Retains the 13 tools, their descriptions and schemas, and the quote/confirm
  flow. Synthetic tests compare CLI, tool results and upstream requests with
  the retained TypeScript reference.
- Implements hidden SMS sign-in and token rotation through the encrypted
  family-store, with session and quote/checkout records readable by both ports.
  Existing plaintext sessions keep their legacy refresh path until
  `dominos-mcp auth migrate`; new sign-ins save encrypted sessions.
- Saves checkout and payment intent before sending. Offline tests cover
  concurrent confirmations, mismatched amounts, lost responses, failed
  persistence, process termination and restart without replaying a payment.
- The Rust port has not been checked against a live account or used to charge
  a card. Bank verification / 3-D Secure continuation still stops at
  `requires_action`.

## 0.1.0

- First preview release of the unofficial Domino’s Iceland MCP server.
- Adds terminal SMS login, private session storage, and token refresh.
- Exposes 13 tools for menu and store discovery, pickup and delivery quotes,
  profiles, receipts, tracking, unpaid checkout, and confirmed saved-card payment.
- Checks payment amounts against the quote and payment session, and records one
  payment attempt per checkout to prevent duplicate submission across restarts.
- Distributes standalone macOS and glibc Linux executables for arm64 and x64,
  with SHA-256 checksums and an installer.
- Live checks verified login, refresh, account reads, menu and address lookup,
  quotes, and saved-card retrieval from an unpaid Adyen checkout.
- Card charging remains untested; no purchase was made. Bank verification / 3-D
  Secure continuation is not implemented and stops at `requires_action`.
