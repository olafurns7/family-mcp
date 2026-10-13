//! `get_observations`: the latest measurement of one station from the documented Weather API.
//! Automatic stations answer on `observations/aws/hour/latest`; when that has nothing (an empty
//! list, or a 404 whose whole body is `{"message":"No data found."}`), the OpenAPI document's
//! `observations/synop/latest` is asked for a manned (synop) report.

use mcp_runtime::Fail;
use serde_json::{Map, Value, json};

use crate::http::{Fetched, WEATHER_API};
use crate::output::{Fields, Output, envelope, json_body};
use crate::text;

pub const SHAPE: Fail = Fail::Safe(
    "The IMO Weather API returned observations in an unexpected shape. The API may have changed; no observation was read.",
);

pub const REFUSED: Fail =
    Fail::Safe("The IMO Weather API refused the observation request for this station id.");

pub const MAX_BYTES: usize = 1024 * 1024;

/// Fields that identify a record rather than measure something.
const IDENTITY: [&str; 7] = ["station", "name", "time", "year", "month", "day", "hour"];

const MAX_VALUES: usize = 100;

pub fn aws_url(station_id: i64) -> String {
    format!("{WEATHER_API}/observations/aws/hour/latest?station_id={station_id}&parameters=basic")
}

pub fn synop_url(station_id: i64) -> String {
    format!("{WEATHER_API}/observations/synop/latest?station_id={station_id}")
}

/// A route's answer: the response, or `None` for its "No data found." 404.
pub type Route<'a> = Option<&'a Fetched>;

/// One station's latest record from either route: `None` when the route has none for it.
pub fn record(route: Route, station_id: i64) -> Result<Option<Value>, Fail> {
    let Some(fetched) = route else {
        return Ok(None);
    };
    let body = json_body(fetched, SHAPE)?;
    let list = body.as_array().ok_or(SHAPE)?;
    let mut found = None;

    for value in list {
        let fields = Fields::of(value, SHAPE)?;

        if fields.integer("station")? != station_id {
            return Err(SHAPE);
        }
        let time = fields.string("time")?;
        let mut values = Map::new();

        for (key, value) in fields.object {
            if IDENTITY.contains(&key.as_str()) || values.len() >= MAX_VALUES || key.len() > 40 {
                continue;
            }
            let value = match value {
                Value::Null | Value::Number(_) => value.clone(),
                Value::String(label) => json!(text::clean(label, 100)),
                // Not a measurement the documented schemas list.
                _ => continue,
            };
            values.insert(text::clean(key, 40), value);
        }
        found = Some(json!({
            "station_id": station_id,
            "name": fields.text("name", 200)?,
            "time": text::clean(time, 40),
            "values": values,
        }));
    }
    Ok(found)
}

/// What the common keys mean, from IMO's documentation of its observation parameters.
fn legend() -> Value {
    json!({
        "t": "air temperature, °C",
        "tx": "highest temperature in the period, °C",
        "tn": "lowest temperature in the period, °C",
        "td": "dew point, °C",
        "rh": "relative humidity, %",
        "f": "mean wind speed, m/s",
        "fx": "highest mean wind speed, m/s",
        "fg": "highest wind gust, m/s",
        "d": "wind direction, degrees",
        "d_txt": "wind direction as a compass abbreviation",
        "p": "air pressure, hPa",
        "r": "accumulated precipitation, mm",
    })
}

/// `aws` is the automatic route's response; `synop` is present only when that had nothing.
pub fn shape(
    station_id: i64,
    aws: (Route, Option<Value>),
    synop: Option<(Route, Option<Value>)>,
) -> Output {
    let aws_url = aws_url(station_id);
    let synop_url = synop_url(station_id);
    let (kind, observation, urls, routes): (Value, Value, Vec<&str>, Vec<Route>) =
        match (aws, synop) {
            ((aws, Some(record)), _) => (json!("automatic"), record, vec![&aws_url], vec![aws]),
            ((aws, None), Some((synop, Some(record)))) => (
                json!("manned (synop)"),
                record,
                vec![&aws_url, &synop_url],
                vec![aws, synop],
            ),
            ((aws, None), Some((synop, None))) => (
                Value::Null,
                Value::Null,
                vec![&aws_url, &synop_url],
                vec![aws, synop],
            ),
            ((aws, None), None) => (Value::Null, Value::Null, vec![&aws_url], vec![aws]),
        };
    let fetched: Vec<&Fetched> = routes.into_iter().flatten().collect();
    let note = match kind {
        Value::Null => format!(
            "No automatic or manned observations from the last 24 hours for station {station_id}. The id may be a forecast place, a precipitation or climate station, or a station that is not reporting; this is not a measurement of calm or dry weather."
        ),
        _ => "Values are as IMO gives them; null means not measured or not available, never zero. time is the source's observation time, given without an offset.".to_owned(),
    };

    let mut output = envelope(
        "IMO Weather API, latest observations",
        "documented public API (api.vedur.is/weather)",
        &urls,
        &fetched,
    );
    output.insert("station_id".into(), json!(station_id));
    output.insert("kind".into(), kind);
    output.insert("observation".into(), observation);
    output.insert("legend".into(), legend());
    output.insert("note".into(), json!(note));
    Ok(Value::Object(output))
}
