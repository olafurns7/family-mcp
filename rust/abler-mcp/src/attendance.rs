//! Narrow guardian RSVP input and fail-closed eligibility checks, not coach presence.
use mcp_runtime::input::object;
use serde_json::{Map, Value};

use crate::error::{Fail, Result};

pub const FIELDS: &str = "eventId name type status from to locationDetails registrationEnd attendanceLimit paymentRequestInfo
 ageGroup { id guardiansDisabled }
 currentPlayerAttendance { player { id displayName } status statusExt comment paymentStatus orderId waitingListNr }";
pub const MUTATION: &str = "mutation SetPracticeAttendance(
 $eventId: ID!, $playerId: ID!, $status: PLAYER_ATTENDANCE_STATUS!, $comment: String, $statusExt: eventPlayerStatusExt
) { setPlayerAttendanceV3(eventId:$eventId, playerId:$playerId, status:$status, comment:$comment, statusExt:$statusExt) {
 eventId eventPlayer { status }
} }";

pub struct Input {
    pub child_id: String,
    pub age_group_id: String,
    pub event_id: String,
    pub status: &'static str,
    pub expected: Value,
}

pub fn input(args: &Map<String, Value>) -> std::result::Result<Input, String> {
    object(
        args,
        &[
            "childId",
            "ageGroupId",
            "eventId",
            "attendance",
            "expectedStatus",
        ],
        |p, a| {
            let child_id = p
                .at("childId")
                .string(a.get("childId"), (1, 256))
                .unwrap_or_default();
            let age_group_id = p
                .at("ageGroupId")
                .string(a.get("ageGroupId"), (1, 256))
                .unwrap_or_default();
            let event_id = p
                .at("eventId")
                .string(a.get("eventId"), (1, 256))
                .unwrap_or_default();
            let status = match a.get("attendance").and_then(Value::as_str) {
                Some("attending") => "G",
                Some("not_attending") => "N",
                _ => {
                    p.at("attendance").issue(
                        "Invalid option: expected one of \"attending\"|\"not_attending\""
                            .to_owned(),
                        false,
                    );
                    ""
                }
            };
            let expected = if a.get("expectedStatus") == Some(&Value::Null) {
                Value::Null
            } else {
                Value::String(
                    p.at("expectedStatus")
                        .string(a.get("expectedStatus"), (0, 256))
                        .unwrap_or_default(),
                )
            };
            Input {
                child_id,
                age_group_id,
                event_id,
                status,
                expected,
            }
        },
        |_| None,
    )
}

fn at_ms(value: &Value) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|date| date.timestamp_millis() as f64)
}

/// Do not equate absent metadata with upstream null. Unrecognized records cannot authorize writes.
pub fn row<'a>(event: &'a Value, input: &Input) -> Result<&'a Value> {
    if event["eventId"] != input.event_id || event["ageGroup"]["id"] != input.age_group_id {
        return Err(Fail::Safe(
            "Abler returned a different event than requested.",
        ));
    }
    let rows: Vec<_> = event["currentPlayerAttendance"]
        .as_array()
        .ok_or(Fail::Invalid)?
        .iter()
        .filter(|row| row["player"]["id"] == input.child_id)
        .collect();
    if rows.len() != 1 {
        return Err(Fail::Safe(
            "The child must have exactly one attendance record on this practice.",
        ));
    }
    let row = rows[0];
    if !(row
        .get("status")
        .is_some_and(|v| v.is_null() || v.is_string())
        && row
            .get("comment")
            .is_some_and(|v| v.is_null() || v.is_string()))
    {
        return Err(Fail::Invalid);
    }
    Ok(row)
}

pub fn eligible<'a>(event: &'a Value, input: &Input, now: f64) -> Result<&'a Value> {
    let row = row(event, input)?;
    if event["type"] != "TRAINING"
        || event["status"] != "OPEN"
        || !at_ms(&event["from"]).is_some_and(|at| at > now)
    {
        return Err(Fail::Safe(
            "Attendance writes require an open, future practice.",
        ));
    }
    if event.get("registrationEnd") != Some(&Value::Null)
        && !at_ms(&event["registrationEnd"]).is_some_and(|at| at > now)
    {
        return Err(Fail::Safe(
            "Practice registration is closed or its deadline is unrecognized.",
        ));
    }
    if event.get("paymentRequestInfo") != Some(&Value::Null)
        || event["attendanceLimit"].as_f64() != Some(-1.0)
        || event["ageGroup"]["guardiansDisabled"] != false
    {
        return Err(Fail::Safe(
            "Only unpaid, unlimited practices with guardian access are supported.",
        ));
    }
    for key in ["paymentStatus", "orderId", "waitingListNr", "statusExt"] {
        if row.get(key) != Some(&Value::Null) {
            return Err(Fail::Safe(
                "Paid, waiting-list, or extended-reason attendance requires the Abler app.",
            ));
        }
    }
    if !row["status"].is_null() && row["status"] != "G" && row["status"] != "N" {
        return Err(Fail::Safe(
            "Unrecognized attendance status; use the Abler app.",
        ));
    }
    if row["status"] != input.expected {
        return Err(Fail::Safe(
            "Attendance changed since the event was read. Read it again before requesting a change.",
        ));
    }
    Ok(row)
}
