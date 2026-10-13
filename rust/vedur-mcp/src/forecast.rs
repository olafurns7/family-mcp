//! `get_forecast`: daily summaries and timed steps from the gottvedur.is site API. That API is
//! unversioned; a shape change is a safe error, never a silent switch to another source.

use chrono::NaiveDateTime;
use mcp_runtime::Fail;
use serde_json::{Value, json};

use crate::http::{Fetched, GOTTVEDUR};
use crate::output::{Fields, Output, envelope, json_body};

pub const SHAPE: Fail = Fail::Safe(
    "gottvedur.is returned a forecast in an unexpected shape. Its unversioned site API may have changed; no other source was used and no forecast was read.",
);

pub const REFUSED: Fail = Fail::Safe(
    "gottvedur.is has no forecast for this station id (the request was refused). Find ids with search_stations; a forecast place may also be missing from gottvedur.is.",
);

pub const MAX_BYTES: usize = 4 * 1024 * 1024;

const API_NOTE: &str = "gottvedur.is site API: internal to the IMO website, unversioned, and may change without notice. Times are as the source gives them, without a UTC offset (Iceland keeps UTC all year, but the API does not state the zone). Step times are kept as given: steps may be 1, 3 or 6 hours apart, and step_hours is the gap to the previous step.";

pub fn url(station_id: i64) -> String {
    format!("{GOTTVEDUR}/api/forecasts/station/?stationId={station_id}")
}

fn naive(time: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(time, "%Y-%m-%dT%H:%M:%S%.f").ok()
}

/// Hours between two source times, when both parse.
fn step_hours(previous: Option<&str>, time: &str) -> Value {
    let (Some(previous), Some(time)) = (previous.and_then(naive), naive(time)) else {
        return Value::Null;
    };
    let minutes = (time - previous).num_minutes();
    match minutes {
        1.. => json!(minutes as f64 / 60.0),
        _ => Value::Null,
    }
}

fn day(value: &Value, previous: &mut Option<String>) -> Result<Value, Fail> {
    let fields = Fields::of(value, SHAPE)?;
    let mut steps = Vec::new();

    for step in fields.array("hourlyForecasts")? {
        let step = Fields::of(step, SHAPE)?;
        let time = step.string("forecastTime")?;
        steps.push(json!({
            "time": crate::text::clean(time, 40),
            "step_hours": step_hours(previous.as_deref(), time),
            "icon": step.text("icon", 50)?,
            "temperature": step.number("temperature")?,
            "wind_speed": step.number("windSpeed")?,
            "wind_direction": step.number("windDirection")?,
            "precipitation": step.number("precipitation")?,
            "humidity": step.number("humidity")?,
        }));
        *previous = Some(time.to_owned());
    }

    Ok(json!({
        "date": crate::text::clean(fields.string("forecastDate")?, 40),
        "highest_temperature": fields.number("highestTemperature")?,
        "lowest_temperature": fields.number("lowestTemperature")?,
        "wind_speed": fields.number("windSpeed")?,
        "wind_direction": fields.number("windDirection")?,
        "precipitation": fields.number("precipitation")?,
        "sunrise": fields.text("sunrise", 40)?,
        "sunset": fields.text("sunset", 40)?,
        "steps": steps,
    }))
}

pub fn shape(fetched: &Fetched, url: &str, station_id: i64, days: i64) -> Output {
    let body = json_body(fetched, SHAPE)?;
    let fields = Fields::of(&body, SHAPE)?;

    if fields.integer("stationId")? != station_id {
        return Err(SHAPE);
    }
    let coordinates = match fields.object.get("stationCoordinates") {
        None | Some(Value::Null) => None,
        Some(value) => Some(Fields::of(value, SHAPE)?),
    };
    let (latitude, longitude) = match &coordinates {
        Some(coordinates) => (
            coordinates.number("latitude")?,
            coordinates.number("longitude")?,
        ),
        None => (Value::Null, Value::Null),
    };
    let daily = fields.array("dailyForecasts")?;
    let mut previous = None;
    let mut forecast = Vec::new();

    for value in daily {
        let shaped = day(value, &mut previous)?;

        if forecast.len() < days as usize {
            forecast.push(shaped);
        }
    }

    let mut output = envelope(
        "gottvedur.is station forecast",
        "gottvedur.is site API (internal, unversioned, may change)",
        &[url],
        &[fetched],
    );
    output.insert("api_note".into(), json!(API_NOTE));
    output.insert(
        "station".into(),
        json!({
            "station_id": station_id,
            "name": fields.text("stationName", 200)?,
            "display_name": fields.text("stationDisplayName", 200)?,
            "is_virtual": fields.boolean("isVirtual")?,
            "has_observations": fields.boolean("hasObservations")?,
            "latitude": latitude,
            "longitude": longitude,
        }),
    );
    output.insert(
        "units".into(),
        json!({
            "temperature": "°C",
            "wind_speed": "m/s",
            "wind_direction": "degrees",
            "precipitation": "mm, as given (the source does not document whether a step's value covers the whole step, or how the daily value is aggregated)",
            "humidity": "%",
        }),
    );
    output.insert("days_available".into(), json!(daily.len()));
    output.insert("days".into(), Value::Array(forecast));
    Ok(Value::Object(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_gaps_follow_the_source_times() {
        assert_eq!(step_hours(None, "2026-10-13T10:00:00"), Value::Null);
        assert_eq!(
            step_hours(Some("2026-10-18T00:00:00"), "2026-10-18T03:00:00"),
            json!(3.0)
        );
        assert_eq!(
            step_hours(Some("2026-10-19T00:00:00"), "2026-10-19T06:00:00"),
            json!(6.0)
        );
        assert_eq!(step_hours(Some("bad"), "2026-10-19T06:00:00"), Value::Null);
        assert_eq!(
            step_hours(Some("2026-10-19T06:00:00"), "2026-10-19T06:00:00"),
            Value::Null
        );
    }
}
