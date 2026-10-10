//! The JavaScript semantics the TypeScript server inherits from its runtime and zod: numbers,
//! strings, dates, JSON, UUIDs, `localeCompare` and SHA-256 hex digests.

use std::cmp::Ordering;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use serde_json::{Map, Number, Value};

/// Number.MAX_SAFE_INTEGER, the bound of zod's `int()`.
pub const SAFE: f64 = 9_007_199_254_740_991.0;

/// `Date.now()`: whole milliseconds since the epoch.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// JavaScript's white space and line terminators: `\s`, and what `trim` removes.
pub fn is_space(c: char) -> bool {
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

/// `Number(text)`: decimal, or `0x`, `0o` and `0b` integers; anything else is NaN.
pub fn number(text: &str) -> f64 {
    let text = trim(text);
    let radix = |prefix: [&str; 2], radix| {
        prefix
            .iter()
            .find_map(|prefix| text.strip_prefix(prefix))
            .map(|digits| match digits {
                "" => f64::NAN,
                _ => u128::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64),
            })
    };
    radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
        .unwrap_or_else(|| match text {
            "" => 0.0,
            "Infinity" | "+Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            // Rust also reads "inf" and "nan"; JavaScript reads neither.
            _ if text
                .bytes()
                .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) =>
            {
                text.parse().unwrap_or(f64::NAN)
            }
            _ => f64::NAN,
        })
}

/// A string's length as zod 4.6 checks it: Unicode code points, not UTF-16 units.
pub fn length(text: &str) -> usize {
    text.chars().count()
}

/// `text.length`: UTF-16 code units.
pub fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` in UTF-16 code units. A surrogate pair cut in half loses its high
/// half here, where JavaScript keeps it as a lone surrogate no Rust string can hold.
pub fn slice_units(text: &str, max: usize) -> &str {
    let mut used = 0;

    for (at, c) in text.char_indices() {
        used += c.len_utf16();

        if used > max {
            return &text[..at];
        }
    }
    text
}

/// `URLSearchParams`' serialization of one name or value (application/x-www-form-urlencoded).
pub fn encode_query(text: &str) -> String {
    let mut encoded = String::new();

    for byte in text.bytes() {
        match byte {
            b' ' => encoded.push('+'),
            _ if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) => {
                encoded.push(char::from(byte));
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// `decodeURI`: escapes of UTF-8 decoded, except those of `;/?:@&=+$,#`; `None` where it throws.
pub fn decode_uri(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u8> {
        let pair = bytes.get(at + 1..at + 3)?;
        u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
    };
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;

    while at < bytes.len() {
        if bytes[at] != b'%' {
            decoded.push(bytes[at]);
            at += 1;
            continue;
        }
        let first = hex(at)?;

        if first < 0x80 {
            match b";/?:@&=+$,#".contains(&first) {
                true => decoded.extend_from_slice(&bytes[at..at + 3]),
                false => decoded.push(first),
            }
            at += 3;
            continue;
        }
        let width = match first {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut sequence = vec![first];

        for index in 1..width {
            let next = at + 3 * index;
            (bytes.get(next) == Some(&b'%')).then_some(())?;
            sequence.push(hex(next)?);
        }
        decoded.extend_from_slice(std::str::from_utf8(&sequence).ok()?.as_bytes());
        at += 3 * width;
    }
    String::from_utf8(decoded).ok()
}

/// `left.localeCompare(right)`: ICU's root collation, which Bun's default locale uses.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), CollatorOptions::default())
                .expect("the compiled root collation data")
        })
        .compare(left, right)
}

/// `createHash('sha256').update(text).digest('hex')`.
pub fn sha256_hex(text: &str) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
pub fn number_value(value: f64) -> Value {
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
        Value::Number(number) => number_value(number.as_f64().unwrap_or(f64::NAN)),
        other => other,
    }
}

/// `JSON.parse` of text.
pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok().map(normalize)
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

/// zod's `uuid()`: an RFC 9562 UUID of version 1 to 8, or the nil or (lowercase) max UUID.
pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();

    if text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_cycle - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let of_era = days - era * 146_097;
    let of_cycle = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * of_cycle + of_cycle / 4 - of_cycle / 100);
    let month_index = (5 * of_year + 2) / 153;
    let day = of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    (of_cycle + era * 400 + i64::from(month <= 2), month, day)
}

fn leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// UTC fields to epoch milliseconds.
fn utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> f64 {
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000 + ms) as f64
}

/// `new Date(ms).toISOString()` for dates within years 0 to 9999.
pub fn iso_string(ms: f64) -> String {
    let ms = ms as i64;
    let (days, of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

fn digits(text: &[u8]) -> Option<i64> {
    (!text.is_empty() && text.iter().all(u8::is_ascii_digit))
        .then(|| std::str::from_utf8(text).ok()?.parse().ok())
        .flatten()
}

/// zod's `z.iso.datetime()`: `YYYY-MM-DDTHH:MM:SS[.fraction]Z` with a valid calendar date, read
/// as `Date.parse` reads it (milliseconds truncated).
pub fn iso_datetime(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();

    if bytes.len() < 20 || bytes.last() != Some(&b'Z') {
        return None;
    }
    let field = |range: std::ops::Range<usize>| digits(&bytes[range]);
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];

    if separators.iter().any(|(at, byte)| bytes[*at] != *byte) {
        return None;
    }
    let (year, month, day) = (field(0..4)?, field(5..7)?, field(8..10)?);
    let (hour, minute, second) = (field(11..13)?, field(14..16)?, field(17..19)?);
    let fraction = &bytes[19..bytes.len() - 1];
    let ms = match fraction {
        [] => 0,
        [b'.', rest @ ..] if !rest.is_empty() && rest.iter().all(u8::is_ascii_digit) => {
            let mut padded = rest.iter().take(3).map(|digit| i64::from(digit - b'0'));
            (0..3).fold(0, |ms, _| ms * 10 + padded.next().unwrap_or(0))
        }
        _ => return None,
    };

    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(utc(year, month, day, hour, minute, second, ms))
}

/// `Date.parse` for the forms an HTTP date takes: an ISO date-time ending in `Z`, or
/// `[Day,] DD Mon YYYY HH:MM:SS GMT` (also `UTC` or a `+HHMM` offset). NaN for anything else,
/// where JavaScript's own parser may still read a few more forms.
pub fn parse_date(text: &str) -> f64 {
    let text = trim(text);

    if let Some(ms) = iso_datetime(text) {
        return ms;
    }
    let words: Vec<&str> = text.split_ascii_whitespace().collect();
    let words = match words.first() {
        Some(first) if first.ends_with(',') || first.chars().all(char::is_alphabetic) => {
            &words[1..]
        }
        _ => &words[..],
    };
    let [day, month, year, time, zone] = words else {
        return f64::NAN;
    };
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month = months
        .iter()
        .position(|name| month.to_ascii_lowercase().starts_with(name))
        .map(|index| index as i64 + 1);
    let clock: Vec<Option<i64>> = time
        .split(':')
        .map(|part| digits(part.as_bytes()))
        .collect();
    let offset = match zone.to_ascii_uppercase().as_str() {
        "GMT" | "UTC" | "Z" | "UT" => Some(0),
        zone => zone
            .strip_prefix(['+', '-'])
            .filter(|digits| digits.len() == 4)
            .and_then(|hhmm| self::digits(hhmm.as_bytes()))
            .map(|hhmm| {
                let minutes = hhmm / 100 * 60 + hhmm % 100;
                if zone.starts_with('-') {
                    -minutes
                } else {
                    minutes
                }
            }),
    };
    let (Some(day), Some(month), Some(year), Some(offset)) = (
        digits(day.as_bytes()),
        month,
        digits(year.as_bytes()),
        offset,
    ) else {
        return f64::NAN;
    };
    let (hour, minute, second) = match clock[..] {
        [Some(hour), Some(minute)] => (hour, minute, 0),
        [Some(hour), Some(minute), Some(second)] => (hour, minute, second),
        _ => return f64::NAN,
    };

    // JavaScriptCore rolls a day past the month's end into the next month.
    if !(1..=31).contains(&day) || hour > 24 || minute > 59 || second > 59 {
        return f64::NAN;
    }
    utc(year, month, day, hour, minute, second, 0) - (offset * 60_000) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_strings() {
        assert_eq!(trim("\u{feff} a\u{85}"), "a\u{85}");

        for (text, value) in [
            ("  5 ", 5.0),
            ("0x10", 16.0),
            ("0b11", 3.0),
            ("1e3", 1000.0),
            ("+7", 7.0),
            ("5.", 5.0),
            (".5", 0.5),
            ("", 0.0),
            (" \n", 0.0),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(number(text), value, "{text}");
        }

        for text in ["inf", "nan", "0x", "1_0", "--1", "1e", "0x-1", "Infinityx"] {
            assert!(number(text).is_nan(), "{text}");
        }
        assert_eq!(units("a\u{10000}"), 3);
        assert_eq!(length("a\u{10000}"), 2);
        assert_eq!(slice_units("ab\u{10000}c", 3), "ab");
        assert_eq!(slice_units("ab\u{10000}c", 4), "ab\u{10000}");
        assert_eq!(slice_units("abc", 9), "abc");
        assert_eq!(encode_query("a b&c=ð*~"), "a+b%26c%3D%C3%B0*%7E");
        assert_eq!(
            decode_uri("/a%20b/%2F%3f/%C3%B0%41").as_deref(),
            Some("/a b/%2F%3f/ðA")
        );

        for invalid in [
            "/%",
            "/%4",
            "/%zz",
            "/%C3",
            "/%C3%41",
            "/%FF",
            "/%ED%A0%80",
            "/%C0%80",
        ] {
            assert_eq!(decode_uri(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn locale_compare_is_icu_root_collation() {
        assert_eq!(locale_compare("a", "B"), Ordering::Less);
        assert_eq!(locale_compare("B", "a"), Ordering::Greater);
        assert_eq!(locale_compare("á", "b"), Ordering::Less);
        assert_eq!(locale_compare("x", "x"), Ordering::Equal);
    }

    #[test]
    fn digests_and_json() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let ordered = parse(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"b":6}"#).unwrap();
        assert_eq!(ordered.to_string(), r#"{"2":4,"10":2,"b":6,"a":3,"01":5}"#);
        assert_eq!(
            parse("[1.0,-0,2.5,1e300]").unwrap().to_string(),
            "[1,0,2.5,1e+300]"
        );
    }

    #[test]
    fn uuids_match_zod() {
        let made = uuid().unwrap();
        assert!(is_uuid(&made), "{made}");

        for valid in [
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
            "a0eebc99-9c0b-8ef8-9b6d-6bb9bd380a11",
        ] {
            assert!(is_uuid(valid), "{valid}");
        }

        for invalid in [
            "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
            "a0eebc99-9c0b-0ef8-bb6d-6bb9bd380a11",
            "a0eebc99-9c0b-4ef8-cb6d-6bb9bd380a11",
            "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1",
            "a0eebc999c0b-4ef8-bb6d-6bb9bd380a11-",
        ] {
            assert!(!is_uuid(invalid), "{invalid}");
        }
    }

    #[test]
    fn dates_match_javascript() {
        assert_eq!(iso_string(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(1_789_118_656_789.0), "2026-09-11T09:24:16.789Z");
        assert_eq!(iso_string(951_782_400_000.0), "2000-02-29T00:00:00.000Z");
        assert_eq!(
            iso_datetime("2026-09-11T09:24:16.789Z"),
            Some(1_789_118_656_789.0)
        );
        assert_eq!(
            iso_datetime("2026-09-11T09:24:16.78999Z"),
            Some(1_789_118_656_789.0)
        );
        assert_eq!(
            iso_datetime("2026-09-11T09:24:16Z"),
            Some(1_789_118_656_000.0)
        );
        assert_eq!(
            iso_datetime("2000-02-29T00:00:00Z"),
            Some(951_782_400_000.0)
        );

        for invalid in [
            "2026-09-11T09:24Z",
            "2026-09-11T09:24:16.Z",
            "2026-09-11T09:24:16+00:00",
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-09-11T24:00:00Z",
            "2026-09-11 09:24:16Z",
            "２026-09-11T09:24:16Z",
        ] {
            assert_eq!(iso_datetime(invalid), None, "{invalid}");
        }
        assert_eq!(
            parse_date("Fri, 11 Sep 2026 09:24:16 GMT"),
            1_789_118_656_000.0
        );
        assert_eq!(
            parse_date("11 Sep 2026 10:24:16 +0100"),
            1_789_118_656_000.0
        );
        assert!(parse_date("soon").is_nan());
        assert_eq!(
            parse_date("Fri, 31 Sep 2026 09:24:16 GMT"),
            1_790_846_656_000.0
        );
        assert!(parse_date("Fri, 32 Sep 2026 09:24:16 GMT").is_nan());
    }
}
