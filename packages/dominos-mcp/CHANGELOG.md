# Changelog

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
