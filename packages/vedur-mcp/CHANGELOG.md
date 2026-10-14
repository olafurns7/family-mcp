# Changelog

## Unreleased

- Read CAP update references in object form as bounded text instead of rejecting
  the warning feed. String and null references remain supported.
- Skip and count unreadable warnings individually, with a partial-read notice
  pointing to gottvedur.is; never claim no warnings when any item was unreadable.
  Entirely unreadable feeds still fail safely.
- Accept unfamiliar category strings and warning area ids, while continuing to
  return only weather warnings (category Met).

## 0.1.0

Released 2026-10-13.

- First version: a read-only Rust MCP server for Icelandic weather from Veðurstofa
  Íslands (IMO) with five tools: `search_stations`, `get_forecast`,
  `get_observations`, `get_weather_alerts`, and `get_weather_watch`.
