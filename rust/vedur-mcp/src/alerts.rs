//! `get_weather_alerts`: IMO's official CAP warnings. A failed or unreadable fetch is always an
//! error, never an empty list; an empty list says when it was checked.

use chrono::{DateTime, Utc};
use mcp_runtime::Fail;
use serde_json::{Value, json};

use crate::http::{CAP_API, Fetched};
use crate::output::{Fields, Output, envelope, json_body, timestamp};
use crate::text;

pub const FAILED: Fail = Fail::Safe(
    "IMO weather warnings could not be read (connection failure, timeout, server error, or an oversized or unexpected response). This does NOT mean there are no warnings: check https://gottvedur.is/vidvaranir/ or try again.",
);

pub const SHAPE: Fail = Fail::Safe(
    "IMO's CAP warning feed returned data in an unexpected shape, so the warnings could not be read. This does NOT mean there are no warnings: check https://gottvedur.is/vidvaranir/.",
);

pub const MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn url() -> String {
    format!("{CAP_API}/capbroker/active/detailed/all")
}

fn when(fields: &Fields, key: &str) -> Result<(Value, Option<DateTime<Utc>>), Fail> {
    match fields.object.get(key) {
        None | Some(Value::Null) => Ok((Value::Null, None)),
        Some(Value::String(time)) => Ok((
            json!(text::clean(time, 40)),
            DateTime::parse_from_rfc3339(time)
                .ok()
                .map(|time| time.with_timezone(&Utc)),
        )),
        Some(_) => Err(SHAPE),
    }
}

/// The localized text, else the other language's, and which language it was.
fn localized(
    fields: &Fields,
    key: &str,
    english: bool,
    max_chars: usize,
) -> Result<(Value, Value), Fail> {
    let (first, second) = if english { ("en", "is") } else { ("is", "en") };

    for language in [first, second] {
        let value = fields.text(&format!("{key}_{language}"), max_chars)?;

        if value.as_str().is_some_and(|text| !text.is_empty()) {
            return Ok((value, json!(language)));
        }
    }
    Ok((Value::Null, Value::Null))
}

/// The CAP 1.2 `category` values.
const CATEGORIES: [&str; 12] = [
    "Geo",
    "Met",
    "Safety",
    "Security",
    "Rescue",
    "Fire",
    "Health",
    "Env",
    "Transport",
    "Infra",
    "CBRNE",
    "Other",
];

/// Whether a warning is weather (category Met). The category list must be present, nonempty, no
/// longer than the CAP list, and only CAP values; anything else is a changed feed, so an entry
/// is never skipped on a category that could not be read.
fn is_weather(value: Option<&Value>) -> Result<bool, Fail> {
    let categories = value.and_then(Value::as_array).ok_or(SHAPE)?;

    if categories.is_empty() || categories.len() > CATEGORIES.len() {
        return Err(SHAPE);
    }
    let mut weather = false;

    for category in categories {
        let category = category.as_str().ok_or(SHAPE)?;

        if !CATEGORIES.contains(&category) {
            return Err(SHAPE);
        }
        weather |= category == "Met";
    }
    Ok(weather)
}

fn strings(value: Option<&Value>, max_items: usize) -> Result<Vec<String>, Fail> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .take(max_items)
            .map(|item| {
                item.as_str()
                    .map(|item| text::clean(item, 200))
                    .ok_or(SHAPE)
            })
            .collect(),
        Some(_) => Err(SHAPE),
    }
}

/// Area names from `geocode_<lang>`: `{ "Forecast Region": ["South Iceland"] }`.
fn area_names(fields: &Fields, english: bool) -> Result<Vec<String>, Fail> {
    let key = if english { "geocode_en" } else { "geocode_is" };

    match fields.object.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(groups)) => {
            let mut names = Vec::new();

            for names_in_group in groups.values() {
                names.extend(strings(Some(names_in_group), 20)?);
            }
            Ok(names)
        }
        Some(_) => Err(SHAPE),
    }
}

enum Classified {
    Keep(Value, Option<DateTime<Utc>>),
    Expired,
    NotWeather,
}

fn warning(value: &Value, english: bool, now: DateTime<Utc>) -> Result<Classified, Fail> {
    let fields = Fields::of(value, SHAPE)?;
    let identifier = text::clean(fields.string("identifier")?, 200);

    if !is_weather(fields.object.get("category"))? {
        return Ok(Classified::NotWeather);
    }
    let (onset, onset_at) = when(&fields, "onset")?;
    let (expires, expires_at) = when(&fields, "expires")?;

    if expires_at.is_some_and(|expires| expires <= now) {
        return Ok(Classified::Expired);
    }
    let status = match (onset_at, expires_at) {
        (Some(onset), _) if onset > now => "upcoming",
        (Some(_), Some(_)) => "in effect",
        // Never hide a warning whose times do not parse.
        _ => "unknown",
    };
    let (headline, language) = localized(&fields, "headline", english, 300)?;
    let (description, _) = localized(&fields, "description", english, 3000)?;
    let (event, _) = localized(&fields, "event", english, 200)?;
    let colour = match fields.object.get("parameter") {
        Some(Value::Object(parameter)) => strings(parameter.get("Color"), 5)?.into_iter().next(),
        None | Some(Value::Null) => None,
        Some(_) => return Err(SHAPE),
    };

    Ok(Classified::Keep(
        json!({
            "identifier": identifier,
            "area_id": fields.integer("area_id")?,
            "area_names": area_names(&fields, english)?,
            "status": status,
            "onset": onset,
            "expires": expires,
            "sent": when(&fields, "sent")?.0,
            "msgtype": fields.text("msgtype", 40)?,
            "references": fields.text("references", 2000)?,
            "severity": fields.text("severity", 40)?,
            "certainty": fields.text("certainty", 40)?,
            "urgency": fields.text("urgency", 40)?,
            "colour": colour,
            "event": event,
            "headline": headline,
            "description": description,
            "text_language": language,
        }),
        onset_at,
    ))
}

pub fn shape(fetched: &Fetched, area_id: Option<i64>, english: bool, now: DateTime<Utc>) -> Output {
    let body = json_body(fetched, SHAPE)?;
    let list = body.as_array().ok_or(SHAPE)?;
    let mut kept = Vec::new();
    let mut expired = 0;
    let mut other_categories = 0;

    for value in list {
        match warning(value, english, now)? {
            Classified::NotWeather => other_categories += 1,
            Classified::Expired => expired += 1,
            Classified::Keep(warning, onset) => {
                if area_id.is_none_or(|area| warning["area_id"] == json!(area)) {
                    kept.push((onset, warning));
                }
            }
        }
    }
    kept.sort_by(|(a, left), (b, right)| {
        a.cmp(b)
            .then_with(|| left["area_id"].as_i64().cmp(&right["area_id"].as_i64()))
    });
    let url = url();
    let mut output = envelope(
        "IMO CAP weather warnings",
        "documented public API (api.vedur.is/cap)",
        &[&url],
        &[fetched],
    );
    let checked = output["fetched_at"].as_str().unwrap_or_default().to_owned();
    let place = area_id.map_or(String::new(), |area| format!(" for warning area {area}"));
    let summary = match kept.len() {
        0 => format!("No active or upcoming IMO weather warnings{place} at {checked}."),
        1 => format!("1 active or upcoming IMO weather warning{place} at {checked}."),
        count => format!("{count} active or upcoming IMO weather warnings{place} at {checked}."),
    };
    output.insert("summary".into(), json!(summary));
    output.insert("area_id".into(), json!(area_id));
    output.insert("language".into(), json!(if english { "en" } else { "is" }));
    output.insert("checked_at".into(), json!(timestamp(now)));
    output.insert("expired_skipped".into(), json!(expired));
    output.insert("other_categories_skipped".into(), json!(other_categories));
    output.insert(
        "note".into(),
        json!("Official IMO warnings (CAP, category Met). Warning area ids are IMO warning areas (1 Höfuðborgarsvæðið, 2 Suðurland, 3 Faxaflói, 4 Breiðafjörður, 5 Vestfirðir, 6 Strandir og norðurland vestra, 7 Norðurland eystra, 8 Austurland að Glettingi, 9 Austfirðir, 10 Suðausturland, 11 Miðhálendi); they are not gottvedur.is forecast-region ids. Times keep the source's UTC offsets."),
    );
    output.insert(
        "warnings".into(),
        Value::Array(kept.into_iter().map(|(_, warning)| warning).collect()),
    );
    Ok(Value::Object(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(time: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(time)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn classify(onset: Value, expires: Value, now: &str) -> String {
        let value = json!({
            "identifier": "x", "area_id": 1, "category": ["Met"],
            "onset": onset, "expires": expires,
        });
        match warning(&value, false, at(now)).unwrap() {
            Classified::Keep(warning, _) => warning["status"].as_str().unwrap().to_owned(),
            Classified::Expired => "expired".to_owned(),
            Classified::NotWeather => "other".to_owned(),
        }
    }

    #[test]
    fn warnings_are_in_effect_upcoming_expired_or_unknown() {
        let onset = json!("2026-10-14T10:00:00-00:00");
        let expires = json!("2026-10-14T20:00:00-00:00");
        assert_eq!(
            classify(onset.clone(), expires.clone(), "2026-10-13T10:00:00Z"),
            "upcoming"
        );
        assert_eq!(
            classify(onset.clone(), expires.clone(), "2026-10-14T10:00:00Z"),
            "in effect"
        );
        assert_eq!(
            classify(onset.clone(), expires.clone(), "2026-10-14T20:00:00Z"),
            "expired"
        );
        assert_eq!(
            classify(json!("tomorrow"), expires.clone(), "2026-10-14T12:00:00Z"),
            "unknown"
        );
        assert_eq!(
            classify(onset, Value::Null, "2026-10-14T12:00:00Z"),
            "unknown"
        );
    }

    #[test]
    fn other_categories_and_wrong_types_are_told_apart() {
        let geo = json!({"identifier": "x", "area_id": 1, "category": ["Geo"]});
        assert!(matches!(
            warning(&geo, false, Utc::now()),
            Ok(Classified::NotWeather)
        ));
        let broken = json!({"identifier": "x", "area_id": 1, "category": "Met"});
        assert_eq!(warning(&broken, false, Utc::now()).err(), Some(SHAPE));
    }
}
