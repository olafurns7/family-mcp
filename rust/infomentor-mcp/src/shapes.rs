//! The upstream and output shapes of packages/infomentor-mcp/src/session.ts and collection.ts, as
//! zod parses them: unknown keys dropped, known keys in shape order (an extended shape's own keys
//! after its base's), absent optional keys left absent. Collection fingerprints hash these parsed
//! objects, so the order is part of the cursor format.

use serde_json::{Map, Value};

use crate::js;

/// One object shape's fields, in order.
pub type Fields = &'static [(&'static str, S)];

#[derive(Clone, Copy)]
pub enum S {
    Str,
    /// `z.string().min(1)`.
    Filled,
    /// `z.number().int()`: a safe integer.
    Int,
    /// `z.number().int().positive()`.
    Positive,
    Bool,
    Enum(&'static [&'static str]),
    Null(&'static S),
    Nullish(&'static S),
    List(&'static S),
    /// Field groups, concatenated: a base shape's fields, then an extension's.
    Obj(&'static [Fields]),
}

fn integer(number: &serde_json::Number) -> Option<f64> {
    number
        .as_f64()
        .filter(|value| value.fract() == 0.0 && value.abs() <= js::SAFE)
}

/// `schema.parse(value)`; `None` input is `undefined`, and stays absent (`Ok(None)`).
fn shape(schema: &S, value: Option<&Value>) -> Result<Option<Value>, ()> {
    let parsed = match (schema, value) {
        (S::Nullish(_), None) => return Ok(None),
        (S::Null(_) | S::Nullish(_), Some(Value::Null)) => Value::Null,
        (S::Null(inner) | S::Nullish(inner), value) => return shape(inner, value),
        (S::Str, Some(text @ Value::String(_))) => text.clone(),
        (S::Filled, Some(Value::String(text))) if !text.is_empty() => Value::String(text.clone()),
        (S::Int, Some(Value::Number(number))) if integer(number).is_some() => {
            Value::Number(number.clone())
        }
        (S::Positive, Some(Value::Number(number))) if integer(number).is_some_and(|n| n > 0.0) => {
            Value::Number(number.clone())
        }
        (S::Bool, Some(flag @ Value::Bool(_))) => flag.clone(),
        (S::Enum(options), Some(Value::String(text))) if options.contains(&text.as_str()) => {
            Value::String(text.clone())
        }
        (S::List(item), Some(Value::Array(items))) => Value::Array(
            items
                .iter()
                .map(|value| shape(item, Some(value))?.ok_or(()))
                .collect::<Result<_, ()>>()?,
        ),
        (S::Obj(groups), Some(Value::Object(object))) => {
            let mut parsed = Map::new();

            for (key, field) in groups.iter().flat_map(|fields| fields.iter()) {
                if let Some(value) = shape(field, object.get(*key))? {
                    parsed.insert((*key).to_owned(), value);
                }
            }
            Value::Object(parsed)
        }
        _ => return Err(()),
    };
    Ok(Some(parsed))
}

/// `schema.safeParse(value)`: the parsed value, or `None`.
pub fn parse(schema: &S, value: &Value) -> Option<Value> {
    shape(schema, Some(value)).ok().flatten()
}

/// `parseItems`: the items that match, and how many did not.
pub fn items(schema: &S, items: &[Value]) -> (Vec<Value>, usize) {
    let parsed: Vec<Value> = items
        .iter()
        .filter_map(|item| parse(schema, item))
        .collect();
    let skipped = items.len() - parsed.len();
    (parsed, skipped)
}

const STR: S = S::Str;

pub const PUPIL_FIELDS: Fields = &[("id", STR), ("name", STR), ("selected", S::Bool)];

/// `parentSchema`.
pub const PARENT: S = S::Obj(&[
    &[(
        "account",
        S::Obj(&[&[
            ("currentUser", S::Obj(&[&[("id", S::Filled)]])),
            (
                "pupils",
                S::List(&S::Obj(&[
                    PUPIL_FIELDS,
                    &[("switchPupilUrl", S::Nullish(&STR))],
                ])),
            ),
        ]]),
    )],
    &[("apps", S::List(&S::Obj(&[&[("codeName", STR)]])))],
]);

/// `timetableEntrySchema`.
pub const TIMETABLE_ENTRY: S = S::Obj(&[&[
    ("start", STR),
    ("end", STR),
    ("title", STR),
    ("startTime", STR),
    ("endTime", STR),
    (
        "notes",
        S::Obj(&[&[("roomInfo", STR), ("timetableNotes", STR), ("tutors", STR)]]),
    ),
    ("allDay", S::Bool),
    ("establishmentName", S::Null(&STR)),
]]);

const MESSAGE_USER: S = S::Obj(&[&[("id", S::Int), ("displayName", S::Null(&STR))]]);

const MESSAGE_SUMMARY_FIELDS: Fields = &[
    ("id", S::Positive),
    ("messageContextType", STR),
    ("sentUser", MESSAGE_USER),
    ("isNew", S::Bool),
    ("messageSubject", STR),
    ("timeSent", STR),
];

/// `messageSummarySchema`.
pub const MESSAGE_SUMMARY: S = S::Obj(&[MESSAGE_SUMMARY_FIELDS]);

/// `messageDetailSchema`.
pub const MESSAGE_DETAIL: S = S::Obj(&[
    MESSAGE_SUMMARY_FIELDS,
    &[
        ("messageBodyPlainText", STR),
        ("toUsers", S::List(&MESSAGE_USER)),
        ("messageFolder", STR),
    ],
]);

const NOTIFICATION_FIELDS: Fields = &[
    ("id", S::Int),
    ("title", STR),
    ("subTitle", STR),
    ("subjectsCourses", STR),
    ("dateSent", STR),
    ("appType", STR),
    ("state", STR),
    ("type", STR),
    ("url", STR),
    ("pupilIM2Id", S::Int),
    ("pupilSourceId", STR),
];

/// `notificationSchema`.
pub const NOTIFICATION: S = S::Obj(&[NOTIFICATION_FIELDS, &[("currentlySelectedPupil", S::Bool)]]);

/// `notificationSchema.omit({currentlySelectedPupil: true})`.
pub const COLLECTED_NOTIFICATION: S = S::Obj(&[NOTIFICATION_FIELDS]);

/// A feed's valid items and how many malformed ones were dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct Feed {
    pub items: Vec<Value>,
    pub skipped: usize,
}

/// `messagesPageResponseSchema`'s output.
#[derive(Debug, Clone, PartialEq)]
pub struct MessagesPage {
    pub items: Vec<Value>,
    pub skipped: usize,
    pub more: bool,
}

/// `z.object({ <key>: z.array(z.unknown()) })`, then `parseItems` with `schema`.
fn feed(value: &Value, key: &str, schema: &S) -> Option<Feed> {
    let (items, skipped) = items(schema, value.as_object()?.get(key)?.as_array()?);
    Some(Feed { items, skipped })
}

/// `timetableResponseSchema`.
pub fn timetable_response(value: &Value) -> Option<Feed> {
    feed(value, "items", &TIMETABLE_ENTRY)
}

/// `messagesPageResponseSchema`.
pub fn messages_response(value: &Value) -> Option<MessagesPage> {
    let Feed { items, skipped } = feed(value, "items", &MESSAGE_SUMMARY)?;
    let more = value.get("more")?.as_bool()?;
    Some(MessagesPage {
        items,
        skipped,
        more,
    })
}

/// `notificationsResponseSchema`.
pub fn notifications_response(value: &Value) -> Option<Feed> {
    feed(value, "notifications", &NOTIFICATION)
}

/// `messageDetailSchema`.
pub fn message_detail(value: &Value) -> Option<Value> {
    parse(&MESSAGE_DETAIL, value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn shapes_drop_unknown_keys_and_keep_schema_order() {
        let parsed = parse(
            &MESSAGE_DETAIL,
            &json!({
                "messageFolder": "Inbox",
                "toUsers": [{"displayName": null, "id": 3, "x": 1}],
                "messageBodyPlainText": "b",
                "timeSent": "t",
                "messageSubject": "s",
                "isNew": false,
                "sentUser": {"id": -1, "displayName": "D"},
                "messageContextType": "c",
                "id": 7,
                "extra": true,
            }),
        )
        .unwrap();
        assert_eq!(
            parsed.to_string(),
            r#"{"id":7,"messageContextType":"c","sentUser":{"id":-1,"displayName":"D"},"isNew":false,"messageSubject":"s","timeSent":"t","messageBodyPlainText":"b","toUsers":[{"id":3,"displayName":null}],"messageFolder":"Inbox"}"#
        );
        let pupil = |switch: Value| json!({"account": {"currentUser": {"id": "p"}, "pupils": [{"id": "1", "name": "n", "selected": true, "switchPupilUrl": switch}]}, "apps": []});
        assert!(parse(&PARENT, &pupil(json!(null))).is_some());
        assert!(parse(&PARENT, &pupil(json!("/x"))).is_some());
        assert!(parse(&PARENT, &pupil(json!(1))).is_none());
        assert!(parse(&S::Positive, &json!(0)).is_none());
        assert!(parse(&S::Int, &json!(1.5)).is_none());
        assert!(parse(&S::Int, &json!(9_007_199_254_740_992_i64)).is_none());
        assert_eq!(
            items(&S::Int, &[json!(1), json!("x"), json!(2)]),
            (vec![json!(1), json!(2)], 1)
        );
    }
}
