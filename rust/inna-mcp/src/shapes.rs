//! The upstream shapes of packages/inna-mcp/src/schemas.ts, as zod parses them: unknown keys
//! dropped, known keys in shape order, absent optional keys left absent. A record's `dates`, when
//! Inna sends one, keeps its place; the client then replaces it.

use serde_json::{Map, Value};

use crate::dates;

/// One object shape's fields, in order.
pub type Fields = &'static [(&'static str, S)];

#[derive(Clone, Copy)]
pub enum S {
    Str,
    /// `z.number()`.
    Num,
    /// `z.number().int().positive()`.
    Positive,
    /// `z.number().int().nonnegative()`.
    NonNegative,
    Bool,
    /// `id`: `z.string().regex(/^\d+$/).max(32)`.
    Id,
    /// `z.string().regex(/^[A-Z]$/)`.
    Letter,
    /// `z.unknown()`.
    Any,
    Optional(&'static S),
    List(&'static S),
    /// `z.union([first, second])`: the first that parses.
    Either(&'static S, &'static S),
    /// Field groups, concatenated: a base shape's fields, then an extension's.
    Obj(&'static [Fields]),
    /// `datesSchema.optional()`.
    Dates,
}

const SAFE: f64 = 9_007_199_254_740_991.0;

fn integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.fract() == 0.0 && number.abs() <= SAFE)
}

/// `id`.
pub fn is_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 32 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `/^[A-Z]$/`.
pub fn is_letter(text: &str) -> bool {
    text.len() == 1 && text.bytes().all(|byte| byte.is_ascii_uppercase())
}

/// `schema.parse(value)`; `None` input is `undefined`, and stays absent (`Ok(None)`).
fn shape(schema: &S, value: Option<&Value>) -> Result<Option<Value>, ()> {
    let parsed = match (schema, value) {
        (S::Optional(_) | S::Dates, None) => return Ok(None),
        (S::Optional(inner), value) => return shape(inner, value),
        (S::Any, Some(value)) => value.clone(),
        (S::Str, Some(text @ Value::String(_))) => text.clone(),
        (S::Id, Some(Value::String(text))) if is_id(text) => Value::String(text.clone()),
        (S::Letter, Some(Value::String(text))) if is_letter(text) => Value::String(text.clone()),
        (S::Num, Some(number @ Value::Number(_))) => number.clone(),
        (S::Positive, Some(number)) if integer(number).is_some_and(|n| n > 0.0) => number.clone(),
        (S::NonNegative, Some(number)) if integer(number).is_some_and(|n| n >= 0.0) => {
            number.clone()
        }
        (S::Bool, Some(flag @ Value::Bool(_))) => flag.clone(),
        (S::Dates, Some(record)) if dates::valid_record(record) => record.clone(),
        (S::Either(first, second), value) => {
            return shape(first, value).or_else(|()| shape(second, value));
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

const STR: S = S::Str;

const OPT_STR: S = S::Optional(&STR);

/// `userSchema`.
pub const USER: S = S::Obj(&[&[
    ("userId", S::Positive),
    ("studentId", S::Id),
    ("schoolId", S::Id),
    ("studentName", STR),
    ("name", STR),
    ("schoolLong", STR),
    ("defaultTermId", S::Id),
    ("isGuardian", S::Bool),
    ("logInType", STR),
    ("olderThan18", S::Bool),
    ("registerAbsenceGuardian", STR),
    ("registerAbsenceUnder18", STR),
    ("registerAbsenceOver18", STR),
    ("registerAbsence", STR),
    ("student18RegisterAbsence", STR),
    ("registerLeave", STR),
    ("student18RegisterLeave", STR),
    ("registerIllnessTomorrow", STR),
    ("access", S::Optional(&S::Any)),
]]);

/// `contextSchema`'s fields, a pick of `userSchema`'s.
pub const CONTEXT_FIELDS: [&str; 8] = [
    "userId",
    "studentId",
    "schoolId",
    "studentName",
    "name",
    "schoolLong",
    "defaultTermId",
    "isGuardian",
];

const DATES: (&str, S) = ("dates", S::Dates);

/// `termsSchema`.
pub const TERMS: S = S::List(&S::Obj(&[&[("termId", S::Id), ("termCode", STR)]]));

/// `coursesSchema`.
pub const COURSES: S = S::List(&S::Obj(&[&[
    ("moduleId", S::Id),
    ("moduleTermId", S::Id),
    ("moduleName", STR),
    ("moduleName2", STR),
    ("subjectName", STR),
    ("groupId", S::Id),
    ("groupName", STR),
    ("termId", S::Id),
    (
        "booklist",
        S::Optional(&S::List(&S::Obj(&[&[("bookname", STR)]]))),
    ),
    ("dateFrom", STR),
    ("dateTo", STR),
    DATES,
]]));

const OPT_NUM: S = S::Optional(&S::Num);

/// `timetableSchema`.
pub const TIMETABLE: S = S::List(&S::Obj(&[&[
    ("start", STR),
    ("end", STR),
    ("titleShort", STR),
    ("allDay", S::Bool),
    ("moduleId", OPT_STR),
    ("groupId", OPT_STR),
    ("moduleTermId", OPT_STR),
    ("startClock", OPT_STR),
    ("endClock", OPT_STR),
    ("teacher", OPT_STR),
    ("classroom", OPT_STR),
    ("group", OPT_STR),
    ("timetable_id", OPT_NUM),
    ("maintable_id", OPT_NUM),
    ("studentRecordId", OPT_NUM),
    DATES,
]]));

/// `assignmentsSchema`.
pub const ASSIGNMENTS: S = S::List(&S::Obj(&[&[
    ("assignmentId", S::Id),
    ("name", STR),
    ("module", STR),
    ("type", STR),
    ("weight", OPT_STR),
    ("assignedFullDate", STR),
    ("handInFullDate", STR),
    ("handedIn", S::Either(&S::Num, &STR)),
    ("isOpen", S::Num),
    ("projectId", STR),
    ("exam", OPT_STR),
    ("assignmentComment", OPT_STR),
    DATES,
]]));

/// `assignmentSchema`.
pub const ASSIGNMENT: S = S::Obj(&[&[
    ("assignmentId", S::Id),
    ("name", STR),
    ("description", STR),
    ("moduleName", STR),
    ("groupId", S::Id),
    ("groupName", STR),
    ("moduleTermId", S::Id),
    ("returnDate", STR),
    ("type", S::Num),
    ("exam", S::Num),
    ("weight", STR),
    ("projectId", STR),
    ("groupReturnSize", S::Num),
    DATES,
]]);

/// `homeworkSchema`.
pub const HOMEWORK: S = S::List(&S::Obj(&[&[
    ("id", S::Num),
    ("date", STR),
    ("moduleName", STR),
    ("text", STR),
    DATES,
]]));

/// `gradesSchema`.
pub const GRADES: S = S::List(&S::Obj(&[&[
    ("moduleTermId", S::Id),
    ("termId", S::Id),
    ("moduleName", STR),
    ("subjectName", STR),
    ("units", STR),
    ("status", STR),
    ("show", S::Bool),
    ("termCode", STR),
    ("grade", OPT_STR),
    ("myUnits", OPT_STR),
    ("dateFinished", OPT_STR),
    DATES,
]]));

/// `courseGradesSchema`.
pub const COURSE_GRADES: S = S::Obj(&[&[(
    "assignments",
    S::List(&S::Obj(&[&[
        ("id", S::Num),
        ("name", STR),
        ("type", S::Num),
        ("weight", S::Num),
        ("grade", OPT_STR),
        ("commentByTeacher", OPT_STR),
        ("returnDate", S::Num),
        ("assignDate", S::Num),
        ("handedIn", S::Bool),
        DATES,
    ]])),
)]]);

const TOTALS: S = S::List(&S::Obj(&[&[
    ("number", OPT_STR),
    ("code", STR),
    ("name", STR),
]]));

/// `attendanceSchema`.
pub const ATTENDANCE: S = S::Obj(&[&[
    ("absencesTotal", TOTALS),
    ("leaveOfAbsencesTotal", TOTALS),
    (
        "attendanceTerm",
        S::Obj(&[&[("realAttendance", STR), ("attendance", STR)]]),
    ),
    ("dateFrom", STR),
    ("dateTo", STR),
    ("termName", STR),
    ("nrClassesTotal", S::Num),
    ("absencePointsTotal", STR),
    DATES,
    (
        "modules",
        S::List(&S::Obj(&[&[
            ("moduleName", STR),
            ("show", S::Num),
            ("studentRecordId", S::Id),
            (
                "attendance",
                S::Obj(&[&[("realAttendance", OPT_STR), ("attendance", OPT_STR)]]),
            ),
            ("absences", TOTALS),
            ("leaveOfAbsence", TOTALS),
            (
                "absencePoints",
                S::Obj(&[&[("nrClasses", STR), ("absencePoints", OPT_STR)]]),
            ),
        ]])),
    ),
]]);

/// `materialsSchema`.
pub const MATERIALS: S = S::List(&S::Obj(&[&[
    ("fileGroupId", S::Id),
    ("groupId", S::Id),
    ("fileGroup", STR),
    (
        "files",
        S::List(&S::Obj(&[&[
            ("name", STR),
            ("fileId", OPT_STR),
            ("fileName", OPT_STR),
            ("contentType", OPT_STR),
            ("description", OPT_STR),
            ("link", OPT_STR),
            ("closed", S::Bool),
            ("dateOpened", OPT_STR),
            DATES,
        ]])),
    ),
]]));

/// `messagesSchema`.
pub const MESSAGES: S = S::Obj(&[&[
    ("count", S::NonNegative),
    (
        "messages",
        S::List(&S::Obj(&[&[
            ("messagesId", S::Id),
            ("table", S::Letter),
            ("title", OPT_STR),
            ("sender", STR),
            ("date", STR),
            ("dateOpened", OPT_STR),
            ("status", STR),
            DATES,
        ]])),
    ),
]]);

/// `messageSchema`.
pub const MESSAGE: S = S::Obj(&[&[
    ("title", STR),
    ("message", STR),
    ("dateCreated", STR),
    ("dateSent", STR),
    ("sentTo", STR),
    ("type", STR),
    (
        "attachmentList",
        S::List(&S::Obj(&[&[
            ("attachmentId", S::Optional(&S::Either(&STR, &S::Num))),
            ("name", OPT_STR),
            ("contentType", OPT_STR),
        ]])),
    ),
    DATES,
]]);

/// `announcementsSchema`.
pub const ANNOUNCEMENTS: S = S::List(&S::Obj(&[&[
    ("announcementId", S::Id),
    ("date", STR),
    ("title", STR),
    ("sender", STR),
    ("moduleName", OPT_STR),
    ("contentHtml", STR),
    ("hasOpened", S::Bool),
    DATES,
]]));

/// `sickOptionsSchema`.
pub const SICK_OPTIONS: S = S::Obj(&[&[
    ("todayAllowed", S::Bool),
    ("tomorrowAllowed", S::Bool),
    ("today", S::Bool),
    ("tomorrow", S::Bool),
    ("doctorsNote", STR),
    ("comment", STR),
]]);

const CLASSES: S = S::List(&S::Obj(&[&[
    ("date", STR),
    ("timeFrom", STR),
    ("timeTo", STR),
    ("class", STR),
    DATES,
]]));

/// `leavesSchema`.
pub const LEAVES: S = S::List(&S::Obj(&[&[
    ("id", S::Positive),
    ("dateFrom", STR),
    ("dateTo", STR),
    ("leaveType", STR),
    ("status", STR),
    ("statusCode", S::Num),
    ("reasonForLeave", STR),
    ("createdBy", STR),
    ("confirmedBy", OPT_STR),
    ("created", STR),
    ("classes", CLASSES),
    DATES,
]]));

/// `sicknessSchema`.
pub const SICKNESS: S = S::List(&S::Obj(&[&[
    ("id", S::Positive),
    ("date", STR),
    ("comment", OPT_STR),
    ("statusCode", S::Num),
    ("allDay", STR),
    ("classes", CLASSES),
    DATES,
]]));

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn shapes_drop_unknown_keys_and_keep_schema_order() {
        let parsed = parse(
            &MESSAGE,
            &json!({
                "attachmentList": [{"x": 1, "attachmentId": 7}, {"attachmentId": "a"}],
                "type": "A", "sentTo": "s", "dateSent": "d", "dateCreated": "c",
                "message": "m", "title": "t", "extra": true,
            }),
        )
        .unwrap();
        assert_eq!(
            parsed.to_string(),
            r#"{"title":"t","message":"m","dateCreated":"c","dateSent":"d","sentTo":"s","type":"A","attachmentList":[{"attachmentId":7},{"attachmentId":"a"}]}"#
        );
        // A `dates` Inna sends keeps its place before `modules`; an invalid one refuses the record.
        let attendance = |dates: Value| {
            json!({
                "modules": [], "dates": dates, "absencesTotal": [], "leaveOfAbsencesTotal": [],
                "attendanceTerm": {"realAttendance": "1", "attendance": "2"}, "dateFrom": "a",
                "dateTo": "b", "termName": "t", "nrClassesTotal": 1, "absencePointsTotal": "0",
            })
        };
        let parsed = parse(&ATTENDANCE, &attendance(json!({}))).unwrap();
        let keys: Vec<&String> = parsed.as_object().unwrap().keys().collect();
        assert_eq!(keys[8..], ["dates", "modules"]);
        assert!(parse(&ATTENDANCE, &attendance(json!([]))).is_none());
        assert!(parse(&S::Id, &json!("0".repeat(33))).is_none());
        assert!(parse(&S::Id, &json!("")).is_none());
        assert!(parse(&S::Id, &json!("١")).is_none());
        assert!(parse(&S::Letter, &json!("AB")).is_none());
        assert!(parse(&S::Positive, &json!(0)).is_none());
        assert!(parse(&S::NonNegative, &json!(0)).is_some());
        assert!(parse(&S::Positive, &json!(9_007_199_254_740_992_i64)).is_none());
        assert!(parse(&USER, &json!({})).is_none());
    }
}
