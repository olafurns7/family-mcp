//! Tool input validation with the TypeScript server's results: the same accepted values,
//! defaults, and zod 4 issue messages, order and abort rules, so an invalid call gets the same
//! text. The advertised JSON Schemas are the TypeScript server's own (`surface.json`).

use serde_json::{Map, Value};

use crate::js;

const ID: (usize, usize) = (1, 256);

const CURSOR: (usize, usize) = (1, 1024);

const TYPES: [&str; 4] = ["TRAINING", "MATCH", "GENERAL", "CLASSES"];

// Number.MAX_SAFE_INTEGER, the bound of zod's `int()`.
const SAFE: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Schedule {
    pub from: Option<String>,
    pub to: Option<String>,
    pub types: Option<Vec<String>>,
    pub group_ids: Option<Vec<String>>,
    pub participant_ids: Option<Vec<String>>,
    pub first: u32,
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChildSchedules {
    pub filters: Schedule,
    pub child_ids: Option<Vec<String>>,
    /// In JavaScript key order.
    pub after_by_child: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub event_id: String,
    pub age_group_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub first: u32,
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Messages {
    pub conversation_id: String,
    pub page: Page,
}

struct Issue {
    path: Vec<String>,
    message: String,
    /// zod's `continue`: a failed check keeps later checks and refinements running; a wrong type
    /// does not.
    continues: bool,
}

/// The issues of one parse, at one path.
struct Parse<'a> {
    issues: &'a mut Vec<Issue>,
    path: Vec<String>,
}

fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

impl Parse<'_> {
    fn at(&mut self, key: &str) -> Parse<'_> {
        let mut path = self.path.clone();
        path.push(key.to_owned());
        Parse {
            issues: self.issues,
            path,
        }
    }

    fn issue(&mut self, message: String, continues: bool) {
        self.issues.push(Issue {
            path: self.path.clone(),
            message,
            continues,
        });
    }

    fn wrong_type(&mut self, expected: &str, value: Option<&Value>) {
        self.issue(
            format!(
                "Invalid input: expected {expected}, received {}",
                kind(value)
            ),
            false,
        );
    }

    /// zod's length checks run on anything with a length, even after a wrong type. An object
    /// with its own `length` property is not counted here (see the pilot report).
    fn length(&mut self, value: Option<&Value>, (min, max): (usize, usize)) {
        let (origin, unit, length) = match value {
            Some(Value::String(text)) => ("string", "characters", js::length(text)),
            Some(Value::Array(items)) => ("array", "items", items.len()),
            _ => return,
        };

        if length < min {
            self.issue(
                format!("Too small: expected {origin} to have >={min} {unit}"),
                true,
            );
        }

        if length > max {
            self.issue(
                format!("Too big: expected {origin} to have <={max} {unit}"),
                true,
            );
        }
    }

    /// `z.string().min(min).max(max)`.
    fn string(&mut self, value: Option<&Value>, bounds: (usize, usize)) -> Option<String> {
        let text = value.and_then(Value::as_str).map(str::to_owned);

        if text.is_none() {
            self.wrong_type("string", value);
        }
        self.length(value, bounds);
        text
    }

    /// `z.iso.date()`.
    fn date(&mut self, value: Option<&Value>) -> Option<String> {
        let Some(text) = value.and_then(Value::as_str) else {
            self.wrong_type("string", value);
            return None;
        };

        if !iso_date(text) {
            self.issue("Invalid ISO date".to_owned(), true);
        }
        Some(text.to_owned())
    }

    /// `z.number().int().min(1).max(max).default(20)`.
    fn first(&mut self, value: Option<&Value>, max: u32) -> u32 {
        let Some(value) = value else {
            return 20;
        };
        let Some(number) = value.as_f64() else {
            self.wrong_type("number", Some(value));
            return 0;
        };

        if number.fract() != 0.0 {
            self.wrong_type("int", Some(value));
            return 0;
        }

        if number > SAFE {
            self.issue(format!("Too big: expected int to be <={SAFE}"), true);
        } else if number < -SAFE {
            self.issue(format!("Too small: expected int to be >=-{SAFE}"), true);
        }

        if number < 1.0 {
            self.issue("Too small: expected number to be >=1".to_owned(), true);
        }

        if number > f64::from(max) {
            self.issue(format!("Too big: expected number to be <={max}"), true);
        }
        number as u32
    }

    /// `z.array(element).min(min).max(max)`.
    fn array<T>(
        &mut self,
        value: Option<&Value>,
        bounds: (usize, usize),
        mut element: impl FnMut(&mut Parse, &Value) -> Option<T>,
    ) -> Option<Vec<T>> {
        let parsed = match value {
            Some(Value::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(index, item)| element(&mut self.at(&index.to_string()), item))
                .collect(),
            _ => {
                self.wrong_type("array", value);
                None
            }
        };
        self.length(value, bounds);
        parsed
    }

    fn types(&mut self, value: Option<&Value>) -> Option<Vec<String>> {
        self.array(value, (0, 4), |parse, item| {
            let name = item.as_str().filter(|name| TYPES.contains(name));

            if name.is_none() {
                parse.issue(
                    r#"Invalid option: expected one of "TRAINING"|"MATCH"|"GENERAL"|"CLASSES""#
                        .to_owned(),
                    false,
                );
            }
            name.map(str::to_owned)
        })
    }

    fn ids(&mut self, value: Option<&Value>, max: usize) -> Option<Vec<String>> {
        self.array(value, (1, max), |parse, item| parse.string(Some(item), ID))
    }

    /// `z.record(id, cursor)`, skipping `__proto__` as zod does.
    fn cursors(&mut self, value: Option<&Value>) -> Option<Vec<(String, String)>> {
        let Some(Value::Object(map)) = value else {
            self.wrong_type("record", value);
            return None;
        };
        let mut entries = Some(Vec::new());

        for (key, item) in js::order(map.clone()) {
            if key == "__proto__" {
                continue;
            }

            if !(ID.0..=ID.1).contains(&js::length(&key)) {
                self.at(&key)
                    .issue("Invalid key in record".to_owned(), false);
                entries = None;
                continue;
            }
            let cursor = self.at(&key).string(Some(&item), CURSOR);

            if let (Some(entries), Some(cursor)) = (entries.as_mut(), cursor) {
                entries.push((key, cursor));
            }
        }
        entries
    }
}

/// zod's ISO date pattern: four ASCII digits, a valid month and day, February 29 only in leap
/// years.
fn iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();

    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| {
        bytes[range.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| text[range].parse::<u32>().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// A strict object: properties in schema order, then unknown keys, then the refinement when
/// nothing aborted. Returns the zod error text, as `path: message` joined with `, `.
fn object<T>(
    arguments: &Map<String, Value>,
    shape: &[&str],
    parse: impl FnOnce(&mut Parse, &Map<String, Value>) -> T,
    refine: impl FnOnce(&T) -> Option<&'static str>,
) -> Result<T, String> {
    let mut issues = Vec::new();
    let mut root = Parse {
        issues: &mut issues,
        path: Vec::new(),
    };
    let parsed = parse(&mut root, arguments);
    let unknown: Vec<String> = js::order(arguments.clone())
        .into_iter()
        .map(|(key, _)| key)
        .filter(|key| !shape.contains(&key.as_str()))
        .map(|key| Value::String(key).to_string())
        .collect();

    if !unknown.is_empty() {
        let plural = if unknown.len() > 1 { "s" } else { "" };
        root.issue(
            format!("Unrecognized key{plural}: {}", unknown.join(", ")),
            true,
        );
    }

    if issues.iter().all(|issue| issue.continues)
        && let Some(message) = refine(&parsed)
    {
        issues.push(Issue {
            path: Vec::new(),
            message: message.to_owned(),
            continues: true,
        });
    }

    if issues.is_empty() {
        return Ok(parsed);
    }
    Err(issues
        .iter()
        .map(|issue| match issue.path.is_empty() {
            true => issue.message.clone(),
            false => format!("{}: {}", issue.path.join("."), issue.message),
        })
        .collect::<Vec<_>>()
        .join(", "))
}

fn optional<'a, T>(
    parse: &mut Parse,
    arguments: &'a Map<String, Value>,
    key: &str,
    field: impl FnOnce(&mut Parse, Option<&'a Value>) -> Option<T>,
) -> Option<T> {
    let value = arguments.get(key)?;
    field(&mut parse.at(key), Some(value))
}

const IN_ORDER: &str = "from must be on or before to";

fn in_order(from: &Option<String>, to: &Option<String>) -> Option<&'static str> {
    match (from, to) {
        (Some(from), Some(to)) if !from.is_empty() && !to.is_empty() => {
            (js::compare(from, to).is_gt()).then_some(IN_ORDER)
        }
        _ => None,
    }
}

pub fn empty(arguments: &Map<String, Value>) -> Result<(), String> {
    object(arguments, &[], |_, _| (), |_| None)
}

pub fn schedule(arguments: &Map<String, Value>) -> Result<Schedule, String> {
    const SHAPE: [&str; 7] = [
        "from",
        "to",
        "types",
        "groupIds",
        "participantIds",
        "first",
        "after",
    ];
    object(
        arguments,
        &SHAPE,
        |parse, args| Schedule {
            from: optional(parse, args, "from", |p, v| p.date(v)),
            to: optional(parse, args, "to", |p, v| p.date(v)),
            types: optional(parse, args, "types", |p, v| p.types(v)),
            group_ids: optional(parse, args, "groupIds", |p, v| p.ids(v, 50)),
            participant_ids: optional(parse, args, "participantIds", |p, v| p.ids(v, 20)),
            first: parse.at("first").first(args.get("first"), 100),
            after: optional(parse, args, "after", |p, v| p.string(v, CURSOR)),
        },
        |parsed| in_order(&parsed.from, &parsed.to),
    )
}

pub fn child_schedules(arguments: &Map<String, Value>) -> Result<ChildSchedules, String> {
    const SHAPE: [&str; 7] = [
        "from",
        "to",
        "types",
        "groupIds",
        "first",
        "childIds",
        "afterByChild",
    ];
    object(
        arguments,
        &SHAPE,
        |parse, args| ChildSchedules {
            filters: Schedule {
                from: optional(parse, args, "from", |p, v| p.date(v)),
                to: optional(parse, args, "to", |p, v| p.date(v)),
                types: optional(parse, args, "types", |p, v| p.types(v)),
                group_ids: optional(parse, args, "groupIds", |p, v| p.ids(v, 50)),
                participant_ids: None,
                first: parse.at("first").first(args.get("first"), 100),
                after: None,
            },
            child_ids: optional(parse, args, "childIds", |p, v| p.ids(v, 20)),
            after_by_child: optional(parse, args, "afterByChild", |p, v| p.cursors(v))
                .unwrap_or_default(),
        },
        |parsed| in_order(&parsed.filters.from, &parsed.filters.to),
    )
}

pub fn event(arguments: &Map<String, Value>) -> Result<Event, String> {
    object(
        arguments,
        &["eventId", "ageGroupId"],
        |parse, args| Event {
            event_id: parse
                .at("eventId")
                .string(args.get("eventId"), ID)
                .unwrap_or_default(),
            age_group_id: parse
                .at("ageGroupId")
                .string(args.get("ageGroupId"), ID)
                .unwrap_or_default(),
        },
        |_| None,
    )
}

fn page(parse: &mut Parse, args: &Map<String, Value>) -> Page {
    Page {
        first: parse.at("first").first(args.get("first"), 50),
        after: optional(parse, args, "after", |p, v| p.string(v, CURSOR)),
    }
}

pub fn conversations(arguments: &Map<String, Value>) -> Result<Page, String> {
    object(arguments, &["first", "after"], page, |_| None)
}

pub fn messages(arguments: &Map<String, Value>) -> Result<Messages, String> {
    object(
        arguments,
        &["conversationId", "first", "after"],
        |parse, args| Messages {
            conversation_id: parse
                .at("conversationId")
                .string(args.get("conversationId"), ID)
                .unwrap_or_default(),
            page: page(parse, args),
        },
        |_| None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn iso_dates_follow_zod() {
        for valid in ["2024-02-29", "0000-02-29", "2000-02-29", "2026-12-31"] {
            assert!(iso_date(valid), "{valid}");
        }
        for invalid in [
            "2023-02-29",
            "1900-02-29",
            "2026-13-01",
            "2026-9-01",
            "2026-01-00",
            "２０２６-01-01",
        ] {
            assert!(!iso_date(invalid), "{invalid}");
        }
    }

    #[test]
    fn issues_match_the_typescript_text() {
        assert_eq!(
            schedule(&args(json!({"first": 1.5, "groupIds": []}))).unwrap_err(),
            "groupIds: Too small: expected array to have >=1 items, first: Invalid input: expected int, received number"
        );
        assert_eq!(
            schedule(&args(json!({"types": "TRAINING"}))).unwrap_err(),
            "types: Invalid input: expected array, received string, types: Too big: expected string to have <=4 characters"
        );
        assert_eq!(
            schedule(&args(
                json!({"zzz": 1, "0": 2, "from": "2026-09-30", "to": "2026-09-11"})
            ))
            .unwrap_err(),
            r#"Unrecognized keys: "0", "zzz", from must be on or before to"#
        );
        assert_eq!(
            schedule(&args(json!({"first": 1e20}))).unwrap_err(),
            "first: Too big: expected int to be <=9007199254740991, first: Too big: expected number to be <=100"
        );
        assert_eq!(schedule(&args(json!({}))).unwrap().first, 20);
    }
}
