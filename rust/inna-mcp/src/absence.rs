//! The private absence record of packages/inna-mcp/src/client.ts and schemas.ts
//! (`absenceRecordSchema`): the last absence operation, kept in a plaintext file beside the legacy
//! session path, so either language reads what the other wrote.

use std::path::Path;

use family_store::{Cancel, Code as StoreCode, read_private_bytes, write_private_file};
use serde_json::{Map, Value, json};

use crate::dates;
use crate::error::{Fail, Result};
use crate::js;
use crate::session::{Binding, absence_path, positive, store_error};
use crate::shapes::is_id;

const MAX_RECORD_BYTES: usize = 32_768;

const UNREADABLE: Fail =
    Fail::Safe("Cannot read the private absence record. Do not delete it to retry a submission.");

/// `absenceInputSchema`'s output, without the student key it was given with.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub kind: &'static str,
    pub date_from: String,
    pub date_to: String,
    /// Trimmed.
    pub reason: String,
    /// Kept only when a record was written with one.
    pub student_key: Option<String>,
}

impl Request {
    /// `absenceInputSchema.safeParse`: strict, with both refinements.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let known = ["kind", "dateFrom", "dateTo", "reason", "studentKey"];
        object
            .keys()
            .all(|key| known.contains(&key.as_str()))
            .then_some(())?;
        let kind = match object.get("kind")?.as_str()? {
            "sick" => "sick",
            "leave" => "leave",
            _ => return None,
        };
        let date = |key: &str| {
            object
                .get(key)?
                .as_str()
                .filter(|text| dates::is_date(text))
                .map(str::to_owned)
        };
        let (date_from, date_to) = (date("dateFrom")?, date("dateTo")?);
        let reason = js::trim(object.get("reason")?.as_str()?);
        (1..=2000).contains(&js::length(reason)).then_some(())?;
        let student_key = match object.get("studentKey") {
            None => None,
            Some(key) => Some(key.as_str().filter(|key| is_id(key))?.to_owned()),
        };
        (js::compare(&date_from, &date_to).is_le() && (kind != "sick" || date_from == date_to))
            .then_some(())?;
        Some(Self {
            kind,
            date_from,
            date_to,
            reason: reason.to_owned(),
            student_key,
        })
    }

    pub fn to_json(&self) -> Value {
        let mut request = json!({
            "kind": self.kind,
            "dateFrom": self.date_from,
            "dateTo": self.date_to,
            "reason": self.reason,
        });

        if let Some(key) = &self.student_key {
            request["studentKey"] = json!(key);
        }
        request
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum State {
    Prepared,
    Submitting,
    Submitted,
    Unknown,
}

impl State {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "prepared" => State::Prepared,
            "submitting" => State::Submitting,
            "submitted" => State::Submitted,
            "unknown" => State::Unknown,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            State::Prepared => "prepared",
            State::Submitting => "submitting",
            State::Submitted => "submitted",
            State::Unknown => "unknown",
        }
    }
}

/// `AbsenceRecord`.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub operation_id: String,
    pub account: Binding,
    pub student_key: Option<String>,
    pub request: Request,
    pub state: State,
    pub expires_at: f64,
    pub upstream_id: Option<i64>,
}

impl Record {
    /// `absenceRecordSchema.parse`.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let student_key = match object.get("studentKey") {
            None => None,
            Some(key) => Some(key.as_str().filter(|key| is_id(key))?.to_owned()),
        };
        let upstream_id = match object.get("upstreamId") {
            None => None,
            Some(id) => Some(positive(id)?),
        };
        Some(Self {
            operation_id: object
                .get("operationId")?
                .as_str()
                .filter(|id| js::is_uuid(id))?
                .to_owned(),
            account: Binding::parse(object.get("account")?)?,
            student_key,
            request: Request::parse(object.get("request")?)?,
            state: State::parse(object.get("state")?.as_str()?)?,
            expires_at: object.get("expiresAt")?.as_f64()?,
            upstream_id,
        })
    }

    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("operationId".to_owned(), json!(self.operation_id));
        record.insert("account".to_owned(), self.account.to_json());

        if let Some(key) = &self.student_key {
            record.insert("studentKey".to_owned(), json!(key));
        }
        record.insert("request".to_owned(), self.request.to_json());
        record.insert("state".to_owned(), json!(self.state.name()));
        record.insert("expiresAt".to_owned(), js::number(self.expires_at));

        if let Some(id) = self.upstream_id {
            record.insert("upstreamId".to_owned(), json!(id));
        }
        Value::Object(record)
    }
}

/// `readAbsence`: the record beside the legacy path, or `None` when there is none.
pub fn read(legacy: &Path) -> Result<Option<Record>> {
    let bytes = match read_private_bytes(&absence_path(legacy), MAX_RECORD_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.code == StoreCode::NotFound => return Ok(None),
        Err(_) => return Err(UNREADABLE),
    };
    js::parse(&bytes)
        .as_ref()
        .and_then(Record::parse)
        .map(Some)
        .ok_or(UNREADABLE)
}

/// `saveAbsence`: replaces the record. Like the TypeScript write, it is never cancelled.
pub fn write(legacy: &Path, record: &Record) -> Result<()> {
    let text = record.to_json().to_string();
    write_private_file(&absence_path(legacy), text.as_bytes(), &Cancel::default())
        .map_err(|error| store_error(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(text: &str) -> Option<Record> {
        Record::parse(&js::parse(text.as_bytes()).unwrap())
    }

    #[test]
    fn records_parse_and_write_as_the_typescript_schema() {
        let text = r#"{"x":1,"expiresAt":1.5,"state":"prepared","request":{"reason":"  r  ","dateTo":"2040-01-02","dateFrom":"2040-01-02","kind":"sick"},"account":{"schoolId":"3","studentId":"2","userId":1},"operationId":"123e4567-e89b-12d3-a456-426614174000"}"#;
        assert_eq!(
            record(text).unwrap().to_json().to_string(),
            r#"{"operationId":"123e4567-e89b-12d3-a456-426614174000","account":{"userId":1,"studentId":"2","schoolId":"3"},"request":{"kind":"sick","dateFrom":"2040-01-02","dateTo":"2040-01-02","reason":"r"},"state":"prepared","expiresAt":1.5}"#
        );
        let full = r#"{"operationId":"123e4567-e89b-12d3-a456-426614174000","account":{"userId":1,"studentId":"2","schoolId":"3"},"studentKey":"5","request":{"kind":"leave","dateFrom":"2040-01-02","dateTo":"2040-01-04","reason":"r","studentKey":"5"},"state":"submitted","expiresAt":2,"upstreamId":123}"#;
        assert_eq!(record(full).unwrap().to_json().to_string(), full);

        for invalid in [
            full.replace("123e4567", "x"),
            full.replace(r#""kind":"leave""#, r#""kind":"sick""#),
            full.replace(r#""dateTo":"2040-01-04""#, r#""dateTo":"2040-01-01""#),
            full.replace(r#""reason":"r""#, r#""reason":" ""#),
            full.replace(r#""reason":"r""#, r#""reason":"r","x":1"#),
            full.replace(r#""upstreamId":123"#, r#""upstreamId":0"#),
            full.replace(r#""state":"submitted""#, r#""state":"done""#),
            full.replace(
                r#""studentKey":"5","request""#,
                r#""studentKey":"x","request""#,
            ),
        ] {
            assert!(record(&invalid).is_none(), "{invalid}");
        }
    }
}
