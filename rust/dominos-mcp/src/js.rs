//! The JavaScript semantics the TypeScript server inherits from its runtime: object key order,
//! number output and URL encoding.

use serde_json::{Map, Number, Value};

/// A key `JSON.parse` and object literals order first: a canonical array index below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let index: u32 = key.parse().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

/// Integer-like keys first in ascending order, then the rest in insertion order, as every
/// JavaScript object orders its own keys.
pub fn order(map: Map<String, Value>) -> Map<String, Value> {
    let (mut indexed, named): (Vec<_>, Vec<_>) = map
        .into_iter()
        .partition(|(key, _)| array_index(key).is_some());
    indexed.sort_by_key(|(key, _)| array_index(key));
    indexed.into_iter().chain(named).collect()
}

/// A number as `JSON.stringify` writes it: integral values without a fraction. Integral values
/// from 2^53 up to 1e21 are written in exponent form (or with `.0`), where JavaScript writes digits.
pub fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// A parsed JSON value as `JSON.parse` would hold it: object keys in JavaScript order and every
/// number a double.
pub fn normalize(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            order(map)
                .into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Number(number) => self::number(number.as_f64().unwrap_or(f64::NAN)),
        other => other,
    }
}

/// `JSON.parse` of UTF-8 text, as `Buffer.toString('utf8')` decodes it.
pub fn parse(bytes: &[u8]) -> Option<Value> {
    serde_json::from_str(&String::from_utf8_lossy(bytes))
        .ok()
        .map(normalize)
}

fn percent(bytes: &[u8], keep: impl Fn(u8) -> bool, space: Option<&str>) -> String {
    let mut encoded = String::new();

    for &byte in bytes {
        match (byte, space) {
            (b' ', Some(plus)) => encoded.push_str(plus),
            _ if keep(byte) => encoded.push(char::from(byte)),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// `encodeURIComponent`.
pub fn encode_component(text: &str) -> String {
    percent(
        text.as_bytes(),
        |byte| byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte),
        None,
    )
}

/// `URLSearchParams`' serialization of one name or value (application/x-www-form-urlencoded).
pub fn encode_query(text: &str) -> String {
    percent(
        text.as_bytes(),
        |byte| byte.is_ascii_alphanumeric() || b"*-._".contains(&byte),
        Some("+"),
    )
}
