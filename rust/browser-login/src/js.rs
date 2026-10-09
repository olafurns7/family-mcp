//! The JavaScript semantics the TypeScript server inherits from its runtime and zod: string
//! lengths, `String.prototype.trim`, object key order and number output.

use std::cmp::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Number, Value};

/// `Date.now()`: whole milliseconds since the epoch.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// A string's length as zod 4.6 checks it: Unicode code points, not UTF-16 units.
pub fn length(text: &str) -> usize {
    text.chars().count()
}

/// JavaScript's `<` on strings compares UTF-16 code units.
pub fn compare(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`, whose white space differs from Rust's (U+0085, U+FEFF).
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

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

/// `crypto.randomUUID()`.
pub fn uuid() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// Names `{}` inherits from `Object.prototype`: indexing an object with one never yields
/// `undefined`.
pub fn inherited(key: &str) -> bool {
    matches!(
        key,
        "__proto__"
            | "constructor"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toLocaleString"
            | "toString"
            | "valueOf"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_semantics() {
        assert_eq!(length("a\u{10000}"), 2);
        assert_eq!(compare("\u{ffff}", "\u{10000}"), Ordering::Greater);
        assert_eq!(trim("\u{feff} a\u{85}"), "a\u{85}");
        let ordered = parse(br#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6}"#).unwrap();
        assert_eq!(
            ordered.to_string(),
            r#"{"2":4,"10":2,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
        assert_eq!(
            parse(b"[1.0,-0,2.5,1e300]").unwrap().to_string(),
            "[1,0,2.5,1e+300]"
        );
        // JSON.stringify's output for the same doubles; integers from 2^53 to 1e21 differ.
        assert_eq!(
            parse(
                b"[1e21,1e-7,0.30000000000000004,5e-324,1.7976931348623157e308,-9007199254740991]"
            )
            .unwrap()
            .to_string(),
            "[1e+21,1e-7,0.30000000000000004,5e-324,1.7976931348623157e+308,-9007199254740991]"
        );
        assert_eq!(uuid().unwrap().len(), 36);
    }
}
