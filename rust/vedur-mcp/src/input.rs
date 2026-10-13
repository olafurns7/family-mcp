//! Tool arguments, checked as strict objects with zod 4's issue texts (mcp-runtime's `input`).

use mcp_runtime::input::{Parse, object, optional};
use rmcp::model::JsonObject;
use serde_json::Value;

pub const STATION_ID: (i64, i64) = (1, 99_999_999);

pub const DAYS: (i64, i64) = (1, 10);

pub const AREA_ID: (i64, i64) = (1, 99);

pub const WATCH_LIMIT: (i64, i64) = (1, 20);

pub const QUERY_LENGTH: (usize, usize) = (1, 100);

#[derive(Debug, PartialEq)]
pub enum Call {
    SearchStations { query: String, active: bool },
    Forecast { station_id: i64, days: i64 },
    Observations { station_id: i64 },
    Alerts { area_id: Option<i64>, english: bool },
    Watch { limit: i64 },
}

/// `z.number().int().min(min).max(max)`.
fn integer(parse: &mut Parse, value: Option<&Value>, (min, max): (i64, i64)) -> Option<i64> {
    let Some(number) = value.and_then(Value::as_f64) else {
        parse.wrong_type("number", value);
        return None;
    };

    if number.fract() != 0.0 || !number.is_finite() || number.abs() > 9_007_199_254_740_991.0 {
        parse.issue("Invalid input: expected int, received number".into(), true);
        return None;
    }
    let mut valid = true;

    if number < min as f64 {
        parse.issue(format!("Too small: expected number to be >={min}"), true);
        valid = false;
    }

    if number > max as f64 {
        parse.issue(format!("Too big: expected number to be <={max}"), true);
        valid = false;
    }
    // In range, so the cast is exact.
    valid.then_some(number as i64)
}

fn boolean(parse: &mut Parse, value: Option<&Value>) -> Option<bool> {
    let flag = value.and_then(Value::as_bool);

    if flag.is_none() {
        parse.wrong_type("boolean", value);
    }
    flag
}

/// `z.enum(["is", "en"])`: whether English was chosen.
fn language(parse: &mut Parse, value: Option<&Value>) -> Option<bool> {
    match value.and_then(Value::as_str) {
        Some("is") => Some(false),
        Some("en") => Some(true),
        _ => {
            parse.issue(r#"Invalid option: expected one of "is"|"en""#.into(), false);
            None
        }
    }
}

/// The checked arguments of a listed tool, or zod's issue text.
pub fn parse(name: &str, arguments: &JsonObject) -> Result<Call, String> {
    match name {
        "search_stations" => {
            let (query, active) = object(
                arguments,
                &["query", "active"],
                |parse, args| {
                    let query = parse.at("query").string(args.get("query"), QUERY_LENGTH);
                    let active = optional(parse, args, "active", boolean);
                    (query, active)
                },
                |(query, _)| {
                    query
                        .as_deref()
                        .is_some_and(|query| !query.is_empty() && query.trim().is_empty())
                        .then_some("query: must contain a character other than whitespace")
                },
            )?;
            Ok(Call::SearchStations {
                query: query.ok_or_else(String::new)?.trim().to_owned(),
                active: active.unwrap_or(true),
            })
        }
        "get_forecast" => {
            let (station_id, days) = object(
                arguments,
                &["station_id", "days"],
                |parse, args| {
                    let station = integer(
                        &mut parse.at("station_id"),
                        args.get("station_id"),
                        STATION_ID,
                    );
                    let days = optional(parse, args, "days", |parse, value| {
                        integer(parse, value, DAYS)
                    });
                    (station, days)
                },
                |_| None,
            )?;
            Ok(Call::Forecast {
                station_id: station_id.ok_or_else(String::new)?,
                days: days.unwrap_or(DAYS.1),
            })
        }
        "get_observations" => {
            let station_id = object(
                arguments,
                &["station_id"],
                |parse, args| {
                    integer(
                        &mut parse.at("station_id"),
                        args.get("station_id"),
                        STATION_ID,
                    )
                },
                |_| None,
            )?;
            Ok(Call::Observations {
                station_id: station_id.ok_or_else(String::new)?,
            })
        }
        "get_weather_alerts" => {
            let (area_id, english) = object(
                arguments,
                &["area_id", "language"],
                |parse, args| {
                    let area = optional(parse, args, "area_id", |parse, value| {
                        integer(parse, value, AREA_ID)
                    });
                    let english = optional(parse, args, "language", language);
                    (area, english)
                },
                |_| None,
            )?;
            Ok(Call::Alerts {
                area_id,
                english: english.unwrap_or(false),
            })
        }
        "get_weather_watch" => {
            let limit = object(
                arguments,
                &["limit"],
                |parse, args| {
                    optional(parse, args, "limit", |parse, value| {
                        integer(parse, value, WATCH_LIMIT)
                    })
                },
                |_| None,
            )?;
            Ok(Call::Watch {
                limit: limit.unwrap_or(5),
            })
        }
        _ => Err(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn call(name: &str, arguments: Value) -> Result<Call, String> {
        parse(name, arguments.as_object().unwrap())
    }

    #[test]
    fn valid_calls_get_their_defaults() {
        assert_eq!(
            call("search_stations", json!({"query": " Reykjavík "})),
            Ok(Call::SearchStations {
                query: "Reykjavík".into(),
                active: true
            })
        );
        assert_eq!(
            call(
                "search_stations",
                json!({"query": "Akureyri", "active": false})
            ),
            Ok(Call::SearchStations {
                query: "Akureyri".into(),
                active: false
            })
        );
        assert_eq!(
            call("get_forecast", json!({"station_id": 1})),
            Ok(Call::Forecast {
                station_id: 1,
                days: 10
            })
        );
        assert_eq!(
            call("get_forecast", json!({"station_id": 1.0, "days": 3})),
            Ok(Call::Forecast {
                station_id: 1,
                days: 3
            })
        );
        assert_eq!(
            call("get_observations", json!({"station_id": 1475})),
            Ok(Call::Observations { station_id: 1475 })
        );
        assert_eq!(
            call("get_weather_alerts", json!({})),
            Ok(Call::Alerts {
                area_id: None,
                english: false
            })
        );
        assert_eq!(
            call(
                "get_weather_alerts",
                json!({"area_id": 3, "language": "en"})
            ),
            Ok(Call::Alerts {
                area_id: Some(3),
                english: true
            })
        );
        assert_eq!(
            call("get_weather_watch", json!({})),
            Ok(Call::Watch { limit: 5 })
        );
        assert_eq!(
            call("get_weather_watch", json!({"limit": 20})),
            Ok(Call::Watch { limit: 20 })
        );
    }

    #[test]
    fn bounds_and_types_are_enforced_with_zod_texts() {
        let cases = [
            (
                "search_stations",
                json!({}),
                "query: Invalid input: expected string, received undefined",
            ),
            (
                "search_stations",
                json!({"query": ""}),
                "query: Too small: expected string to have >=1 characters",
            ),
            (
                "search_stations",
                json!({"query": "x".repeat(101)}),
                "query: Too big: expected string to have <=100 characters",
            ),
            (
                "search_stations",
                json!({"query": "   "}),
                "query: must contain a character other than whitespace",
            ),
            (
                "search_stations",
                json!({"query": "a", "active": "yes"}),
                "active: Invalid input: expected boolean, received string",
            ),
            (
                "get_forecast",
                json!({}),
                "station_id: Invalid input: expected number, received undefined",
            ),
            (
                "get_forecast",
                json!({"station_id": "1"}),
                "station_id: Invalid input: expected number, received string",
            ),
            (
                "get_forecast",
                json!({"station_id": 1.5}),
                "station_id: Invalid input: expected int, received number",
            ),
            (
                "get_forecast",
                json!({"station_id": 0}),
                "station_id: Too small: expected number to be >=1",
            ),
            (
                "get_forecast",
                json!({"station_id": 100_000_000}),
                "station_id: Too big: expected number to be <=99999999",
            ),
            (
                "get_forecast",
                json!({"station_id": 1, "days": 0}),
                "days: Too small: expected number to be >=1",
            ),
            (
                "get_forecast",
                json!({"station_id": 1, "days": 11}),
                "days: Too big: expected number to be <=10",
            ),
            (
                "get_observations",
                json!({"station_id": -1}),
                "station_id: Too small: expected number to be >=1",
            ),
            (
                "get_weather_alerts",
                json!({"area_id": 100}),
                "area_id: Too big: expected number to be <=99",
            ),
            (
                "get_weather_alerts",
                json!({"language": "de"}),
                r#"language: Invalid option: expected one of "is"|"en""#,
            ),
            (
                "get_weather_watch",
                json!({"limit": 21}),
                "limit: Too big: expected number to be <=20",
            ),
            (
                "get_weather_watch",
                json!({"limit": 0}),
                "limit: Too small: expected number to be >=1",
            ),
            (
                "get_weather_watch",
                json!({"limit": 5, "x": 1}),
                r#"Unrecognized key: "x""#,
            ),
        ];

        for (name, arguments, issues) in cases {
            assert_eq!(
                call(name, arguments.clone()),
                Err(issues.to_owned()),
                "{name} {arguments}"
            );
        }
    }
}
