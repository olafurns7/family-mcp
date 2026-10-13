//! What every result carries (source, fetch time, attribution), the safe failure texts, and
//! typed reads of upstream JSON that turn a shape change into a safe error.

use chrono::{DateTime, SecondsFormat, Utc};
use mcp_runtime::Fail;
use serde_json::{Map, Value, json};

use crate::http::{FetchError, Fetched};
use crate::text;

pub type Output = Result<Value, Fail>;

pub const PROVIDER: &str = "Veðurstofa Íslands (Icelandic Meteorological Office, IMO)";

pub const LICENCE: &str = "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)";

pub const UNAVAILABLE: Fail = Fail::Safe(
    "Veðurstofa Íslands did not answer (connection failure, timeout, or server error after retries). No data was read; this is not an empty result. Try again later.",
);

pub const TOO_LARGE: Fail = Fail::Safe(
    "The Veðurstofa Íslands response exceeded the size limit and was not read. No data was read; this is not an empty result.",
);

pub const UNEXPECTED: Fail = Fail::Safe(
    "Veðurstofa Íslands returned an unexpected response (redirect or unusual status). No data was read; this is not an empty result.",
);

pub const CANCELLED: Fail = Fail::Safe("The request was cancelled before it finished.");

/// A reviewed failure for a GET; `refused` covers 4xx answers, which depend on the tool.
pub fn fetch_failure(error: FetchError, refused: Fail) -> Fail {
    match error {
        FetchError::Unavailable => UNAVAILABLE,
        FetchError::TooLarge => TOO_LARGE,
        FetchError::Unexpected => UNEXPECTED,
        FetchError::Refused(_) => refused,
    }
}

pub fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// The fields every result starts with. `fetched` holds the responses the result used.
pub fn envelope(
    dataset: &str,
    api: &str,
    urls: &[&str],
    fetched: &[&Fetched],
) -> Map<String, Value> {
    let fetched_at = fetched
        .iter()
        .map(|response| response.fetched_at)
        .min()
        .unwrap_or_else(crate::http::now);
    let fetched_at = timestamp(fetched_at);
    let attribution = format!(
        "{dataset} — {PROVIDER}, {}, downloaded {fetched_at}. Licence: {LICENCE} where declared. Selected and formatted by vedur-mcp; IMO is not responsible for this processing or interpretation.",
        urls.join(", ")
    );
    let mut output = Map::new();
    output.insert(
        "source".into(),
        json!({ "provider": PROVIDER, "dataset": dataset, "api": api, "urls": urls }),
    );
    output.insert("fetched_at".into(), json!(fetched_at));
    output.insert(
        "cached".into(),
        json!(fetched.iter().any(|response| response.cached)),
    );
    output.insert("attribution".into(), json!(attribution));
    output
}

/// Typed reads of one upstream object; any mismatch is the tool's `shape` failure.
pub struct Fields<'a> {
    pub object: &'a Map<String, Value>,
    pub shape: Fail,
}

impl<'a> Fields<'a> {
    pub fn of(value: &'a Value, shape: Fail) -> Result<Self, Fail> {
        Ok(Self {
            object: value.as_object().ok_or(shape)?,
            shape,
        })
    }

    pub fn required(&self, key: &str) -> Result<&'a Value, Fail> {
        self.object.get(key).ok_or(self.shape)
    }

    pub fn integer(&self, key: &str) -> Result<i64, Fail> {
        self.required(key)?.as_i64().ok_or(self.shape)
    }

    pub fn string(&self, key: &str) -> Result<&'a str, Fail> {
        self.required(key)?.as_str().ok_or(self.shape)
    }

    pub fn array(&self, key: &str) -> Result<&'a Vec<Value>, Fail> {
        self.required(key)?.as_array().ok_or(self.shape)
    }

    /// A number or null; a missing key reads as null.
    pub fn number(&self, key: &str) -> Result<Value, Fail> {
        match self.object.get(key) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(Value::Number(number)) => Ok(Value::Number(number.clone())),
            Some(_) => Err(self.shape),
        }
    }

    /// A boolean or null; a missing key reads as null.
    pub fn boolean(&self, key: &str) -> Result<Value, Fail> {
        match self.object.get(key) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(Value::Bool(flag)) => Ok(Value::Bool(*flag)),
            Some(_) => Err(self.shape),
        }
    }

    /// Bounded plain text or null; a missing key reads as null.
    pub fn text(&self, key: &str, max_chars: usize) -> Result<Value, Fail> {
        match self.object.get(key) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(Value::String(value)) => Ok(Value::String(text::clean(value, max_chars))),
            Some(_) => Err(self.shape),
        }
    }
}

/// The body as JSON, or the tool's `shape` failure.
pub fn json_body(fetched: &Fetched, shape: Fail) -> Result<Value, Fail> {
    serde_json::from_slice(&fetched.body).map_err(|_| shape)
}
