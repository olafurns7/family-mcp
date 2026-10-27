//! Opt-in whole-day sickness reporting. All calls run under the account/session lock.
//! A private durable attempt is saved BEFORE the single POST. Neither redirects, renewal,
//! restart nor logout may turn an uncertain write into another submission.
use std::path::PathBuf;

use family_store::{
    Cancel, Code as StoreCode, default_secret_record_path, read_private_bytes, write_private_file,
};
use serde_json::{Value, json};

use crate::error::{Code, Fail, Result};
use crate::http::{Http, Parent};
use crate::js;
use crate::session::PARENT_URL;
use crate::signal::Signal;

const INVALID: Fail = Fail::new(
    Code::UnexpectedPage,
    "InfoMentor absence options are unavailable or have changed. No absence was sent.",
);
const BLOCKED: Fail = Fail::new(
    Code::OperationInProgress,
    "An InfoMentor absence submission is uncertain. Check InfoMentor and contact the operator; do not retry or delete the private absence record.",
);
const RECORD_ERROR: Fail = Fail::config(
    "Cannot read or save the private InfoMentor absence record. Do not delete it to retry a submission.",
);
const TTL: f64 = 600_000.0;
const REGISTER: &str = "/attendance/attendance/registerAttendance";

#[derive(Clone, Debug, PartialEq)]
pub struct Day {
    pub day: &'static str,
    pub date: String,
    pub absent: bool,
    pub locked: bool,
    pub partial: bool,
    pub can_add_sickness: bool,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub allowed: bool,
    pub days: Vec<Day>,
}

fn boolean(data: &Value, field: &str) -> Option<bool> {
    data.get(field)?.as_bool()
}

fn school_date(text: &str) -> Option<String> {
    let parts: Vec<_> = text.split('.').collect();
    if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 || parts[2].len() != 4 {
        return None;
    }
    let iso = format!("{}-{}-{}", parts[2], parts[1], parts[0]);
    valid_date(&iso).then_some(iso)
}

pub fn valid_date(text: &str) -> bool {
    text.len() == 10
        && text.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
        && {
            let time = js::parse_date(&format!("{text}T00:00:00.000Z"));
            time.is_finite() && js::iso_string(time).get(..10) == Some(text)
        }
}

impl Options {
    pub fn parse(data: &Value, now: f64) -> Option<Self> {
        // Never accept an upstream URL as a write destination. A changed contract fails closed.
        (data.get("urls")?.get("registerAttendance")?.as_str()? == REGISTER).then_some(())?;
        let allowed = boolean(data, "isParent")?
            && boolean(data, "isIcelandic")?
            && boolean(data, "canRegisterDayAbsence")?;
        let mut days = Vec::new();
        for (day, suffix, offset) in [
            ("today", "Today", 0.0),
            ("tomorrow", "Tomorrow", 86_400_000.0),
        ] {
            let date = school_date(data.get(format!("absence{suffix}Date"))?.as_str()?)?;
            (date == js::iso_string(now + offset).get(..10)?).then_some(())?;
            let sessions = data.get(format!("absence{suffix}Sessions"))?.as_array()?;
            let mut partial = !data
                .get(format!("partOfDayAbsenceRegistrations{suffix}"))?
                .as_array()?
                .is_empty();
            for session in sessions {
                partial |= boolean(session, "isAbsent")?;
            }
            days.push(Day {
                day,
                date,
                absent: boolean(data, &format!("absent{suffix}"))?,
                locked: boolean(data, &format!("absence{suffix}Locked"))?,
                partial,
                can_add_sickness: boolean(data, &format!("canAddSickness{suffix}"))?,
            });
        }
        Some(Self { allowed, days })
    }

    fn eligible(&self, date: &str) -> Result<Day> {
        let day = self
            .days
            .iter()
            .find(|day| day.date == date)
            .ok_or(INVALID)?;
        if !self.allowed || day.absent || day.locked || day.partial {
            return Err(Fail::new(
                Code::AccessDenied,
                "InfoMentor does not allow a new whole-day sickness report for this child/date, or an absence already exists. No absence was sent.",
            ));
        }
        Ok(day.clone())
    }
}

fn selected(parent: &Parent, account: &str, child: &str) -> Result<String> {
    let pupils: Vec<_> = parent
        .pupils
        .iter()
        .filter(|pupil| pupil.selected)
        .collect();
    if parent.account_id != account
        || pupils.len() != 1
        || pupils[0].id != child
        || !parent.apps.iter().any(|app| app == "attendance")
    {
        return Err(INVALID);
    }
    Ok(pupils[0].name.clone())
}

fn context(
    http: &mut Http,
    account: &str,
    child: &str,
    signal: &Signal,
) -> Result<(String, Options)> {
    let parent = http.read_parent(signal, Some(child))?;
    let name = selected(&parent, account, child)?;
    let options = http.read_app_data("attendance/attendance/appData", &[], signal, |data| {
        Options::parse(data, js::now_ms())
    })?;
    selected(&http.read_parent(signal, None)?, account, child)?;
    Ok((name, options))
}

fn path() -> Result<PathBuf> {
    default_secret_record_path("infomentor-mcp")
        .map(|path| path.with_file_name("absence.json"))
        .map_err(|_| RECORD_ERROR)
}

// A single record is deliberate: an uncertain write blocks ALL children and account changes.
// Successful state may be replaced for a different child/date; fresh upstream state also checks
// existing whole/partial-day reports. Logout does not remove this record.
fn load() -> Result<Option<Value>> {
    let bytes = match read_private_bytes(&path()?, 16_384) {
        Ok(bytes) => bytes,
        Err(error) if error.code == StoreCode::NotFound => return Ok(None),
        Err(_) => return Err(RECORD_ERROR),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| RECORD_ERROR)?;
    let valid = value["version"] == 1
        && value["operationId"].as_str().is_some_and(js::is_uuid)
        && ["accountId", "childId", "childName"].iter().all(|key| {
            value[key]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 4096)
        })
        && value["date"].as_str().is_some_and(valid_date)
        && value["day"]
            .as_str()
            .is_some_and(|s| ["today", "tomorrow"].contains(&s))
        && value["state"]
            .as_str()
            .is_some_and(|s| ["prepared", "submitting", "unknown", "submitted"].contains(&s))
        && value["expiresAt"].as_f64().is_some_and(f64::is_finite)
        && value["canAddSickness"].is_boolean();
    if valid {
        Ok(Some(value))
    } else {
        Err(RECORD_ERROR)
    }
}

fn save(value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| RECORD_ERROR)?;
    if bytes.len() > 16_384 {
        return Err(RECORD_ERROR);
    }
    write_private_file(&path()?, &bytes, &Cancel::default()).map_err(|_| RECORD_ERROR)
}

fn uncertain(record: &Value) -> bool {
    record["state"] == "submitting" || record["state"] == "unknown"
}

fn preview(record: &Value) -> Value {
    json!({"operationId": record["operationId"], "child": {"id": record["childId"], "name": record["childName"]}, "date": record["date"], "kind": "sick", "wholeDay": true, "expiresAt": js::iso_string(record["expiresAt"].as_f64().unwrap_or(0.0)), "requiresConfirmation": true})
}

pub fn prepare(http: &mut Http, child: &str, date: &str, signal: &Signal) -> Result<Value> {
    let previous = load()?;
    if previous.as_ref().is_some_and(uncertain) {
        return Err(BLOCKED);
    }
    let account = http.parent.as_ref().ok_or(INVALID)?.account_id.clone();
    if previous.as_ref().is_some_and(|old| {
        old["state"] == "submitted"
            && old["accountId"] == account
            && old["childId"] == child
            && old["date"] == date
    }) {
        return Err(Fail::new(
            Code::OperationInProgress,
            "This whole-day sickness report was already submitted. No new absence was sent.",
        ));
    }
    let (name, options) = context(http, &account, child, signal)?;
    let day = options.eligible(date)?;
    let record = json!({"version": 1, "operationId": js::uuid().ok_or(Fail::Unknown)?, "accountId": account, "childId": child, "childName": name, "date": date, "day": day.day, "canAddSickness": day.can_add_sickness, "expiresAt": js::now_ms() + TTL, "state": "prepared"});
    save(&record)?;
    Ok(preview(&record))
}

fn result(record: &Value, verified: bool) -> Value {
    json!({"operationId": record["operationId"], "child": {"id": record["childId"], "name": record["childName"]}, "date": record["date"], "outcome": if verified { "submitted" } else { "unknown" }, "stateVerified": verified, "schoolApproval": "notEstablished", "message": if verified { "InfoMentor reports the child absent for this date. This does not establish school approval." } else { "The absence may have been sent. Check InfoMentor; do not retry, prepare another report, or delete the private absence record." }})
}

pub fn submit(http: &mut Http, operation: &str, signal: &Signal) -> Result<Value> {
    let mut record = load()?.ok_or(INVALID)?;
    if record["operationId"] != operation {
        return Err(INVALID);
    }
    let account = http.parent.as_ref().ok_or(INVALID)?.account_id.clone();
    if record["accountId"] != account {
        return Err(INVALID);
    }
    if uncertain(&record) {
        return Ok(result(&record, false));
    }
    if record["state"] == "submitted" {
        return Ok(result(&record, true));
    }
    if js::now_ms() >= record["expiresAt"].as_f64().ok_or(RECORD_ERROR)? {
        return Err(INVALID);
    }
    let child = record["childId"].as_str().ok_or(RECORD_ERROR)?.to_owned();
    let date = record["date"].as_str().ok_or(RECORD_ERROR)?.to_owned();
    let (_, options) = context(http, &account, &child, signal)?;
    let day = options.eligible(&date)?;
    if record["day"] != day.day || record["canAddSickness"] != day.can_add_sickness {
        return Err(INVALID);
    }
    signal.check()?;
    // The relative day must still mean the date the human approved, including at UTC midnight.
    let now = js::now_ms();
    let offset = if day.day == "today" {
        0.0
    } else {
        86_400_000.0
    };
    if js::iso_string(now + offset).get(..10) != Some(date.as_str())
        || now >= record["expiresAt"].as_f64().ok_or(RECORD_ERROR)?
    {
        return Err(INVALID);
    }
    record["state"] = json!("submitting");
    save(&record)?; // never send if the durable guard cannot be written
    let payload = json!({"present": false, "day": day.day, "canAddSicknessToTimeRegistration": day.can_add_sickness, "RegType": "day"});
    // Any error AFTER the marker is unknown, NOT LOGIN_REQUIRED: the read wrapper must not
    // authenticate and replay a write. request_once also refuses ALL redirects (even same origin).
    let sent = http.request_once(
        &format!("{PARENT_URL}{}", REGISTER.trim_start_matches('/')),
        &payload,
        signal,
    );
    let verified = sent.is_ok()
        && context(http, &account, &child, signal).is_ok_and(|(_, options)| {
            options
                .days
                .iter()
                .any(|current| current.date == date && current.absent)
        });
    record["state"] = json!(if verified { "submitted" } else { "unknown" });
    save(&record)?;
    Ok(result(&record, verified))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_dates_reject_normalization_and_non_dates() {
        for date in ["2026-02-28", "2028-02-29", "2026-10-27"] {
            assert!(valid_date(date));
        }
        for date in [
            "2026-02-29",
            "2026-02-31",
            "2026-13-01",
            "2026-1-01",
            "2026-01-01T00:00:00Z",
            "2026-01-01 extra",
            "",
        ] {
            assert!(!valid_date(date), "{date}");
        }
    }

    #[test]
    fn source_dates_are_exact_and_round_trip() {
        assert_eq!(school_date("27.10.2026"), Some("2026-10-27".to_owned()));
        for date in [
            "31.02.2026",
            "2026-10-27",
            "1.10.2026",
            "01.10.26",
            "٠١.10.2026",
        ] {
            assert!(school_date(date).is_none());
        }
    }
}
