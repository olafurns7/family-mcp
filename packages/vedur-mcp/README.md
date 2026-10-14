# vedur-mcp

Read-only Icelandic weather MCP for data from Veðurstofa Íslands (the Icelandic
Meteorological Office, IMO): station search, point forecasts, the latest
observations, official weather warnings, and the duty forecasters' commentary.
No account, key, or saved session is needed. This is a **preview**
(`vedur-mcp@0.1.0`); it is not affiliated with or endorsed by IMO.

## Install

Install the standalone executable for macOS or Linux, arm64/x64:

```sh
curl -fsSL https://raw.githubusercontent.com/olafurns7/family-mcp/vedur-mcp@0.1.0/packages/vedur-mcp/install.sh | sh
vedur-mcp --version
```

The installer verifies the checksum and places the command in `~/.local/bin`.
Upgrading replaces the command; restart the MCP host, or rerun with `--stop-running`.

Use the absolute path in the MCP host, for example:

```json
{
  "mcpServers": {
    "vedur": {
      "command": "/absolute/path/to/.local/bin/vedur-mcp",
      "args": ["serve"]
    }
  }
}
```

For Claude Code:

```sh
claude mcp add vedur -- /absolute/path/to/.local/bin/vedur-mcp serve
```

For Codex:

```toml
[mcp_servers.vedur]
command = "/absolute/path/to/.local/bin/vedur-mcp"
args = ["serve"]
```

## Tools

Every tool is annotated read-only. Every result carries `source` (provider,
dataset, API kind, and URLs), `fetched_at` (UTC, when the data was read from
IMO), `cached`, and an `attribution` line to quote with the data. Provider
timestamps and units are kept as given.

| Tool                 | Input                                     | Returns                                                                                                   |
| -------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `search_stations`    | `query` (1–100 characters), `active`      | Up to 50 IMO measuring stations: id, type, coordinates, elevation, owner.                                 |
| `get_forecast`       | `station_id`, `days` (1–10, default all)  | Daily summaries and the forecast steps as given (1, 3, or 6 hours apart), with `step_hours` and units.    |
| `get_observations`   | `station_id`                              | The latest automatic-station hour, or the latest manned synop report; `null` values stay `null`.          |
| `get_weather_alerts` | `area_id` (1–99), `language` (`is`, `en`) | Official current and upcoming CAP weather warnings: validity, status, severity, colour, text, area names. |
| `get_weather_watch`  | `limit` (1–20, default 5)                 | Newest Veðurvakt posts from the vaktin feed as plain text (at most 2,000 characters each).                |

Start with `search_stations` (for example `Reykjavík`; station `1` is Reykjavík)
and pass the id to `get_forecast` or `get_observations`. `active: false` lists
only decommissioned stations. Station search covers IMO measuring stations: a
forecast place that is not found there may still exist on gottvedur.is.

`get_weather_alerts` filters to the IMO warning areas: 1 Höfuðborgarsvæðið,
2 Suðurland, 3 Faxaflói, 4 Breiðafjörður, 5 Vestfirðir, 6 Strandir og
norðurland vestra, 7 Norðurland eystra, 8 Austurland að Glettingi, 9 Austfirðir,
10 Suðausturland, 11 Miðhálendi. The feed also contains other ids, including
21–23 for Geo warnings; unfamiliar ids are accepted. Only category `Met`
(weather) is returned. Other category strings, including unfamiliar ones, are
counted in `other_categories_skipped`. These are not gottvedur.is forecast-region ids,
which are a different numbering. Warnings default to IMO's Icelandic text;
`language: "en"` selects the English text.

## Data sources

| Tool                 | Source                                                                                                                                         | Kind                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `search_stations`    | `https://api.vedur.is/weather/stations`                                                                                                        | Documented IMO Weather API (OpenAPI, CC BY 4.0)         |
| `get_forecast`       | `https://gottvedur.is/api/forecasts/station/?stationId=…`                                                                                      | The gottvedur.is site's internal JSON API (unversioned) |
| `get_observations`   | `https://api.vedur.is/weather/observations/aws/hour/latest`, then `https://api.vedur.is/weather/observations/synop/latest` when it has no data | Documented IMO Weather API (OpenAPI, CC BY 4.0)         |
| `get_weather_alerts` | `https://api.vedur.is/cap/capbroker/active/detailed/all`                                                                                       | Documented IMO CAP API (OpenAPI, CC BY 4.0)             |
| `get_weather_watch`  | `https://gottvedur.is/rss.xml/vaktin/`                                                                                                         | gottvedur.is RSS feed, editorial                        |

**Internal API caveat.** The forecast comes from the API behind the gottvedur.is
website, which IMO operates but does not document or version. It may change
without notice. When its shape changes, `get_forecast` returns an error; it never
switches silently to another source. Its times have no UTC offset (Iceland keeps
UTC all year, but the API does not state the zone), and the source does not
document how precipitation is aggregated per step or per day.

Warning `references` is null or bounded plain text: upstream strings are cleaned
and limited to 2,000 characters; an object becomes its identifier (at most 200
characters), followed by its `sent` time in parentheses when present (at most
40 characters). The raw reference object, sender, source and polygon are never returned.

**Warnings and commentary.** Each unreadable warning is skipped and counted in
`unreadable`. Counts (`unreadable`, `expired_skipped`, `other_categories_skipped`)
cover the entire feed, before the area filter. When `unreadable` is greater than
zero, the summary says how many warnings could not be read and points to
<https://gottvedur.is/vidvaranir/>, even if readable warnings are listed. An unreadable
item may belong to the requested area: an empty partial result does not mean
that area is clear. Only a complete read (`unreadable: 0`) can say “No active or
upcoming IMO weather warnings”, with the time it was checked. An entirely unreadable
feed, invalid JSON, a non-array response or a failed fetch returns an error that
says warnings may exist. `get_weather_watch` is the duty
forecasters' editorial commentary, not an official warning, and an old post does
not mean a warning is active.

All upstream text (names, warning text, posts) is treated as untrusted data: HTML
is reduced to plain text, Markdown links and images are broken up, links outside
IMO's sites are dropped, brackets and parentheses in IMO links are
percent-encoded, and every string is bounded.

## Requests, caching, and failures

- One HTTP client sends only GET requests, with a 10-second timeout per attempt
  and a `vedur-mcp/<version> (+https://github.com/olafurns7/family-mcp)` User-Agent.
- Requests to api.vedur.is pin `x-vi-api-version`: `2026-02-17` for the Weather
  API and `2026-04-14` for the CAP API, the OpenAPI versions the response shapes
  were checked against. gottvedur.is requests send no version header.
- Server errors (5xx), timeouts, and connection failures are retried twice, after
  0.3 and 0.9 seconds. A 4xx answer, a redirect, or unexpected data is not retried.
- Successful responses are cached in memory for 60 seconds, or for the upstream
  `max-age` when that is longer (at most 10 minutes). `cached: true` and the
  original `fetched_at` show a cached answer. A response is cached only after
  the tool has read it: failures and responses that do not parse are never
  cached.
- Errors are fixed messages; upstream bodies never appear in them.

## Attribution and licence

Data: Veðurstofa Íslands (Icelandic Meteorological Office). The IMO Weather and
CAP APIs declare [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); IMO's
[website terms](https://en.vedur.is/about-imo/the-web/conditions) permit reuse of
its data with the source and the download date. Each result's `attribution` names
the dataset, URL, and download time, and states that vedur-mcp selected and
formatted the data and that IMO is not responsible for this processing.
Availability, freshness, and suitability are not guaranteed; for safety decisions
check [gottvedur.is](https://gottvedur.is/) and [vedur.is](https://www.vedur.is/).

The vedur-mcp code is MIT licensed (see `LICENSE`).

## Development

Rust uses the compiler pinned in `rust/rust-toolchain.toml`. From `rust/`:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
FAMILY_MCP_BUN="$(command -v bun)" cargo test -p vedur-mcp --all-features --locked
```

The tests serve recorded IMO responses (`rust/vedur-mcp/tests/fixtures`, with
provenance) from a loopback fake through the `test-origin` feature, which release
builds never enable. They never contact a live service. From the repository root:

```sh
bunx turbo run release:check --filter=vedur-mcp
bunx turbo run test:binary test:installer --filter=vedur-mcp
```

The native build is `packages/vedur-mcp/release/native/vedur-mcp`, compiled from
`rust/vedur-mcp` with default features. See [releasing](docs/RELEASING.md).
