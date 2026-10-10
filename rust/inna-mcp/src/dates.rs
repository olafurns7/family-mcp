//! packages/inna-mcp/src/dates.ts: Inna's dates read as UTC, never the host's time zone.

use serde_json::{Map, Value, json};

use crate::js;

/// `z.iso.date()`: `YYYY-MM-DD` naming a real proleptic Gregorian day (year 0000 included).
pub fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &bytes[range];
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(part).ok()?.parse().ok())
            .flatten()
    };

    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (number(0..4), number(5..7), number(8..10)) else {
        return false;
    };
    (1..=12).contains(&month) && (1..=js::days_in_month(year, month)).contains(&day)
}

/// `z.iso.datetime()`: UTC with seconds and an optional fraction.
pub fn is_datetime(text: &str) -> bool {
    js::iso_datetime(text).is_some()
}

/// `^\d{n,m}` on ASCII digits, with the rest of `text`.
fn leading_digits(text: &str, min: usize, max: usize) -> Option<(&str, &str)> {
    let count = text.bytes().take_while(u8::is_ascii_digit).count();
    (min..=max).contains(&count).then(|| text.split_at(count))
}

/// `/^(\d{1,2})\.(\d{1,2})\.(\d{4})(.*)$/`: the Icelandic day-first date, rewritten as ISO.
/// `.` stops at a line terminator, so a rest that holds one is not this form.
fn icelandic(input: &str) -> Option<String> {
    let (day, rest) = leading_digits(input, 1, 2)?;
    let (month, rest) = leading_digits(rest.strip_prefix('.')?, 1, 2)?;
    let rest = rest.strip_prefix('.')?;
    let year = rest
        .get(..4)
        .filter(|year| year.bytes().all(|b| b.is_ascii_digit()))?;
    let rest = &rest[4..];

    if rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(format!("{year}-{month:0>2}-{day:0>2}{rest}"))
}

/// One match of the ISO pattern's time: the hour, minute, second, fraction and offset.
struct Time<'a> {
    hour: &'a str,
    minute: &'a str,
    second: Option<&'a str>,
    fraction: Option<&'a str>,
    offset: Option<&'a str>,
}

/// One match of the ISO pattern: the date, then its time.
struct Iso<'a> {
    date: &'a str,
    time: Option<Time<'a>>,
}

/// `/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/`.
fn iso(source: &str) -> Option<Iso<'_>> {
    let digits = |text: &str| text.bytes().all(|b| b.is_ascii_digit());
    let date = source.get(..10)?;
    let shape = date.as_bytes();

    if !(digits(&date[..4])
        && shape[4] == b'-'
        && digits(&date[5..7])
        && shape[7] == b'-'
        && digits(&date[8..]))
    {
        return None;
    }
    let rest = &source[10..];

    if rest.is_empty() {
        return Some(Iso { date, time: None });
    }
    let rest = rest.strip_prefix(['T', ' '])?;
    let (hour, rest) = leading_digits(rest, 1, 2)?;
    let rest = rest.strip_prefix(':')?;
    let minute = rest.get(..2).filter(|minute| digits(minute))?;
    let mut rest = &rest[2..];
    let (mut second, mut fraction) = (None, None);

    if let Some(after) = rest.strip_prefix(':')
        && let Some(value) = after.get(..2).filter(|value| digits(value))
    {
        second = Some(value);
        rest = &after[2..];

        if let Some(after) = rest.strip_prefix('.')
            && let Some((digits, after)) = leading_digits(after, 1, 3)
        {
            fraction = Some(&rest[..digits.len() + 1]);
            rest = after;
        }
    }
    let offset = match rest {
        "" => None,
        "Z" => Some(rest),
        _ => {
            let bytes = rest.as_bytes();
            (bytes.len() == 6
                && matches!(bytes[0], b'+' | b'-')
                && digits(&rest[1..3])
                && bytes[3] == b':'
                && digits(&rest[4..]))
            .then_some(rest)?;
            Some(rest)
        }
    };
    Some(Iso {
        date,
        time: Some(Time {
            hour,
            minute,
            second,
            fraction,
            offset,
        }),
    })
}

/// `normalizeDate`: Inna's delivered date model passes a numeric date to the Date constructor
/// as milliseconds; text is read as an ISO or Icelandic date, UTC unless it names an offset.
pub fn normalize(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(number) => {
            let ms = number.as_f64()?;

            // z.number().int(): a safe integer.
            if ms.fract() != 0.0 || ms.abs() > 9_007_199_254_740_991.0 {
                return None;
            }

            if ms == 0.0 || !(-62_135_596_800_000.0..=253_402_300_799_999.0).contains(&ms) {
                return None;
            }
            js::iso_string(ms)
        }
        Value::String(text) => {
            let input = js::trim(text);
            let source = icelandic(input).unwrap_or_else(|| input.to_owned());
            let matched = iso(&source)?;

            if matched.date.starts_with("0000-") || !is_date(matched.date) {
                return None;
            }
            let Some(Time {
                hour,
                minute,
                second,
                fraction,
                offset,
            }) = matched.time
            else {
                return Some(matched.date.to_owned());
            };
            let number = |text: &str| text.parse::<i64>().unwrap_or(i64::MAX);
            let second = second.unwrap_or("00");

            if number(hour) > 23 || number(minute) > 59 || number(second) > 59 {
                return None;
            }
            let offset = offset.unwrap_or("Z");
            let shift = match offset {
                "Z" => 0,
                _ => {
                    let (hours, minutes) = (number(&offset[1..3]), number(&offset[4..]));

                    if hours > 23 || minutes > 59 {
                        return None;
                    }
                    let minutes = hours * 60 + minutes;
                    if offset.starts_with('-') {
                        -minutes
                    } else {
                        minutes
                    }
                }
            };
            let ms = fraction.map_or(0, |fraction| {
                let digits = &fraction[1..];
                number(digits) * 10_i64.pow(3 - digits.len() as u32)
            });
            let year = number(&matched.date[..4]);
            let month = number(&matched.date[5..7]);
            let day = number(&matched.date[8..]);
            let at = js::utc(
                year,
                month,
                day,
                number(hour),
                number(minute),
                number(second),
                ms,
            ) - (shift * 60_000) as f64;
            let result = js::iso_string(at)?;
            is_datetime(&result).then_some(result)
        }
        _ => None,
    }
}

/// `parseDates`: each field's normalized date and whether it was parsed, missing or unrecognized.
pub fn parse<'a>(fields: impl IntoIterator<Item = (&'a str, Option<&'a Value>)>) -> Value {
    let mut parsed = Map::new();

    for (field, value) in fields {
        let iso = normalize(value);
        let empty = match value {
            None | Some(Value::Null) => true,
            Some(Value::Number(number)) => number.as_f64() == Some(0.0),
            Some(Value::String(text)) => js::trim(text).is_empty(),
            _ => false,
        };
        let status = match (&iso, empty) {
            (Some(_), _) => "parsed",
            (None, true) => "missing",
            (None, false) => "unrecognized",
        };
        parsed.insert(field.to_owned(), json!({ "iso": iso, "status": status }));
    }
    Value::Object(parsed)
}

/// `datesSchema`: a record of `{iso, status}`, as an upstream record could carry one.
pub fn valid_record(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    record.values().all(|entry| {
        let iso = match entry.get("iso") {
            Some(Value::Null) => true,
            Some(Value::String(text)) => is_date(text) || is_datetime(text),
            _ => false,
        };
        let status = matches!(
            entry.get("status").and_then(Value::as_str),
            Some("parsed" | "missing" | "unrecognized")
        );
        entry.is_object() && iso && status
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Option<String> {
        normalize(Some(&json!(value)))
    }

    #[test]
    fn dates_normalize_as_typescript() {
        for (input, output) in [
            ("02.01.2040", Some("2040-01-02")),
            ("2.1.2040 10:00", Some("2040-01-02T10:00:00.000Z")),
            ("2040-01-02T10:00:00", Some("2040-01-02T10:00:00.000Z")),
            ("2040-01-02 9:05:07.5", Some("2040-01-02T09:05:07.500Z")),
            (
                "2040-01-02T10:00:00+01:30",
                Some("2040-01-02T08:30:00.000Z"),
            ),
            (" 2040-01-02 ", Some("2040-01-02")),
            (
                "0001-01-01T00:30:00+01:00",
                Some("0000-12-31T23:30:00.000Z"),
            ),
            ("9999-12-31T23:30:00-01:00", None),
            ("0000-01-01", None),
            ("2040-02-30", None),
            ("2040-01-02T24:00", None),
            ("2040-01-02T10:00:00+24:00", None),
            ("2040-01-02T10:00:00.1234", None),
            ("02.01.2040\n10:00", None),
            ("", None),
            ("soon", None),
        ] {
            assert_eq!(text(input).as_deref(), output, "{input}");
        }
        assert_eq!(
            normalize(Some(&json!(1))).as_deref(),
            Some("1970-01-01T00:00:00.001Z")
        );
        assert_eq!(normalize(Some(&json!(0))), None);
        assert_eq!(normalize(Some(&json!(1.5))), None);
        assert_eq!(normalize(Some(&json!(253_402_300_800_000_i64))), None);
        assert_eq!(normalize(Some(&json!(true))), None);
    }

    #[test]
    fn statuses_distinguish_missing_from_unrecognized() {
        let blank = json!("  ");
        let zero = json!(0);
        let bad = json!("x");
        let good = json!("02.01.2040");
        assert_eq!(
            parse([
                ("a", None),
                ("b", Some(&blank)),
                ("c", Some(&zero)),
                ("d", Some(&bad)),
                ("e", Some(&good)),
            ]),
            json!({
                "a": { "iso": null, "status": "missing" },
                "b": { "iso": null, "status": "missing" },
                "c": { "iso": null, "status": "missing" },
                "d": { "iso": null, "status": "unrecognized" },
                "e": { "iso": "2040-01-02", "status": "parsed" },
            })
        );
        assert!(valid_record(
            &json!({ "x": { "iso": "2040-01-02", "status": "parsed" } })
        ));
        assert!(!valid_record(
            &json!({ "x": { "iso": 1, "status": "parsed" } })
        ));
        assert!(!valid_record(&json!([])));
    }
}
