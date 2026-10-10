//! The JavaScript semantics the TypeScript server inherits from its runtime: the shared ones of
//! rust/browser-login, and the string, date and digest ones only Inna reads. The date, UUID and
//! decoding functions are rust/infomentor-mcp's, which its parity suite checks against Bun.

use std::time::{SystemTime, UNIX_EPOCH};

pub use browser_login::js::*;

/// `Date.now()`, or in a test build the clock in the file INNA_TEST_NOW names, read at each use as
/// a test's `now()` is called: the client's `now`, which stamps results and times pauses and
/// previews. Cookies always use the real clock.
pub fn client_now() -> f64 {
    #[cfg(feature = "test-origin")]
    if let Some(file) = std::env::var_os("INNA_TEST_NOW") {
        return std::fs::read_to_string(file)
            .ok()
            .and_then(|now| now.trim().parse::<f64>().ok())
            .expect("INNA_TEST_NOW must name a file holding the test clock.");
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
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

/// `encodeURIComponent` of a well-formed string: every UTF-8 byte escaped but the unreserved
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
pub fn encode_uri_component(text: &str) -> String {
    let mut encoded = String::new();

    for byte in text.bytes() {
        match byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            true => encoded.push(char::from(byte)),
            false => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// `decodeURI`: escapes of UTF-8 decoded, except those of `;/?:@&=+$,#`; `None` where it throws.
pub fn decode_uri(text: &str) -> Option<String> {
    decode(text, b";/?:@&=+$,#")
}

/// `decodeURIComponent`: every escape of UTF-8 decoded; `None` where it throws.
pub fn decode_uri_component(text: &str) -> Option<String> {
    decode(text, b"")
}

/// The spec's `Decode`: an escaped ASCII byte in `reserved` stays escaped.
fn decode(text: &str, reserved: &[u8]) -> Option<String> {
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u8> {
        let pair = bytes.get(at + 1..at + 3)?;
        pair.iter()
            .all(u8::is_ascii_hexdigit)
            .then(|| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
            .flatten()
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
            match reserved.contains(&first) {
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

/// `createHash('sha256').update(text).digest('hex')`.
pub fn sha256_hex(text: &str) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
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

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// UTC fields to epoch milliseconds.
pub fn utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> f64 {
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000 + ms) as f64
}

/// `new Date(ms).toISOString()`, extended years included; `None` where it throws (outside
/// ±8.64e15 ms, or not a number).
pub fn iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.trunc() as i64;
    let (days, of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    let year = match year {
        0..=9999 => format!("{year:04}"),
        _ if year < 0 => format!("-{:06}", -year),
        _ => format!("+{year:06}"),
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    ))
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
    fn strings_match_javascript() {
        assert_eq!(units("a\u{10000}"), 3);
        assert_eq!(slice_units("ab\u{10000}c", 3), "ab");
        assert_eq!(slice_units("ab\u{10000}c", 4), "ab\u{10000}");
        assert_eq!(slice_units("abc", 9), "abc");
        assert_eq!(
            decode_uri("/a%20b/%2F%3f/%C3%B0%41").as_deref(),
            Some("/a b/%2F%3f/ðA")
        );
        assert_eq!(decode_uri("/%C3"), None);
        assert_eq!(decode_uri("%+f"), None);
        assert_eq!(
            decode_uri_component("a%2Fb%3F%C3%B0").as_deref(),
            Some("a/b?ð")
        );
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
        assert_eq!(
            encode_uri_component("/connect/authorize/callback?state=a b&ð~'()*!"),
            "%2Fconnect%2Fauthorize%2Fcallback%3Fstate%3Da%20b%26%C3%B0~'()*!"
        );
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn dates_match_javascript() {
        assert_eq!(iso_string(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(
            iso_string(-62_135_596_800_000.0).as_deref(),
            Some("0001-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_string(253_402_300_800_000.0).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_string(-62_198_755_200_000.0).as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(iso_string(8.64e15 + 1.0), None);
        assert_eq!(
            iso_datetime("2040-01-02T12:00:00.000Z"),
            Some(2_209_118_400_000.0)
        );
        assert_eq!(iso_datetime("2040-02-30T12:00:00Z"), None);
        assert_eq!(
            parse_date("Mon, 02 Jan 2040 12:02:00 GMT"),
            2_209_118_520_000.0
        );
        assert!(parse_date("soon").is_nan());
    }
}
