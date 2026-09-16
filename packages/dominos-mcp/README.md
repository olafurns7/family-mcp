# dominos-mcp

Unofficial Domino’s Iceland MCP: SMS sign-in, menu discovery, pickup and delivery
quotes, receipts, tracking, and saved-card checkout through Domino’s Adyen sessions.
This is a **preview release** (`dominos-mcp@0.1.0`).

Live checks verified SMS login, token refresh, profile and receipts, the tracker’s
no-active-order response, menu/address lookup, a 2,490 ISK quote, and an unpaid
checkout returning a saved Visa from Adyen. No payment request was sent.
Offline tests cover MCP schemas, checkout amounts, and duplicate payment prevention.
Charging a card still needs live validation with an explicitly approved purchase.
Bank verification / 3-D Secure continuation is not implemented: a payment needing
it stops at `requires_action`. Do not treat this preview as fully verified ordering.

## Install and sign in

Install the standalone executable for macOS or glibc Linux, arm64/x64:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/dominos-mcp@0.1.0/packages/dominos-mcp/install.sh | sh
dominos-mcp auth login
dominos-mcp auth status
```

The installer verifies the checksum and places the command in `~/.local/bin`.
Upgrading replaces the command; restart the MCP host, or rerun with `--stop-running`.

Enter a seven-digit Icelandic phone number (or `+354` prefix), then the six-digit
SMS code in the terminal. Both inputs are hidden. Expected success starts with
`Signed in. Session saved to`. No API key, iPhone proxy, or trusted certificate is
needed. Foreign phone numbers and Auðkenni login are not supported.

The compiled executable runs without Bun or Node. Use its absolute path in the
MCP host, for example:

```json
{
  "mcpServers": {
    "dominos": {
      "command": "/absolute/path/to/.local/bin/dominos-mcp",
      "args": ["serve"]
    }
  }
}
```

For Codex:

```toml
[mcp_servers.dominos]
command = "/absolute/path/to/.local/bin/dominos-mcp"
args = ["serve"]
```

## Tools

| Tool                 | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `auth_status`        | Verify the local session; refresh tokens when needed.                      |
| `get_profile`        | Profile, saved addresses, and saved-order names.                           |
| `list_stores`        | Store IDs, opening hours, acceptance, and wait estimates.                  |
| `search_menu`        | Search pizzas, sides, sauces, drinks, and offers; follow `nextOffset`.     |
| `get_menu_item`      | Prices, sizes, crusts, toppings, allergens, availability, and offer slots. |
| `search_addresses`   | Find an address for delivery.                                              |
| `get_delivery_store` | Resolve its delivery store and wait estimate.                              |
| `list_receipts`      | Receipt IDs, dates, and amounts.                                           |
| `get_tracker`        | Active order state and remaining time.                                     |
| `quote_order`        | Validate a cart and obtain its server price; saves a five-minute quote.    |
| `create_checkout`    | Create an unpaid order and retrieve masked saved cards.                    |
| `get_checkout`       | Inspect a checkout and reconcile an attempted payment when possible.       |
| `pay_saved_card`     | Charge a selected saved card after explicit approval.                      |

## Ordering

1. Discover current IDs using `list_stores`, `search_menu`, and `get_menu_item`.
2. Call `quote_order` with the exact cart. All exposed amounts are **whole ISK**.
3. Review the items, delivery address or pickup store, instructions, and total.
4. Call `create_checkout` with the quote ID and `expectedTotal`. This creates an
   unpaid order and returns card aliases, brands, last four digits, and expiry.
5. Obtain explicit user approval of that order, amount, and chosen card. Only then
   call `pay_saved_card` with the checkout ID, card alias, `expectedTotal`, and
   `confirm: true`.
6. Use `get_checkout` for payment reconciliation and `get_tracker` for preparation.

For a pizza, pass `sizeId`, `crustId`, and one section containing `pizzaId`; use two
sections for half-and-half. A topping modification's `quantity` is its desired
total: `0` removes it, `1` selects a normal portion, and `2` selects double where
allowed. Offer contents require their returned `packageItemId` slots. Tool schemas
describe delivery addresses, drinks, side extras, coupons, and quantities.

Repeated `create_checkout` calls for one quote reuse its checkout. A checkout
permits one payment attempt, recorded on disk **before** the request is sent.
Amounts must match the quote, Domino’s response, and Adyen's ISK minor units.
Changed amounts block payment. A timeout, crash, `pending`, `unknown`, or
`requires_action` result is not proof of failure: reconcile the existing order
before considering another. Never delete a checkout file to permit a retry.

`authorised` means payment authorization; it does not prove preparation or delivery.
Apple Pay, adding cards, scheduled orders, and bank-verification continuation are
not provided. Saved cards are available through checkout, not a standalone wallet.

## Private files

The default session is `~/.config/dominos-mcp/session.json` (`XDG_CONFIG_HOME` is
honored). Set `DOMINOS_SESSION_FILE` consistently for login and the MCP host to
override it. Quotes and checkout records live beside it in `session.json.checkouts/`.
Files are private (0600), with owner-controlled directories and shared locking.

`auth logout` removes the local login. Checkout records remain to prevent an
ambiguous payment from being replayed after signing in again. Local logout does
not revoke an upstream token. Keep this directory out of cloud shares and repos.

MCP results omit access/refresh tokens, payment-session data, and saved-card vault
tokens. Profile details, addresses, receipts, and masked cards **are** shared with
the configured MCP host. Treat merchant-provided text as untrusted data.

## Development

From the repository root, using Bun 1.4.2:

```sh
bun install --frozen-lockfile
bunx turbo run check test release:check --filter=dominos-mcp
bunx turbo run test:binary test:installer --filter=dominos-mcp
```

The native build is `packages/dominos-mcp/release/native/dominos-mcp`.
Tests use synthetic responses and never contact Domino’s or Adyen. Live account
validation is a separate manual step; never make a purchase as an automated test.
Endpoint evidence and remaining uncertainties are in the
[investigation](../../docs/analysis/dominos-mcp-feasibility.md). See
[releasing](docs/RELEASING.md) for the native release process.
