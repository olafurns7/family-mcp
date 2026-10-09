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

/// JavaScript's `String.prototype.trim`: WhiteSpace and LineTerminator code points, BOM included.
pub fn trim(text: &str) -> &str {
    let space = |c: char| {
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
    };
    text.trim_matches(space)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1-12; days may overflow).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    era * 146_097 + of_era * 365 + of_era / 4 - of_era / 100 + of_year - 719_468
}

/// `Date.prototype.toISOString` of milliseconds since the epoch.
pub fn iso_string(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let of_era = shifted - era * 146_097;
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// The current time as `Date.now()`.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// `Date.parse` for the ECMAScript date time string format (`YYYY[-MM[-DD]][THH:mm[:ss[.s+]]]`,
/// then `Z` or `±HH:mm`); `None` is NaN. A date-time without an offset is read as UTC, where
/// JavaScript uses local time, and other formats JavaScript engines accept are NaN here.
pub fn date_parse(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let digits = |at: &mut usize, count: usize| -> Option<i64> {
        let part = bytes.get(*at..*at + count)?;
        part.iter().all(u8::is_ascii_digit).then_some(())?;
        *at += count;
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = match bytes.first() {
        Some(sign @ (b'+' | b'-')) => {
            at = 1;
            let year = digits(&mut at, 6)?;
            (sign == &b'+' || year != 0).then_some(())?;
            if sign == &b'-' { -year } else { year }
        }
        _ => digits(&mut at, 4)?,
    };
    let part = |at: &mut usize, separator: u8, count: usize| -> Option<Option<i64>> {
        match bytes.get(*at) {
            Some(found) if *found == separator => {
                *at += 1;
                digits(at, count).map(Some)
            }
            _ => Some(None),
        }
    };
    let month = part(&mut at, b'-', 2)?;
    let day = match month {
        Some(_) => part(&mut at, b'-', 2)?,
        None => None,
    };
    let (month, day) = (month.unwrap_or(1), day.unwrap_or(1));
    (1..=12).contains(&month).then_some(())?;
    (1..=31).contains(&day).then_some(())?;
    let mut ms = days_from_civil(year, month, day) * 86_400_000;

    if bytes.get(at) == Some(&b'T') {
        at += 1;
        let hour = digits(&mut at, 2)?;
        (bytes.get(at) == Some(&b':')).then_some(())?;
        at += 1;
        let minute = digits(&mut at, 2)?;
        let second = part(&mut at, b':', 2)?;
        let mut millis = 0;

        if second.is_some() && bytes.get(at) == Some(&b'.') {
            at += 1;
            let start = at;

            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            (at > start).then_some(())?;
            millis = format!("{:0<3}", &text[start..at.min(start + 3)])
                .parse()
                .ok()?;
        }
        let second = second.unwrap_or(0);
        let valid = (hour < 24 && minute < 60 && second < 60)
            || (hour == 24 && minute == 0 && second == 0 && millis == 0);
        valid.then_some(())?;
        ms += ((hour * 60 + minute) * 60 + second) * 1000 + millis;

        match bytes.get(at) {
            Some(b'Z') => at += 1,
            Some(sign @ (b'+' | b'-')) => {
                let sign = if *sign == b'+' { 1 } else { -1 };
                at += 1;
                let hours = digits(&mut at, 2)?;
                (bytes.get(at) == Some(&b':')).then_some(())?;
                at += 1;
                let minutes = digits(&mut at, 2)?;
                (hours < 24 && minutes < 60).then_some(())?;
                ms -= sign * (hours * 60 + minutes) * 60_000;
            }
            _ => {}
        }
    }
    // Beyond ±8.64e15 ms a JavaScript Date is invalid.
    (at == bytes.len() && ms.abs() <= 8_640_000_000_000_000).then_some(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_semantics() {
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(1_790_000_000_123), "2026-09-21T14:13:20.123Z");
        assert_eq!(iso_string(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(
            date_parse("2026-09-21T14:13:20.123Z"),
            Some(1_790_000_000_123)
        );
        assert_eq!(date_parse("2000-02-29"), Some(951_782_400_000));
        assert_eq!(date_parse("2000-02-29T01:00+01:00"), Some(951_782_400_000));
        assert_eq!(date_parse("1970"), Some(0));
        assert_eq!(
            date_parse("+002000-02-29T00:00:00.5Z"),
            Some(951_782_400_500)
        );
        for nan in [
            "",
            "garbage",
            "2026-13-01",
            "2026-01-01T25:00Z",
            "-000000",
            "2026-1-1",
        ] {
            assert_eq!(date_parse(nan), None, "{nan}");
        }
        assert_eq!(trim("\u{feff} \u{2028}tok\t\n"), "tok");
        assert_eq!(trim("\u{85}tok"), "\u{85}tok");
        let ordered = parse(br#"{"b":1,"10":2,"a":3,"2":4,"01":5,"4294967295":6}"#).unwrap();
        assert_eq!(
            ordered.to_string(),
            r#"{"2":4,"10":2,"b":1,"a":3,"01":5,"4294967295":6}"#
        );
        assert_eq!(
            parse(b"[1.0,-0,2.5,1e300]").unwrap().to_string(),
            "[1,0,2.5,1e+300]"
        );
        assert_eq!(encode_component("mjólk a/b~'"), "mj%C3%B3lk%20a%2Fb~'");
        assert_eq!(encode_query("a b&c=ð~*"), "a+b%26c%3D%C3%B0%7E*");
    }
}
