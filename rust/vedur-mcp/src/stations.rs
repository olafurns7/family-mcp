//! `search_stations`: IMO measuring stations by name, from the documented Weather API.

use mcp_runtime::Fail;
use serde_json::{Value, json};

use crate::http::{Fetched, WEATHER_API};
use crate::output::{Fields, Output, envelope, json_body};

pub const SHAPE: Fail = Fail::Safe(
    "The IMO Weather API returned station data in an unexpected shape. The API may have changed; no stations were read.",
);

pub const REFUSED: Fail =
    Fail::Safe("The IMO Weather API refused the station search. Use a shorter plain name.");

pub const MAX_BYTES: usize = 2 * 1024 * 1024;

const MAX_RESULTS: usize = 50;

const COVERAGE: &str = "IMO measuring stations from the documented Weather API. A forecast place that is not listed here may still exist on gottvedur.is.";

pub fn url(query: &str, active: bool) -> String {
    let mut url =
        reqwest::Url::parse(&format!("{WEATHER_API}/stations")).expect("a valid base URL");
    url.query_pairs_mut()
        .append_pair("keyword", query)
        .append_pair("active", if active { "true" } else { "false" });
    url.into()
}

fn type_description(kind: Option<&str>) -> Value {
    match kind {
        Some("sj") => json!("automatic weather station"),
        Some("sk") => json!("manned synoptic station"),
        Some("ur") => json!("precipitation station"),
        Some("vf") => json!("climate station"),
        _ => Value::Null,
    }
}

fn station(value: &Value) -> Result<Value, Fail> {
    let fields = Fields::of(value, SHAPE)?;
    let kind = fields.text("type", 10)?;
    Ok(json!({
        "station_id": fields.integer("station")?,
        "name": fields.text("name", 200)?,
        "abbr": fields.text("abbr", 50)?,
        "type": kind,
        "type_description": type_description(kind.as_str()),
        "latitude": fields.number("lat")?,
        "longitude": fields.number("lon")?,
        "elevation_m": fields.number("ele")?,
        "wigos": fields.text("wigos", 50)?,
        "owner": fields.text("owner", 200)?,
        "start_year": fields.number("start")?,
        "end_year": fields.number("ending")?,
    }))
}

pub fn shape(fetched: &Fetched, url: &str, query: &str, active: bool) -> Output {
    let body = json_body(fetched, SHAPE)?;
    let list = body.as_array().ok_or(SHAPE)?;
    let stations = list.iter().map(station).collect::<Result<Vec<_>, _>>()?;
    let total = stations.len();

    let mut output = envelope(
        "IMO Weather API, stations",
        "documented public API (api.vedur.is/weather)",
        &[url],
        &[fetched],
    );
    output.insert("coverage".into(), json!(COVERAGE));
    output.insert("query".into(), json!(query));
    output.insert("active".into(), json!(active));
    output.insert("total".into(), json!(total));
    output.insert("truncated".into(), json!(total > MAX_RESULTS));
    output.insert(
        "stations".into(),
        Value::Array(stations.into_iter().take(MAX_RESULTS).collect()),
    );
    Ok(Value::Object(output))
}
