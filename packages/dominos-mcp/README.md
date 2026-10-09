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
SMS code in the terminal. Both inputs are hidden. Expected success is
`Signed in. Session saved encrypted.` No API key, iPhone proxy, or trusted certificate is
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

For Claude Code:

```sh
claude mcp add dominos -- /absolute/path/to/.local/bin/dominos-mcp serve
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

### Where the session is saved

The session (access and rotating refresh tokens) is saved only as an encrypted
record (AES-256-GCM), `~/.config/dominos-mcp/session.enc`, with a non-secret
`session.enc.marker` beside it. The record's 256-bit key is created on the first
`auth login` or `auth migrate`. It is never regenerated, except when the key is
gone and you run `dominos-mcp auth login` again:

- **macOS:** a login-keychain item (service `family-mcp.dominos-mcp`, account
  `default.data-key`), read through Apple's `/usr/bin/security`.
- **Linux:** a `0600` file in its own `0700` directory,
  `~/.local/share/family-mcp/keys/dominos-mcp.default.key`.

When `XDG_CONFIG_HOME` or `XDG_DATA_HOME` is set, it replaces `~/.config` or
`~/.local/share`; set the same values for login and the MCP host. Token refreshes
rewrite the record under a lock, so two MCP hosts never use one refresh token twice.
If a refreshed session cannot be saved, the old record is discarded, since Domino’s
has already spent its refresh token; the next command reports that the last write
did not complete.

`dominos-mcp auth status` names where the session is saved and verifies it.
`dominos-mcp auth logout` forgets the session on this computer; the key and the
record stay. Local logout does not revoke an upstream token.

What this protects against: tokens showing up in `cat`, `grep`, agent file reads,
commits, dotfile sync, or backups of `~/.config`. What it does not: anything that
can read both the record and its key, such as another process of your user, an
agent with a shell, root, or a full-home backup. On macOS any process of your user
can read the key with `security` while the login keychain is unlocked. Against
those it is the same as a `0600` file.

### Upgrading from 0.1.0

Version 0.1.0 saved the session in a plaintext file,
`~/.config/dominos-mcp/session.json` or `DOMINOS_SESSION_FILE`. That file keeps
working, refreshes included, until you migrate, and `auth status` says so. Stop
running `dominos-mcp` servers, then run:

```sh
dominos-mcp auth migrate
```

It reads the file, saves the encrypted record, reads it back, and removes the
plaintext file. Running it again says `Already migrated.` and removes a leftover
plaintext file. After migration the plaintext file is never read again; `auth
login` also removes it. Going back to 0.1.0 means signing in again in that version.

### Quotes and checkouts

Quotes and checkout records stay in `session.json.checkouts/` beside the
plaintext session path (`DOMINOS_SESSION_FILE` or its default), whether or not the
session was migrated; keep that variable consistent for login and the MCP host.
They hold order IDs and Adyen session data, not tokens, as private (0600) files
with locking. Login, migrate and logout never touch them, so an ambiguous payment
cannot be replayed after signing in again. Neither `DOMINOS_SESSION_FILE` nor its
`.checkouts` directory may lie inside, around, or beside the encrypted store or its
key under a shared name; login, migrate and logout refuse such a path. Keep these
directories out of cloud shares and repos.

### Store errors

| Message                               | Action                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved in a plaintext file             | Run `dominos-mcp auth migrate`.                                                                                                                                                       |
| Unlock your login keychain            | macOS: unlock the login keychain, then retry.                                                                                                                                         |
| The Domino’s store key is missing     | The key was deleted. The record cannot be decrypted; `dominos-mcp auth login` replaces it with a new key and record.                                                                  |
| The last write … did not complete     | An interrupted write, or a refreshed session that could not be saved, left `session.enc` and `session.enc.marker` inconsistent. Remove both files, then run `dominos-mcp auth login`. |
| Cannot use the Domino’s session store | The record, marker, or key is damaged, unsafe, or from another key. Nothing is reset automatically; restore the key, or remove the record and marker and sign in.                     |

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
