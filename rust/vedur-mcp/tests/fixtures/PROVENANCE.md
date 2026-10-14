# Fixture provenance

Recorded public responses from Veðurstofa Íslands (Icelandic Meteorological Office, IMO), fetched
anonymously (no key, cookie or account) on 2026-10-13 between 09:50 and 09:56 UTC during the
vedur-mcp research run. They are unmodified except where noted. Licence: CC BY 4.0
(<https://creativecommons.org/licenses/by/4.0/>), as the IMO Weather and CAP OpenAPI documents
declare; gottvedur.is is operated by IMO, whose website terms permit reuse with attribution.
Tests serve these files from a loopback fake; they never contact a live service.

`cap-updates-synthetic.json` is hand-written synthetic data, not a recorded
response. Its Alert/Update, references-object (identifier, sender, sent, source),
and Geo area 21–23 structures reproduce the public CAP feed shapes observed on
2026-10-14 at 09:31 UTC at
`https://api.vedur.is/cap/capbroker/active/detailed/all`, with
`x-vi-api-version: 2026-04-14`. All identifiers and free text are synthetic;
polygons are shortened and resources omitted. It also includes a string reference
and a deliberately malformed item for regression tests.

| File                         | URL                                                                                          | Notes                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stations.json`              | `https://api.vedur.is/weather/stations?keyword=Reykjav%C3%ADk&active=true`                   | Full response.                                                                                                                                                                                                                                                              |
| `forecast.json`              | `https://gottvedur.is/api/forecasts/station/?stationId=1`                                    | Full response (gottvedur.is site API, unversioned).                                                                                                                                                                                                                         |
| `official-observations.json` | `https://api.vedur.is/weather/observations/aws/hour/latest?station_id=1475&parameters=basic` | Full response.                                                                                                                                                                                                                                                              |
| `cap-active.json`            | `https://api.vedur.is/cap/capbroker/active/detailed/all`                                     | Full response: 11 warnings, all category Met, onsets 2026-10-14.                                                                                                                                                                                                            |
| `vaktin.xml`                 | `https://gottvedur.is/rss.xml/vaktin` (answers 308 to `https://gottvedur.is/rss.xml/vaktin/`) | Trimmed: the original 127 KB feed had 30 items. Kept the channel header and 7 items byte for byte, in feed order: 4 in the Veðurvakt category (3 of them also Sólmyrkvi) and 3 only in Skriðuvakt. The other 23 items were removed.                                         |
| `synop-latest.json`          | `https://api.vedur.is/weather/observations/synop/latest?station_id=1`                         | Full response, recorded on 2026-10-13 at 10:32 UTC during the live smoke run.                                                                                                                                                                                              |
| `aws-no-data.json`           | `https://api.vedur.is/weather/observations/aws/hour/latest?station_id=1&parameters=basic`    | Full body of the HTTP 404 the Weather API returned on 2026-10-13 at 10:32 UTC for a manned station without automatic data.                                                                                                                                                  |
