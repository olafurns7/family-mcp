//! Tool input validation with the TypeScript server's results: the same accepted values,
//! defaults, and zod 4 issue messages, order and abort rules, so an invalid call gets the same
//! text. The advertised JSON Schemas are the TypeScript server's own (`surface.json`).

pub use mcp_runtime::input::empty;
use mcp_runtime::input::{Parse, object, optional};
use serde_json::{Map, Value};

use crate::absence::Request;
use crate::dates;
use crate::js;
use crate::shapes::is_letter;

const SAFE: f64 = 9_007_199_254_740_991.0;

/// `dateRange`.
#[derive(Debug, Clone, PartialEq)]
pub struct Range {
    pub date_from: String,
    pub date_to: String,
    pub student_key: Option<String>,
}

/// Inna's fields, on top of the runtime's strings.
trait Fields {
    fn id(&mut self, value: Option<&Value>) -> Option<String>;

    fn date(&mut self, value: Option<&Value>) -> Option<String>;

    fn int(&mut self, value: Option<&Value>) -> Option<f64>;
}

impl Fields for Parse<'_> {
    /// `id`: `z.string().regex(/^\d+$/).max(32)`.
    fn id(&mut self, value: Option<&Value>) -> Option<String> {
        let Some(text) = value.and_then(Value::as_str) else {
            self.wrong_type("string", value);
            return None;
        };

        if !text.bytes().all(|byte| byte.is_ascii_digit()) || text.is_empty() {
            self.issue(
                "Invalid string: must match pattern /^\\d+$/".to_owned(),
                true,
            );
        }
        self.length(value, (0, 32));
        Some(text.to_owned())
    }

    /// `z.iso.date()`.
    fn date(&mut self, value: Option<&Value>) -> Option<String> {
        let Some(text) = value.and_then(Value::as_str) else {
            self.wrong_type("string", value);
            return None;
        };

        if !dates::is_date(text) {
            self.issue("Invalid ISO date".to_owned(), true);
        }
        Some(text.to_owned())
    }

    /// `z.number().int().min(1)`.
    fn int(&mut self, value: Option<&Value>) -> Option<f64> {
        let Some(number) = value.and_then(Value::as_f64) else {
            self.wrong_type("number", value);
            return None;
        };

        if number.fract() != 0.0 {
            self.wrong_type("int", value);
            return None;
        }

        if number > SAFE {
            self.issue(format!("Too big: expected int to be <={SAFE}"), true);
        } else if number < -SAFE {
            self.issue(format!("Too small: expected int to be >=-{SAFE}"), true);
        }

        if number < 1.0 {
            self.issue("Too small: expected number to be >=1".to_owned(), true);
        }
        Some(number)
    }
}

/// `studentKey`, optional.
fn student_key(parse: &mut Parse, arguments: &Map<String, Value>) -> Option<String> {
    optional(parse, arguments, "studentKey", |p, v| p.id(v))
}

/// `z.object({ studentKey }).strict()`.
pub fn student(arguments: &Map<String, Value>) -> Result<Option<String>, String> {
    object(arguments, &["studentKey"], student_key, |_| None)
}

/// `dateRange`: strict, with its order refinement.
pub fn range(arguments: &Map<String, Value>) -> Result<Range, String> {
    let range = object(
        arguments,
        &["dateFrom", "dateTo", "studentKey"],
        |parse, args| {
            (
                parse.at("dateFrom").date(args.get("dateFrom")),
                parse.at("dateTo").date(args.get("dateTo")),
                student_key(parse, args),
            )
        },
        |(from, to, _)| match (from, to) {
            (Some(from), Some(to)) if crate::js::compare(from, to).is_gt() => {
                Some("Dates must be in order.")
            }
            _ => None,
        },
    )?;
    let (Some(date_from), Some(date_to), student_key) = range else {
        unreachable!("a missing date is an issue");
    };
    Ok(Range {
        date_from,
        date_to,
        student_key,
    })
}

/// `z.enum(['assignments', 'exams', 'all']).default('all')` and `studentKey`.
pub fn assignments(
    arguments: &Map<String, Value>,
) -> Result<(&'static str, Option<String>), String> {
    object(
        arguments,
        &["type", "studentKey"],
        |parse, args| {
            let options = ["assignments", "exams", "all"];
            let kind = optional(parse, args, "type", |p, v| {
                let found = v
                    .and_then(Value::as_str)
                    .and_then(|text| options.iter().find(|option| **option == text).copied());

                if found.is_none() {
                    p.issue(
                        "Invalid option: expected one of \"assignments\"|\"exams\"|\"all\""
                            .to_owned(),
                        false,
                    );
                }
                found
            });
            (kind.unwrap_or("all"), student_key(parse, args))
        },
        |_| None,
    )
}

/// One required id field and `studentKey`.
fn required_id(
    arguments: &Map<String, Value>,
    field: &'static str,
) -> Result<(String, Option<String>), String> {
    let (id, key) = object(
        arguments,
        &[field, "studentKey"],
        |parse, args| {
            (
                parse.at(field).id(args.get(field)),
                student_key(parse, args),
            )
        },
        |_| None,
    )?;
    Ok((id.unwrap_or_default(), key))
}

/// `assignmentId` and `studentKey`.
pub fn assignment(arguments: &Map<String, Value>) -> Result<(String, Option<String>), String> {
    required_id(arguments, "assignmentId")
}

/// `groupId` and `studentKey`.
pub fn group(arguments: &Map<String, Value>) -> Result<(String, Option<String>), String> {
    required_id(arguments, "groupId")
}

/// An optional `termId` and `studentKey`.
pub fn term(arguments: &Map<String, Value>) -> Result<(Option<String>, Option<String>), String> {
    object(
        arguments,
        &["termId", "studentKey"],
        |parse, args| {
            (
                optional(parse, args, "termId", |p, v| p.id(v)),
                student_key(parse, args),
            )
        },
        |_| None,
    )
}

/// `rowFrom` (default 1) and an optional `rowTo`.
pub type Rows = (f64, Option<f64>);

/// `rowFrom`, `rowTo` and `studentKey`.
pub fn messages(arguments: &Map<String, Value>) -> Result<(Rows, Option<String>), String> {
    object(
        arguments,
        &["rowFrom", "rowTo", "studentKey"],
        |parse, args| {
            let from = optional(parse, args, "rowFrom", |p, v| p.int(v)).unwrap_or(1.0);
            let to = optional(parse, args, "rowTo", |p, v| p.int(v));
            ((from, to), student_key(parse, args))
        },
        |_| None,
    )
}

/// `messageId`, `type` and `studentKey`.
pub fn message(
    arguments: &Map<String, Value>,
) -> Result<((String, String), Option<String>), String> {
    let (id, kind, key) = object(
        arguments,
        &["messageId", "type", "studentKey"],
        |parse, args| {
            let id = parse.at("messageId").id(args.get("messageId"));
            let kind = {
                let mut at = parse.at("type");
                let kind = at.string(args.get("type"), (0, usize::MAX));

                if kind.as_deref().is_some_and(|kind| !is_letter(kind)) {
                    at.issue(
                        "Invalid string: must match pattern /^[A-Z]$/".to_owned(),
                        true,
                    );
                }
                kind
            };
            (id, kind, student_key(parse, args))
        },
        |_| None,
    )?;
    Ok(((id.unwrap_or_default(), kind.unwrap_or_default()), key))
}

/// `absenceInputSchema`: strict, with the reason trimmed before its length checks. Both
/// refinements run once nothing aborted; the runtime takes one refinement message, so when both
/// fail it gets them joined as zod joins issues.
pub fn absence(arguments: &Map<String, Value>) -> Result<Request, String> {
    let (kind, date_from, date_to, reason, student_key) = object(
        arguments,
        &["kind", "dateFrom", "dateTo", "reason", "studentKey"],
        |parse, args| {
            let kind = ["sick", "leave"]
                .into_iter()
                .find(|kind| args.get("kind").and_then(Value::as_str) == Some(kind));

            if kind.is_none() {
                parse.at("kind").issue(
                    "Invalid option: expected one of \"sick\"|\"leave\"".to_owned(),
                    false,
                );
            }
            let date_from = parse.at("dateFrom").date(args.get("dateFrom"));
            let date_to = parse.at("dateTo").date(args.get("dateTo"));
            let reason = {
                let mut at = parse.at("reason");
                let trimmed = args
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(|text| Value::String(js::trim(text).to_owned()));
                let reason = at.string(trimmed.as_ref().or(args.get("reason")), (1, 2000));
                reason.filter(|_| trimmed.is_some())
            };
            (kind, date_from, date_to, reason, student_key(parse, args))
        },
        |(kind, from, to, _, _)| {
            let (Some(kind), Some(from), Some(to)) = (kind, from, to) else {
                return None;
            };
            let unordered = js::compare(from, to).is_gt();
            let several = *kind == "sick" && from != to;

            match (unordered, several) {
                (true, true) => Some("Dates must be in order., Register one sick day at a time."),
                (true, false) => Some("Dates must be in order."),
                (false, true) => Some("Register one sick day at a time."),
                (false, false) => None,
            }
        },
    )?;
    let (Some(kind), Some(date_from), Some(date_to), Some(reason)) =
        (kind, date_from, date_to, reason)
    else {
        unreachable!("a missing field is an issue");
    };
    Ok(Request {
        kind,
        date_from,
        date_to,
        reason,
        student_key,
    })
}

/// `inna_submit_absence`: `{ operationId: z.uuid(), confirm: z.literal(true) }`, strict.
pub fn submit(arguments: &Map<String, Value>) -> Result<String, String> {
    let id = object(
        arguments,
        &["operationId", "confirm"],
        |parse, args| {
            let id = {
                let mut at = parse.at("operationId");
                let id = at.string(args.get("operationId"), (0, usize::MAX));

                if id.as_deref().is_some_and(|id| !js::is_uuid(id)) {
                    at.issue("Invalid UUID".to_owned(), true);
                }
                id
            };

            if args.get("confirm") != Some(&Value::Bool(true)) {
                parse
                    .at("confirm")
                    .issue("Invalid input: expected true".to_owned(), false);
            }
            id
        },
        |_| None,
    )?;
    Ok(id.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn invalid_inputs_get_the_zod_texts() {
        // Texts from the TypeScript server's tool calls, after "Invalid arguments for tool X: ".
        let pattern = "Invalid string: must match pattern /^\\d+$/";
        assert_eq!(
            student(&args(json!({"studentKey": "x1"}))).unwrap_err(),
            format!("studentKey: {pattern}")
        );
        assert_eq!(
            student(&args(json!({"studentKey": "1".repeat(33)}))).unwrap_err(),
            "studentKey: Too big: expected string to have <=32 characters"
        );
        assert_eq!(
            student(&args(json!({"studentKey": "x".repeat(33)}))).unwrap_err(),
            format!(
                "studentKey: {pattern}, studentKey: Too big: expected string to have <=32 characters"
            )
        );
        assert_eq!(
            student(&args(json!({"studentKey": 5}))).unwrap_err(),
            "studentKey: Invalid input: expected string, received number"
        );
        assert_eq!(
            student(&args(json!({"studentKey": null}))).unwrap_err(),
            "studentKey: Invalid input: expected string, received null"
        );
        assert_eq!(
            student(&args(json!({"z": 1, "studentKey": "1"}))).unwrap_err(),
            "Unrecognized key: \"z\""
        );
        assert_eq!(
            empty(&args(json!({"a": 1, "b": 2}))).unwrap_err(),
            "Unrecognized keys: \"a\", \"b\""
        );
        assert_eq!(
            range(&args(json!({}))).unwrap_err(),
            "dateFrom: Invalid input: expected string, received undefined, dateTo: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            range(&args(
                json!({"dateFrom": "2040-01-03", "dateTo": "2040-01-02"})
            ))
            .unwrap_err(),
            "Dates must be in order."
        );
        // The TypeScript case 'dates and plain text fail safely on malformed inputs'.
        assert_eq!(
            range(&args(
                json!({"dateFrom": "2040-02-30", "dateTo": "2040-03-01"})
            ))
            .unwrap_err(),
            "dateFrom: Invalid ISO date"
        );
        assert!(
            range(&args(
                json!({"dateFrom": "2040-03-02", "dateTo": "2040-03-01"})
            ))
            .is_err()
        );
        assert_eq!(
            range(&args(json!({"dateFrom": "2040-02-30", "dateTo": "x"}))).unwrap_err(),
            "dateFrom: Invalid ISO date, dateTo: Invalid ISO date"
        );
        assert_eq!(
            range(&args(
                json!({"dateFrom": "2040-01-03", "dateTo": "2040-01-02", "q": 1})
            ))
            .unwrap_err(),
            "Unrecognized key: \"q\", Dates must be in order."
        );
        assert_eq!(
            range(&args(
                json!({"dateFrom": "2040-01-03", "dateTo": "2040-01-02", "studentKey": "x"})
            ))
            .unwrap_err(),
            format!("studentKey: {pattern}, Dates must be in order.")
        );
        for kind in [json!("x"), json!(1)] {
            assert_eq!(
                assignments(&args(json!({"type": kind}))).unwrap_err(),
                "type: Invalid option: expected one of \"assignments\"|\"exams\"|\"all\""
            );
        }
        assert_eq!(
            assignment(&args(json!({}))).unwrap_err(),
            "assignmentId: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            term(&args(json!({"termId": ""}))).unwrap_err(),
            format!("termId: {pattern}")
        );
        assert_eq!(
            messages(&args(json!({"rowFrom": 0}))).unwrap_err(),
            "rowFrom: Too small: expected number to be >=1"
        );
        assert_eq!(
            messages(&args(json!({"rowFrom": 1.5}))).unwrap_err(),
            "rowFrom: Invalid input: expected int, received number"
        );
        assert_eq!(
            messages(&args(json!({"rowFrom": "1"}))).unwrap_err(),
            "rowFrom: Invalid input: expected number, received string"
        );
        assert_eq!(
            messages(&args(json!({"rowTo": 0, "rowFrom": 1e20}))).unwrap_err(),
            "rowFrom: Too big: expected int to be <=9007199254740991, rowTo: Too small: expected number to be >=1"
        );
        for kind in ["ab", "a"] {
            assert_eq!(
                message(&args(json!({"messageId": "1", "type": kind}))).unwrap_err(),
                "type: Invalid string: must match pattern /^[A-Z]$/"
            );
        }
    }

    #[test]
    fn absence_inputs_get_the_zod_texts() {
        // Texts from the TypeScript server's `absenceInputSchema` and submit input.
        let absent = |value: Value| absence(&args(value)).unwrap_err();
        let both = "Dates must be in order., Register one sick day at a time.";
        let sick = |reason: Value| json!({"kind": "sick", "dateFrom": "2040-01-03", "dateTo": "2040-01-02", "reason": reason});
        assert_eq!(
            absent(json!({})),
            "kind: Invalid option: expected one of \"sick\"|\"leave\", dateFrom: Invalid input: expected string, received undefined, dateTo: Invalid input: expected string, received undefined, reason: Invalid input: expected string, received undefined"
        );
        assert_eq!(absent(sick(json!("r"))), both);
        assert_eq!(
            absent(
                json!({"kind": "sick", "dateFrom": "2040-01-02", "dateTo": "2040-01-03", "reason": "r"})
            ),
            "Register one sick day at a time."
        );
        assert_eq!(
            absent(
                json!({"kind": "leave", "dateFrom": "2040-01-03", "dateTo": "2040-01-02", "reason": "r"})
            ),
            "Dates must be in order."
        );
        assert_eq!(
            absent(
                json!({"kind": "x", "dateFrom": "2040-01-03", "dateTo": "2040-01-02", "reason": "r"})
            ),
            "kind: Invalid option: expected one of \"sick\"|\"leave\""
        );
        assert_eq!(
            absent(sick(json!("   "))),
            format!("reason: Too small: expected string to have >=1 characters, {both}")
        );
        assert_eq!(
            absent(sick(json!("x".repeat(2001)))),
            format!("reason: Too big: expected string to have <=2000 characters, {both}")
        );
        assert_eq!(absent(sick(json!(format!(" {} ", "x".repeat(2000))))), both);
        assert_eq!(
            absent(sick(json!(5))),
            "reason: Invalid input: expected string, received number"
        );
        let mut extra = sick(json!("r"));
        extra["q"] = json!(1);
        assert_eq!(absent(extra), format!("Unrecognized key: \"q\", {both}"));
        let mut key = sick(json!("r"));
        key["studentKey"] = json!("x");
        assert_eq!(
            absent(key),
            format!("studentKey: Invalid string: must match pattern /^\\d+$/, {both}")
        );
        assert_eq!(
            absent(
                json!({"kind": "sick", "dateFrom": "2040-02-30", "dateTo": "2040-01-02", "reason": ""})
            ),
            format!(
                "dateFrom: Invalid ISO date, reason: Too small: expected string to have >=1 characters, {both}"
            )
        );
        let leave = |reason: Value| json!({"kind": "leave", "dateFrom": "2040-01-02", "dateTo": "2040-01-02", "reason": reason});
        for (reason, text) in [
            (
                json!([]),
                "reason: Invalid input: expected string, received array, reason: Too small: expected array to have >=1 items",
            ),
            (
                json!(["a"]),
                "reason: Invalid input: expected string, received array",
            ),
            (
                json!(vec![1; 2001]),
                "reason: Invalid input: expected string, received array, reason: Too big: expected array to have <=2000 items",
            ),
            (
                json!(null),
                "reason: Invalid input: expected string, received null",
            ),
        ] {
            assert_eq!(absent(leave(reason)), text);
        }
        assert_eq!(
            absence(&args(leave(json!("\t\n r \u{2028}")))),
            Ok(Request {
                kind: "leave",
                date_from: "2040-01-02".to_owned(),
                date_to: "2040-01-02".to_owned(),
                reason: "r".to_owned(),
                student_key: None,
            })
        );

        let submitted = |value: Value| submit(&args(value));
        let id = "123e4567-e89b-12d3-a456-426614174000";
        for (value, text) in [
            (
                json!({}),
                "operationId: Invalid input: expected string, received undefined, confirm: Invalid input: expected true",
            ),
            (
                json!({"operationId": "x", "confirm": false}),
                "operationId: Invalid UUID, confirm: Invalid input: expected true",
            ),
            (
                json!({"operationId": 5, "confirm": "true"}),
                "operationId: Invalid input: expected string, received number, confirm: Invalid input: expected true",
            ),
            (
                json!({"operationId": id, "confirm": true, "x": 1}),
                "Unrecognized key: \"x\"",
            ),
        ] {
            assert_eq!(submitted(value).unwrap_err(), text);
        }
        let upper = id.to_uppercase();
        assert_eq!(
            submitted(json!({"operationId": upper, "confirm": true})),
            Ok(upper.clone())
        );
    }

    #[test]
    fn defaults_fill_missing_fields() {
        assert_eq!(assignments(&args(json!({}))), Ok(("all", None)));
        assert_eq!(
            messages(&args(json!({"studentKey": "5"}))),
            Ok(((1.0, None), Some("5".to_owned())))
        );
        assert_eq!(term(&args(json!({}))), Ok((None, None)));
        assert_eq!(
            range(&args(
                json!({"dateFrom": "2040-01-02", "dateTo": "2040-01-02"})
            )),
            Ok(Range {
                date_from: "2040-01-02".to_owned(),
                date_to: "2040-01-02".to_owned(),
                student_key: None,
            })
        );
        assert_eq!(
            message(&args(json!({"messageId": "11", "type": "A"}))),
            Ok((("11".to_owned(), "A".to_owned()), None))
        );
    }
}
