//! packages/inna-mcp/src/client.ts's `InnaClient`: every operation holds the session (`locked`),
//! talks to nam.inna.is with its cookies, switches and verifies the student, and writes the
//! cookie jar and any rate-limit pause back before the hold ends.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use family_store::Cancel;
use reqwest::header::{
    ACCEPT, CONTENT_TYPE, COOKIE, HeaderMap, HeaderName, HeaderValue, LOCATION, RETRY_AFTER,
    SET_COOKIE,
};
use serde_json::{Map, Value, json};
use tokio::sync::RwLock;
use url::Url;

use crate::absence::{self, Record, State};
use crate::dates;
use crate::error::{Fail, Result};
use crate::html::plain_text;
use crate::input::Range;
use crate::jar::{self, Jar};
use crate::js;
use crate::session::{
    Binding, COOKIE_NAMES, Held, Learned, Saved, TOO_MANY_STUDENTS, credentials, locked, positive,
    session_path,
};
use crate::shapes::{self, S, is_id};
use crate::signal::Signal;
use crate::store::MAX_STUDENTS;
use crate::upstream::Net;

pub const ORIGIN: &str = "https://nam.inna.is";

const USER_ENDPOINT: &str = "/api/UserData/GetLoggedInUser";

const STUDENT_PATHS: [&str; 2] = ["/Components/Students/Students.html", "/auth/system"];

/// Each request's own limit, its body included (`AbortSignal.timeout(30_000)`).
const DEADLINE: Duration = Duration::from_secs(30);

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// `Date.parse('9999-12-31T23:59:59.999Z')`: the latest pause saved.
const LATEST: f64 = 253_402_300_799_999.0;

const SIGN_IN_REQUIRED: &str =
    "Inna sign-in is required. Run auth login or import a fresh private cookie export.";

const SESSION_EXPIRED: &str = "Inna session expired. Run inna-mcp auth login or import a fresh private browser cookie export.";

const SWITCH_REFUSED: Fail = Fail::Safe(
    "Inna refused the student switch and asked for sign-in. The session may have ended; sign in again and report this.",
);

const CONTEXT_CHANGED: Fail =
    Fail::Safe("Inna changed account, student, or school. Import the intended session explicitly.");

const UNKNOWN_STUDENT: Fail = Fail::Safe(
    "That student is not in this Inna session. Use a studentKey from inna_list_students.",
);

const UNEXPECTED: Fail = Fail::Safe("Inna returned an unavailable or unexpected response.");

const NO_SESSION: Fail = Fail::Safe(
    "No Inna session. Run inna-mcp auth login or auth import with a private cookie export.",
);

const WRITES_NOT_ALLOWED: Fail = Fail::Safe("Absence writes require --allow-absence-writes.");

/// `noPreview`.
const NO_PREVIEW: Fail =
    Fail::Safe("No matching absence preview for this account, student, and school.");

const PREVIEW_EXPIRED: Fail =
    Fail::Safe("The absence preview expired. Prepare and approve a fresh preview.");

/// How long a preview may be submitted: ten minutes.
const PREVIEW_LIFETIME: f64 = 600_000.0;

const DAY: f64 = 86_400_000.0;

/// `new URL(ORIGIN)`.
fn origin() -> Url {
    Url::parse(ORIGIN).expect("ORIGIN is a URL")
}

/// `url.origin === ORIGIN`.
fn is_origin(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("nam.inna.is") && url.port().is_none()
}

/// `headers.get(name)`: every value, joined with `, `, as the bytes Bun reads as Latin-1.
pub fn header(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| {
            value
                .as_bytes()
                .iter()
                .map(|&byte| char::from(byte))
                .collect()
        })
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// The user Inna reports as logged in (`userSchema`'s output).
#[derive(Clone)]
pub struct User(Map<String, Value>);

impl User {
    fn parse(value: &Value) -> Result<Self> {
        match shapes::parse(&shapes::USER, value) {
            Some(Value::Object(user)) => Ok(Self(user)),
            _ => Err(Fail::Invalid),
        }
    }

    fn text(&self, key: &str) -> &str {
        self.0.get(key).and_then(Value::as_str).unwrap_or_default()
    }

    fn user_id(&self) -> i64 {
        self.0.get("userId").and_then(positive).unwrap_or_default()
    }

    pub fn binding(&self) -> Binding {
        Binding {
            user_id: self.user_id(),
            student_id: self.text("studentId").to_owned(),
            school_id: self.text("schoolId").to_owned(),
        }
    }

    pub fn learned(&self) -> Learned {
        Learned {
            binding: self.binding(),
            student_name: self.text("studentName").to_owned(),
        }
    }

    fn is_set(&self, key: &str) -> bool {
        self.text(key) == "1"
    }

    fn older_than_18(&self) -> bool {
        self.0.get("olderThan18") == Some(&Value::Bool(true))
    }

    /// `contextSchema.parse(user)`.
    pub fn context(&self) -> Value {
        let context: Map<String, Value> = shapes::CONTEXT_FIELDS
            .iter()
            .filter_map(|key| Some(((*key).to_owned(), self.0.get(*key)?.clone())))
            .collect();
        Value::Object(context)
    }
}

/// `digits`: an id, or a non-negative safe integer, as text.
fn digits(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if is_id(text) => Some(text.clone()),
        number @ Value::Number(_) => {
            let number = number.as_f64()?;
            (number.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&number))
                .then(|| (number as i64).to_string())
        }
        _ => None,
    }
}

/// `accessStudentSchema`'s `loggedIn`.
fn logged_in(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) if text == "0" || text == "1" => Some(text == "1"),
        Value::Number(number) => match number.as_f64()? {
            0.0 => Some(false),
            1.0 => Some(true),
            _ => None,
        },
        _ => None,
    }
}

/// One access entry of the student application (`accessStudentSchema` and its index). Identity
/// numbers and login links are never read.
pub struct Student {
    system: String,
    status: String,
    user_id: String,
    logged_in: bool,
    school_id: Option<String>,
    school_name: Option<String>,
    title: Option<String>,
    name: Option<String>,
    index: usize,
}

/// `studentEntries`: `None` when Inna's access list is absent or cannot be read without guessing.
pub fn student_entries(user: &User) -> Option<Vec<Student>> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let mut students: Vec<Student> = Vec::new();

    for (index, raw) in user.0.get("access")?.as_array()?.iter().enumerate() {
        let entry = raw.as_object()?;
        let system = digits(entry.get("system"))?;

        if system != "1" {
            continue;
        }
        let student = Student {
            status: digits(entry.get("status"))?,
            user_id: digits(entry.get("userId"))?,
            logged_in: logged_in(entry.get("loggedIn"))?,
            school_id: digits(entry.get("skoli_id")),
            school_name: text(entry.get("skoli_heiti")),
            title: text(entry.get("title")),
            name: text(entry.get("nafn")),
            system,
            index,
        };

        if students
            .iter()
            .any(|known| known.user_id == student.user_id)
        {
            return None;
        }
        students.push(student);
    }
    Some(students)
}

/// `selectedKey`: the one entry Inna has selected, if exactly one.
fn selected_key(students: Option<&[Student]>) -> Option<&str> {
    let mut selected = students
        .unwrap_or_default()
        .iter()
        .filter(|student| student.logged_in);

    match (selected.next(), selected.next()) {
        (Some(student), None) => Some(&student.user_id),
        _ => None,
    }
}

/// `defaultKey`: Inna's selected access entry carries the logged-in context's userId.
fn default_key(saved: &Saved) -> String {
    saved.account.user_id.to_string()
}

/// `matchesEntry`: the context is the only selected student entry and agrees with it on user and
/// school.
pub fn matches_entry(user: &User, key: &str) -> bool {
    let students = student_entries(user);
    let entry = students
        .iter()
        .flatten()
        .find(|student| student.user_id == key);

    selected_key(students.as_deref()) == Some(key)
        && user.user_id().to_string() == key
        && entry.and_then(|entry| entry.school_id.as_deref()) == Some(user.text("schoolId"))
}

/// `learn`: trust on first use; a key keeps the binding first verified for it.
fn learn(saved: &mut Saved, key: &str, user: &User) -> Result<Binding> {
    let current = user.binding();

    if let Some(known) = saved.student(key) {
        return match known.binding == current {
            true => Ok(known.binding.clone()),
            false => Err(CONTEXT_CHANGED),
        };
    }
    let mut taken: Vec<&str> = saved
        .students
        .iter()
        .map(|(_, student)| student.binding.student_id.as_str())
        .collect();

    if key == default_key(saved) {
        if saved.account != current {
            return Err(CONTEXT_CHANGED);
        }
    } else {
        taken.push(&saved.account.student_id);
    }

    if taken.contains(&current.student_id.as_str()) {
        return Err(Fail::Safe(
            "Inna returned a student already saved under another studentKey. The result was discarded.",
        ));
    }

    if saved.students.len() >= MAX_STUDENTS {
        return Err(TOO_MANY_STUDENTS);
    }
    saved.students.push((key.to_owned(), user.learned()));
    Ok(current)
}

/// `Target`: the user a read is for, its binding, and the key that chose it.
pub struct Target {
    pub user: User,
    pub binding: Binding,
    pub key: Option<String>,
}

/// `canRegisterAbsence`: whether Inna lets this login register `kind` for the student.
fn can_register_absence(user: &User, kind: &str) -> bool {
    let guardian = user.text("logInType") == "2";
    let older = user.older_than_18();

    match kind {
        "sick" => {
            (guardian && user.is_set("registerAbsenceGuardian"))
                || (!older && user.is_set("registerAbsenceUnder18"))
                || (older && user.is_set("registerAbsenceOver18"))
        }
        _ => {
            (guardian && (user.is_set("registerLeave") || user.is_set("registerAbsence")))
                || (user.text("logInType") == "1"
                    && older
                    && (user.is_set("student18RegisterLeave")
                        || user.is_set("student18RegisterAbsence")))
        }
    }
}

/// `upstreamDate`: the UTC day of a date Inna returned.
fn upstream_date(value: Option<&Value>) -> Result<String> {
    match dates::normalize(value) {
        Some(iso) => Ok(iso[..10].to_owned()),
        None => Err(Fail::Safe(
            "Inna returned an unrecognized absence date. Review history before submitting.",
        )),
    }
}

/// `new Date(ms).toISOString().slice(0, 10)`.
fn utc_day(ms: f64) -> Result<String> {
    let iso = js::iso_string(ms).ok_or(Fail::Unknown)?;
    Ok(iso[..10].to_owned())
}

/// `checkAbsence`: the request starts today or later, Inna permits it for this login (and, for
/// a sick day, that date), and nothing in Inna's history overlaps it. Returns the UTC day it
/// checked on.
fn check_absence(
    connection: &mut Connection,
    user: &User,
    request: &absence::Request,
) -> Result<String> {
    let checked_at = js::client_now();
    let today = utc_day(checked_at)?;
    let (from, to) = (request.date_from.as_str(), request.date_to.as_str());

    if from < today.as_str() {
        return Err(Fail::Safe("New absence requests cannot start in the past."));
    }

    if !can_register_absence(user, request.kind) {
        return Err(Fail::Safe(
            "Inna does not permit this absence request for that account.",
        ));
    }

    if request.kind == "sick" {
        let options = connection.read(
            "/api/RegisterAbsence/GetRegisterAbsences",
            &[],
            &shapes::SICK_OPTIONS,
        )?;
        let allowed = |key: &str| options.get(key) == Some(&Value::Bool(true));
        let tomorrow = utc_day(checked_at + DAY)?;
        let permitted = match from == today {
            true => allowed("todayAllowed"),
            false => {
                from == tomorrow
                    && allowed("tomorrowAllowed")
                    && user.is_set("registerIllnessTomorrow")
            }
        };

        if !permitted {
            return Err(Fail::Safe(
                "Inna does not permit sick-day registration for that date and account.",
            ));
        }
    }
    let (inna_from, inna_to) = (inna_date(from), inna_date(to));
    let records = connection.read(
        "/api/RegisterAbsence/GetStudentRegisteredAbsences",
        &[("dateFrom", &inna_from), ("dateTo", &inna_to)],
        &shapes::SICKNESS,
    )?;

    // `some`: a date after the first match is never read.
    for record in records.as_array().map(Vec::as_slice).unwrap_or_default() {
        let day = upstream_date(record.get("date"))?;

        if from <= day.as_str() && day.as_str() <= to {
            return Err(Fail::Safe(
                "An absence is already registered in that date range. Review it in Inna before submitting another.",
            ));
        }
    }
    let leaves = connection.read(
        "/api/RegisterAbsence/GetLeaves",
        &[("getDateFrom", &inna_from), ("getDateTo", &inna_to)],
        &shapes::LEAVES,
    )?;

    for record in leaves.as_array().map(Vec::as_slice).unwrap_or_default() {
        // `&&`: the end is read only when the start does not already rule the leave out.
        if upstream_date(record.get("dateFrom"))?.as_str() <= to
            && upstream_date(record.get("dateTo"))?.as_str() >= from
        {
            return Err(Fail::Safe(
                "An overlapping absence application exists. Review it in Inna before submitting another.",
            ));
        }
    }
    Ok(today)
}

fn still_selected(target: &Target, current: &User) -> bool {
    target.binding == current.binding()
        && target
            .key
            .as_deref()
            .is_none_or(|key| matches_entry(current, key))
}

/// `Connection`: requests with the saved cookies, under the saved rate-limit pause.
pub struct Connection<'a> {
    pub jar: Jar,
    pub pause_until: f64,
    net: &'a Net,
    signal: &'a Signal,
}

impl<'a> Connection<'a> {
    pub fn new(jar: Jar, pause_until: f64, net: &'a Net, signal: &'a Signal) -> Self {
        Self {
            jar,
            pause_until,
            net,
            signal,
        }
    }

    fn check_pause(&self) -> Result<()> {
        match self.pause_until > js::client_now() {
            true => Err(Fail::Safe(
                "Inna requested a pause. Wait before making another request.",
            )),
            false => Ok(()),
        }
    }

    /// `deadline`: this request's limit, with the operation's own signal.
    fn deadline(&self) -> Signal {
        self.signal.any(&Signal::timeout(DEADLINE))
    }

    /// `capture`: only the session cookies are kept; one Inna may not set is an error.
    fn capture(&mut self, headers: &HeaderMap) -> Result<()> {
        for value in headers.get_all(SET_COOKIE) {
            let text: String = value
                .as_bytes()
                .iter()
                .map(|&byte| char::from(byte))
                .collect();

            if let Some(cookie) = jar::parse(&text)
                && COOKIE_NAMES.contains(&cookie.key())
            {
                self.jar
                    .set(cookie, &origin())
                    .map_err(|()| Fail::Unknown)?;
            }
        }
        Ok(())
    }

    /// `pause`: Retry-After in seconds or as a date, at least a minute, saved with the session.
    fn pause(&mut self, headers: &HeaderMap) -> Fail {
        let now = js::client_now();
        let milliseconds = match header(headers, RETRY_AFTER) {
            Some(retry) if !retry.is_empty() && retry.bytes().all(|byte| byte.is_ascii_digit()) => {
                retry.parse::<f64>().unwrap_or(f64::NAN) * 1000.0
            }
            Some(retry) if !retry.is_empty() => js::parse_date(&retry) - now,
            _ => f64::NAN,
        };
        let wait = match milliseconds.is_finite() && milliseconds > 0.0 {
            true => milliseconds.max(60_000.0),
            false => 60_000.0,
        };
        self.pause_until = LATEST.min(now + wait);
        Fail::Safe("Inna rate limited this session. Wait before trying again.")
    }

    /// `request`: an Inna API read (or, with a body, a write) parsed as JSON.
    pub fn request(
        &mut self,
        endpoint: &str,
        params: &[(&str, &str)],
        body: Option<String>,
    ) -> Result<Value> {
        self.check_pause()?;
        let mut url = origin().join(endpoint).map_err(|_| Fail::Unknown)?;

        if !is_origin(&url) || !url.path().starts_with("/api/") {
            return Err(Fail::Safe(
                "Inna requests must use the verified API origin.",
            ));
        }
        let query: Vec<String> = params
            .iter()
            .map(|(name, value)| format!("{}={}", js::encode_query(name), js::encode_query(value)))
            .collect();
        url.set_query((!query.is_empty()).then(|| query.join("&")).as_deref());
        let cookies = self.jar.get(&url);
        let xsrf = cookies.iter().find(|cookie| cookie.key() == "XSRF-TOKEN");
        let Some(xsrf) = xsrf.filter(|_| cookies.iter().any(|cookie| cookie.key() == "SESSION"))
        else {
            return Err(Fail::Safe(SESSION_EXPIRED));
        };
        let value = |text: &str| HeaderValue::from_str(text).map_err(|_| Fail::Unknown);
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(
            HeaderName::from_static("x-requested-by"),
            HeaderValue::from_static("XMLHttpRequest"),
        );
        headers.insert(COOKIE, value(&self.jar.header(&url))?);
        headers.insert(
            HeaderName::from_static("x-xsrf-token"),
            value(xsrf.value())?,
        );

        if body.is_some() {
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json;charset=UTF-8"),
            );
        }
        let deadline = self.deadline();
        let response = self
            .net
            .send(&deadline, &url, headers, body)
            .flatten()
            .ok_or(Fail::Unknown)?;
        self.capture(&response.headers)?;

        match response.status {
            429 => return Err(self.pause(&response.headers)),
            401 | 300..=399 => return Err(Fail::Safe(SIGN_IN_REQUIRED)),
            403 => return Err(Fail::Safe("Inna denied access to this operation.")),
            _ => {}
        }
        let json = header(&response.headers, CONTENT_TYPE)
            .is_some_and(|kind| kind.to_ascii_lowercase().contains("application/json"));

        if !(200..=299).contains(&response.status) || !json {
            return Err(UNEXPECTED);
        }
        let body = self
            .net
            .read(&deadline, response, MAX_BODY_BYTES)
            .ok_or(Fail::Unknown)?
            .map_err(|_| Fail::Unknown)?;
        js::parse(&body).ok_or(Fail::Unknown)
    }

    /// `request`, then `schema.parse`.
    fn read(&mut self, endpoint: &str, params: &[(&str, &str)], schema: &S) -> Result<Value> {
        let value = self.request(endpoint, params, None)?;
        shapes::parse(schema, &value).ok_or(Fail::Invalid)
    }

    pub fn user(&mut self) -> Result<User> {
        User::parse(&self.request(USER_ENDPOINT, &[], None)?)
    }

    /// `selectStudent`: Inna's own student switch, a cookie-only navigation that ends on the
    /// student application.
    fn select_student(&mut self, student: &Student) -> Result<()> {
        self.check_pause()?;
        let mut url = origin().join("/auth/system").map_err(|_| Fail::Unknown)?;
        let query = [
            ("i", student.index.to_string()),
            ("system", student.system.clone()),
            ("status", student.status.clone()),
            ("user_id", student.user_id.clone()),
        ]
        .iter()
        .map(|(name, value)| format!("{name}={}", js::encode_query(value)))
        .collect::<Vec<_>>()
        .join("&");
        url.set_query(Some(&query));

        for _ in 0..5 {
            if !self
                .jar
                .get(&url)
                .iter()
                .any(|cookie| cookie.key() == "SESSION")
            {
                return Err(Fail::Safe(SESSION_EXPIRED));
            }
            let mut headers = HeaderMap::new();
            headers.insert(ACCEPT, HeaderValue::from_static("text/html"));
            headers.insert(
                COOKIE,
                HeaderValue::from_str(&self.jar.header(&url)).map_err(|_| Fail::Unknown)?,
            );
            let response = self
                .net
                .send(&self.deadline(), &url, headers, None)
                .flatten()
                .ok_or(Fail::Unknown)?;
            self.capture(&response.headers)?;
            let (status, headers) = (response.status, response.headers.clone());
            // The body is never read.
            drop(response);

            if status == 429 {
                return Err(self.pause(&headers));
            }

            if status == 200 {
                return Ok(());
            }
            let location = header(&headers, LOCATION);

            if status == 401 {
                return Err(SWITCH_REFUSED);
            }
            let Some(location) =
                location.filter(|location| (300..=399).contains(&status) && !location.is_empty())
            else {
                return Err(UNEXPECTED);
            };
            let mut next = url.join(&location).map_err(|_| Fail::Unknown)?;

            if next.scheme() == "http"
                && next.host_str() == Some("nam.inna.is")
                && next.port().is_none()
            {
                let _ = next.set_scheme("https");
            }

            if !is_origin(&next) || !STUDENT_PATHS.contains(&next.path()) {
                return Err(SWITCH_REFUSED);
            }
            next.set_fragment(None);
            url = next;
        }
        Err(UNEXPECTED)
    }
}

/// `select`: the target of a read, switching Inna to it when another student is selected.
fn select(
    connection: &mut Connection,
    saved: &mut Saved,
    user: User,
    student_key: Option<&str>,
) -> Result<Target> {
    let students = student_entries(&user).filter(|students| !students.is_empty());

    let Some(students) = students else {
        // Without a usable student list nothing can be selected: only the saved binding decides.
        if student_key.is_some() {
            return Err(UNKNOWN_STUDENT);
        }

        if saved.account != user.binding() {
            return Err(CONTEXT_CHANGED);
        }
        return Ok(Target {
            user,
            binding: saved.account.clone(),
            key: None,
        });
    };
    let key = student_key.map_or_else(|| default_key(saved), str::to_owned);
    let Some(target) = students.iter().find(|student| student.user_id == key) else {
        return Err(match student_key {
            None => CONTEXT_CHANGED,
            Some(_) => UNKNOWN_STUDENT,
        });
    };

    if selected_key(Some(&students)) == Some(&key) {
        if !matches_entry(&user, &key) {
            return Err(CONTEXT_CHANGED);
        }
        let binding = learn(saved, &key, &user)?;
        return Ok(Target {
            user,
            binding,
            key: Some(key),
        });
    }
    connection.select_student(target)?;
    let switched = connection.user()?;

    if !matches_entry(&switched, &key) {
        return Err(Fail::Safe(
            "Inna did not select the requested student. The result was discarded.",
        ));
    }
    let binding = learn(saved, &key, &switched)?;
    Ok(Target {
        user: switched,
        binding,
        key: Some(key),
    })
}

/// `record.dates = parseDates({...})`: each named field of `record`, read where it is.
fn date(record: &mut Value, fields: &[&str]) {
    let parsed = dates::parse(fields.iter().map(|field| (*field, record.get(*field))));

    if let Some(record) = record.as_object_mut() {
        record.insert("dates".to_owned(), parsed);
    }
}

/// `field = plainText(field)`, where the field is text.
fn plain(record: &mut Value, field: &str) {
    if let Some(Value::String(text)) = record.get_mut(field) {
        *text = plain_text(text);
    }
}

fn items(value: &mut Value) -> &mut [Value] {
    match value {
        Value::Array(items) => items,
        _ => &mut [],
    }
}

/// `schemas.innaDate`: Inna's day-first date.
fn inna_date(date: &str) -> String {
    let parts: Vec<&str> = date.split('-').collect();
    match parts[..] {
        [year, month, day] => format!("{day}.{month}.{year}"),
        _ => date.to_owned(),
    }
}

/// `stamp`: when the result was read, in UTC.
fn stamp(output: &mut Map<String, Value>) -> Result<()> {
    let retrieved = js::iso_string(js::client_now()).ok_or(Fail::Unknown)?;
    output.insert("retrievedAt".to_owned(), json!(retrieved));
    output.insert("timeZone".to_owned(), json!("UTC"));
    Ok(())
}

/// `KeepAlive`'s status.
pub type KeepAlive = &'static str;

pub struct Client {
    path: PathBuf,
    net: Net,
    pub allow_absence_writes: bool,
    /// The credentials Inna last refused, in memory only; keep-alive waits for new ones.
    refused: Mutex<Option<String>>,
    /// Held by every operation in flight; `idle` waits for them, as the TypeScript process stays
    /// alive until its requests and write-backs end.
    running: Arc<RwLock<()>>,
}

impl Client {
    /// `None` outside a Tokio runtime or when no HTTP client can be built.
    pub fn new(path: PathBuf, allow_absence_writes: bool) -> Option<Self> {
        Some(Self {
            path,
            net: Net::new()?,
            allow_absence_writes,
            refused: Mutex::new(None),
            running: Arc::default(),
        })
    }

    /// The client of `serve` and the auth commands: INNA_SESSION_FILE or the default legacy path.
    pub fn from_environment(allow_absence_writes: bool) -> Result<Self> {
        Self::new(session_path()?, allow_absence_writes).ok_or(Fail::Unknown)
    }

    /// Run `work` on a blocking thread with `signal` and its store cancel flag.
    pub async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        signal: Signal,
        work: impl FnOnce(&Client, &Signal, &Cancel) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let running = self.running.clone().read_owned().await;
        let client = self.clone();

        tokio::task::spawn_blocking(move || {
            let _running = running;
            let bridge = signal.store_cancel(&client.net.handle);
            work(&client, &signal, &bridge.cancel)
        })
        .await
        .unwrap_or(Err(Fail::Unknown))
    }

    /// The legacy session path, beside which the absence record lives.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn net(&self) -> &Net {
        &self.net
    }

    /// Wait for every operation in flight.
    pub async fn idle(&self) {
        let _ = self.running.write().await;
    }

    /// `session`: the saved session, or the refusal to read without one.
    fn session<T>(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        work: impl FnOnce(&mut Connection, &mut Saved) -> Result<T>,
    ) -> Result<T> {
        locked(&self.path, cancel, |held| {
            let mut saved = held.read()?.ok_or(NO_SESSION)?;
            self.persisting(held, &mut saved, signal, work)
        })
    }

    /// `persisting`: runs `work` on the saved cookies and always writes back the jar and any
    /// rate-limit pause.
    fn persisting<T>(
        &self,
        held: &mut Held,
        saved: &mut Saved,
        signal: &Signal,
        work: impl FnOnce(&mut Connection, &mut Saved) -> Result<T>,
    ) -> Result<T> {
        let jar = Jar::deserialize(&saved.jar).ok_or(Fail::Unknown)?;
        let before = credentials(saved)?;
        let mut connection = Connection::new(jar, saved.pause_until, &self.net, signal);
        let outcome = work(&mut connection, saved);
        saved.jar = connection.jar.serialize().ok_or(Fail::Unknown)?;
        saved.pause_until = connection.pause_until;
        held.write_back(saved, &before)?;
        outcome
    }

    /// `withStudent`: the read, for the student `pick` chooses inside the hold, verified before
    /// and (unless `verify_after` is false) after it, and stamped.
    fn with_student(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        pick: impl FnOnce() -> Result<Option<String>>,
        verify_after: bool,
        work: impl FnOnce(&mut Connection, &Target) -> Result<Map<String, Value>>,
    ) -> Result<Value> {
        self.session(signal, cancel, |connection, saved| {
            let key = pick()?;
            let user = connection.user()?;
            let target = select(connection, saved, user, key.as_deref())?;
            let mut output = work(connection, &target)?;

            if verify_after && !still_selected(&target, &connection.user()?) {
                return Err(Fail::Safe(
                    "Inna changed account, student, or school during the read. The result was discarded.",
                ));
            }
            stamp(&mut output)?;
            Ok(Value::Object(output))
        })
    }

    /// `withUser`, with the verification after the read.
    fn with_user(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        key: Option<&str>,
        work: impl FnOnce(&mut Connection, &User) -> Result<Vec<(&'static str, Value)>>,
    ) -> Result<Value> {
        let pick = || Ok(key.map(str::to_owned));
        self.with_student(signal, cancel, pick, true, |connection, target| {
            let fields = work(connection, &target.user)?;
            let mut output = Map::new();
            output.insert("context".to_owned(), target.user.context());

            for (name, value) in fields {
                output.insert(name.to_owned(), value);
            }
            Ok(output)
        })
    }

    /// `keepAlive`: touches the saved session so Inna does not idle it out. Reads no school data,
    /// never switches or learns a student, and reports every failure as a status. It never
    /// resets the store.
    pub fn keep_alive(&self, signal: &Signal, cancel: &Cancel) -> KeepAlive {
        let refused = || {
            self.refused
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        };
        let mut seen: Option<Saved> = None;
        let outcome = locked(&self.path, cancel, |held| {
            let Some(saved) = held.read()? else {
                return Ok("skipped");
            };
            let saved = seen.insert(saved);

            if saved.pause_until > js::client_now() || Some(credentials(saved)?) == refused() {
                return Ok("skipped");
            }
            self.persisting(held, saved, signal, |connection, _| {
                connection.user().map(drop)
            })?;
            Ok("kept")
        });

        match outcome {
            Ok(status) => status,
            Err(Fail::Safe(message))
                if message == SIGN_IN_REQUIRED || message == SESSION_EXPIRED =>
            {
                // Taken from the jar as written back, so a cookie set by the refusal counts.
                *self.refused.lock().unwrap_or_else(PoisonError::into_inner) =
                    seen.as_ref().and_then(|saved| credentials(saved).ok());
                "signInRequired"
            }
            Err(_) => "failed",
        }
    }

    pub fn status(&self, signal: &Signal, cancel: &Cancel, key: Option<&str>) -> Result<Value> {
        let storage = locked(&self.path, cancel, |held| {
            Ok(held.read()?.map(|_| held.storage()))
        })?;
        let Some(storage) = storage else {
            return Ok(json!({ "authenticated": false }));
        };
        let pick = || Ok(key.map(str::to_owned));
        self.with_student(signal, cancel, pick, true, |_, target| {
            let mut output = Map::new();
            output.insert("authenticated".to_owned(), json!(true));
            output.insert("storage".to_owned(), json!(storage));
            output.insert("context".to_owned(), target.user.context());
            Ok(output)
        })
    }

    pub fn list_students(&self, signal: &Signal, cancel: &Cancel) -> Result<Value> {
        self.session(signal, cancel, |connection, saved| {
            let user = connection.user()?;
            let entries = student_entries(&user).ok_or(Fail::Safe(
                "Inna returned no usable student list. Omit studentKey to read the default student.",
            ))?;
            let on_default = saved.account == user.binding();
            let known = default_key(saved);
            let optional = |value: Option<&String>| value.map_or(Value::Null, |text| json!(text));
            let students: Vec<Value> = match entries.is_empty() {
                true => vec![json!({
                    "schoolName": user.text("schoolLong"),
                    "schoolId": user.text("schoolId"),
                    "selected": true,
                    "isDefault": on_default,
                    "studentId": user.text("studentId"),
                    "studentName": user.text("studentName"),
                })],
                false => entries
                    .iter()
                    .map(|entry| {
                        let student = saved.student(&entry.user_id);
                        let fields = [
                            ("studentKey", json!(entry.user_id)),
                            ("title", optional(entry.title.as_ref())),
                            ("schoolName", optional(entry.school_name.as_ref())),
                            ("schoolId", optional(entry.school_id.as_ref())),
                            ("selected", json!(entry.logged_in)),
                            ("isDefault", json!(entry.user_id == known)),
                            (
                                "studentId",
                                optional(student.map(|student| &student.binding.student_id)),
                            ),
                            ("studentName", optional(entry.name.as_ref())),
                        ];
                        // `undefined` fields are left out, as JSON.stringify does.
                        Value::Object(
                            fields
                                .into_iter()
                                .filter(|(_, value)| !value.is_null())
                                .map(|(name, value)| (name.to_owned(), value))
                                .collect(),
                        )
                    })
                    .collect(),
            };
            let mut output = Map::new();
            output.insert("students".to_owned(), Value::Array(students));
            output.insert("context".to_owned(), user.context());
            stamp(&mut output)?;
            Ok(Value::Object(output))
        })
    }

    pub fn overview(&self, signal: &Signal, cancel: &Cancel, key: Option<&str>) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let mut announcements = connection.read(
                "/api/Announcements/GetStudentAnnouncements",
                &[],
                &shapes::ANNOUNCEMENTS,
            )?;

            for announcement in items(&mut announcements) {
                plain(announcement, "contentHtml");
                date(announcement, &["date"]);
            }
            let mut courses = connection.read(
                "/api/ModulesAndBooklist/GetModulesAndBooklist",
                &[("termId", "")],
                &shapes::COURSES,
            )?;

            for course in items(&mut courses) {
                date(course, &["dateFrom", "dateTo"]);
            }
            let terms =
                connection.read("/api/StudentTerms/GetStudentTerms", &[], &shapes::TERMS)?;
            Ok(vec![
                ("terms", terms),
                ("courses", courses),
                ("announcements", announcements),
            ])
        })
    }

    pub fn timetable(&self, signal: &Signal, cancel: &Cancel, range: &Range) -> Result<Value> {
        self.with_user(
            signal,
            cancel,
            range.student_key.as_deref(),
            |connection, user| {
                let (from, to) = (inna_date(&range.date_from), inna_date(&range.date_to));
                let mut entries = connection.read(
                    "/api/Timetable/GetTimetable",
                    &[
                        ("staff_id", ""),
                        ("student_id", user.text("studentId")),
                        ("moduleId", ""),
                        ("classroom_id", ""),
                        ("class_id", ""),
                        ("groupId", ""),
                        ("terms", ""),
                        ("date_from", &from),
                        ("date_to", &to),
                        ("attendanceOverview", ""),
                    ],
                    &shapes::TIMETABLE,
                )?;

                for entry in items(&mut entries) {
                    date(entry, &["start", "end"]);
                }
                Ok(vec![("entries", entries)])
            },
        )
    }

    pub fn assignments(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        kind: &str,
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let types: &[&str] = match kind {
                "all" => &["0", "1"],
                "exams" => &["1"],
                _ => &["0"],
            };
            let mut entries = Vec::new();

            for value in types {
                let page = connection.read(
                    "/api/GetAssignments/GetStudentAssignments",
                    &[("type", value), ("control", "0"), ("order", "0")],
                    &shapes::ASSIGNMENTS,
                )?;

                if let Value::Array(page) = page {
                    entries.extend(page);
                }
            }
            let mut homework = connection.read(
                "/api/Homework/GetStudentHomework",
                &[
                    ("groupId", ""),
                    ("type", "1"),
                    ("control", "0"),
                    ("order", "0"),
                ],
                &shapes::HOMEWORK,
            )?;

            for item in items(&mut homework) {
                plain(item, "text");
                date(item, &["date"]);
            }

            for entry in &mut entries {
                date(entry, &["assignedFullDate", "handInFullDate"]);
            }
            Ok(vec![
                ("entries", Value::Array(entries)),
                ("homework", homework),
            ])
        })
    }

    pub fn assignment(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        id: &str,
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let mut assignment = connection.read(
                "/api/GetAssignments/GetAssignmentInfo",
                &[("assignmentId", id)],
                &shapes::ASSIGNMENT,
            )?;
            plain(&mut assignment, "description");
            date(&mut assignment, &["returnDate"]);
            Ok(vec![("assignment", assignment)])
        })
    }

    pub fn grades(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        term: Option<&str>,
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, user| {
            let term = term.unwrap_or(user.text("defaultTermId"));
            let mut entries = connection.read(
                "/api/StudentGrades/GetStudentGrades",
                &[("termId", term)],
                &shapes::GRADES,
            )?;

            for entry in items(&mut entries) {
                date(entry, &["dateFinished"]);
            }
            Ok(vec![("entries", entries)])
        })
    }

    pub fn course_grades(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        group: &str,
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let mut grades = connection.read(
                &format!("/api/GetAssignments/Groups/{group}/StudentProjects"),
                &[],
                &shapes::COURSE_GRADES,
            )?;
            let mut assignments = grades
                .get_mut("assignments")
                .map(Value::take)
                .unwrap_or_default();

            for entry in items(&mut assignments) {
                date(entry, &["assignDate", "returnDate"]);
            }
            Ok(vec![("assignments", assignments)])
        })
    }

    pub fn attendance(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        term: Option<&str>,
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let mut attendance = connection.read(
                "/api/Attendance/GetAttendance",
                &[("termId", term.unwrap_or_default()), ("type", "0")],
                &shapes::ATTENDANCE,
            )?;
            date(&mut attendance, &["dateFrom", "dateTo"]);
            Ok(vec![("attendance", attendance)])
        })
    }

    pub fn materials(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        group: &str,
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let mut groups = connection.read(
                "/api/Attachment/GetModuleFiles",
                &[("groupId", group), ("isStudent", "1")],
                &shapes::MATERIALS,
            )?;

            for group in items(&mut groups) {
                for file in group.get_mut("files").map(items).unwrap_or_default() {
                    date(file, &["dateOpened"]);
                    plain(file, "description");
                }
            }
            Ok(vec![("groups", groups)])
        })
    }

    pub fn messages(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        (row_from, row_to): (f64, Option<f64>),
        key: Option<&str>,
    ) -> Result<Value> {
        let row_to = row_to.unwrap_or(row_from + 20.0);
        let safe = |number: f64| number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0;

        // The client's own bounds: `rowTo` within 100 rows after `rowFrom`.
        if !safe(row_from)
            || row_from < 1.0
            || !safe(row_to)
            || row_to < row_from
            || row_to > row_from + 100.0
        {
            return Err(Fail::Invalid);
        }
        self.with_user(signal, cancel, key, |connection, _| {
            let (from, to) = ((row_from as i64).to_string(), (row_to as i64).to_string());
            let mut page = connection.read(
                "/api/Messages/GetReceivedMessages",
                &[
                    ("dateFrom", ""),
                    ("dateTo", ""),
                    ("rowFrom", &from),
                    ("rowTo", &to),
                ],
                &shapes::MESSAGES,
            )?;
            let count = page["count"].as_f64().unwrap_or_default();
            let mut messages = page
                .get_mut("messages")
                .map(Value::take)
                .unwrap_or_default();
            let delivered = items(&mut messages).len() as f64;
            let next = row_from + delivered;

            if delivered == 0.0 && row_from <= count {
                return Err(Fail::Safe(
                    "Inna returned an incomplete message page. Do not treat it as an empty inbox.",
                ));
            }
            let mut keys: Vec<String> = items(&mut messages)
                .iter()
                .map(|message| {
                    let text = |key: &str| message[key].as_str().unwrap_or_default().to_owned();
                    format!("{}:{}", text("table"), text("messagesId"))
                })
                .collect();
            keys.sort();
            keys.dedup();

            if keys.len() as f64 != delivered
                || delivered > row_to - row_from + 1.0
                || (delivered > 0.0 && next - 1.0 > count)
            {
                return Err(Fail::Safe(
                    "Inna returned inconsistent message paging. The result was discarded.",
                ));
            }

            for message in items(&mut messages) {
                date(message, &["date", "dateOpened"]);
            }
            let next_row = match next <= count {
                true => js::number(next),
                false => Value::Null,
            };
            Ok(vec![
                ("count", page["count"].take()),
                ("messages", messages),
                ("rowFrom", js::number(row_from)),
                ("rowTo", js::number(row_to)),
                ("nextRowFrom", next_row),
            ])
        })
    }

    pub fn message(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        (id, kind): (&str, &str),
        key: Option<&str>,
    ) -> Result<Value> {
        self.with_user(signal, cancel, key, |connection, _| {
            let mut message = connection.read(
                "/api/Messages/GetMessageDetails",
                &[("messageId", id), ("type", kind)],
                &shapes::MESSAGE,
            )?;
            plain(&mut message, "message");
            date(&mut message, &["dateCreated", "dateSent"]);
            Ok(vec![("message", message)])
        })
    }

    pub fn absences(&self, signal: &Signal, cancel: &Cancel, range: &Range) -> Result<Value> {
        self.with_user(
            signal,
            cancel,
            range.student_key.as_deref(),
            |connection, _| {
                let (from, to) = (inna_date(&range.date_from), inna_date(&range.date_to));
                let sick_options = connection.read(
                    "/api/RegisterAbsence/GetRegisterAbsences",
                    &[],
                    &shapes::SICK_OPTIONS,
                )?;
                let mut sick = connection.read(
                    "/api/RegisterAbsence/GetStudentRegisteredAbsences",
                    &[("dateFrom", &from), ("dateTo", &to)],
                    &shapes::SICKNESS,
                )?;
                let mut leave = connection.read(
                    "/api/RegisterAbsence/GetLeaves",
                    &[("getDateFrom", &from), ("getDateTo", &to)],
                    &shapes::LEAVES,
                )?;

                for record in items(&mut sick) {
                    date(record, &["date"]);
                }

                for record in items(&mut leave) {
                    date(record, &["dateFrom", "dateTo", "created"]);
                }

                for record in items(&mut sick).iter_mut().chain(items(&mut leave)) {
                    for lesson in record.get_mut("classes").map(items).unwrap_or_default() {
                        date(lesson, &["date"]);
                    }
                }
                Ok(vec![
                    ("sickOptions", sick_options),
                    ("sick", sick),
                    ("leave", leave),
                ])
            },
        )
    }

    /// `absenceStatus`: reads the current context without switching, so an uncertain operation
    /// stays reviewable.
    pub fn absence_status(&self, signal: &Signal, cancel: &Cancel) -> Result<Value> {
        self.session(signal, cancel, |connection, saved| {
            let user = connection.user()?;
            let record = absence::read(&self.path)?;

            if let Some(record) = &record
                && saved.account != record.account
                && !saved
                    .students
                    .iter()
                    .any(|(_, student)| student.binding == record.account)
            {
                return Err(Fail::Safe(
                    "The saved absence operation belongs to another account, student, or school.",
                ));
            }
            let mut output = Map::new();
            output.insert("context".to_owned(), user.context());
            output.insert(
                "operation".to_owned(),
                record.map_or(Value::Null, |record| record.to_json()),
            );
            stamp(&mut output)?;
            Ok(Value::Object(output))
        })
    }

    /// `prepareAbsence`: checks the request against Inna for the chosen student and saves it as
    /// the one preview `submit_absence` may send, for ten minutes. Sends nothing.
    pub fn prepare_absence(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        mut request: absence::Request,
    ) -> Result<Value> {
        if !self.allow_absence_writes {
            return Err(WRITES_NOT_ALLOWED);
        }
        let key = request.student_key.take();

        self.with_student(signal, cancel, || Ok(key), false, |connection, target| {
            let user = &target.user;
            let previous = absence::read(&self.path)?;

            if previous.is_some_and(|previous| {
                matches!(previous.state, State::Submitting | State::Unknown)
            }) {
                return Err(Fail::Safe(
                    "An earlier absence submission is uncertain. Review its status and Inna history; do not retry it.",
                ));
            }
            check_absence(connection, user, &request)?;
            let record = Record {
                operation_id: js::uuid().ok_or(Fail::Unknown)?,
                account: user.binding(),
                student_key: target.key.clone(),
                request,
                state: State::Prepared,
                expires_at: js::client_now() + PREVIEW_LIFETIME,
                upstream_id: None,
            };
            absence::write(&self.path, &record)?;
            let mut output = record_fields(&record);
            output.insert("studentName".to_owned(), json!(user.text("studentName")));
            output.insert("schoolName".to_owned(), json!(user.text("schoolLong")));
            Ok(output)
        })
    }

    /// `submitAbsence`: sends the saved preview `operation_id` once, to the student it was
    /// prepared for, after checking context, permission, overlaps, expiry and the UTC day again.
    /// The record is marked submitting before the write and unknown when its outcome is not
    /// known, and neither is ever sent again.
    pub fn submit_absence(
        &self,
        signal: &Signal,
        cancel: &Cancel,
        operation_id: &str,
    ) -> Result<Value> {
        if !self.allow_absence_writes {
            return Err(WRITES_NOT_ALLOWED);
        }
        let saved = |user: Option<&User>| -> Result<Record> {
            absence::read(&self.path)?
                .filter(|record| record.operation_id == operation_id)
                .filter(|record| user.is_none_or(|user| record.account == user.binding()))
                .ok_or(NO_PREVIEW)
        };
        // The preview decides the student: Inna is switched to it before any check.
        let pick = || Ok(saved(None)?.student_key);

        self.with_student(signal, cancel, pick, false, |connection, target| {
            let user = &target.user;
            let mut record = saved(Some(user))?;

            match record.state {
                State::Submitted => return Ok(record_fields(&record)),
                State::Prepared => {}
                State::Submitting | State::Unknown => {
                    return Err(Fail::Safe(
                        "Submission outcome is uncertain. Review Inna history; this request will not be replayed.",
                    ));
                }
            }

            if record.expires_at <= js::client_now() {
                return Err(PREVIEW_EXPIRED);
            }
            let checked_day = check_absence(connection, user, &record.request)?;
            let current = connection.user()?;

            if record.account != current.binding()
                || !still_selected(target, &current)
                || !can_register_absence(&current, record.request.kind)
            {
                return Err(Fail::Safe(
                    "Inna context or permissions changed during absence checks. Review the intended account before preparing another request.",
                ));
            }

            if utc_day(js::client_now())? != checked_day {
                return Err(Fail::Safe(
                    "The UTC day changed during absence checks. Prepare and approve a fresh preview.",
                ));
            }

            if record.expires_at <= js::client_now() {
                return Err(PREVIEW_EXPIRED);
            }
            record.state = State::Submitting;
            absence::write(&self.path, &record)?;
            // ponytail: whole days only; partial days need per-lesson writes and
            // partial-success recovery.
            let request = &record.request;
            let body = json!({
                "firstDay": inna_date(&request.date_from),
                "lastDay": inna_date(&request.date_to),
                "leaveStatus": 0,
                "leaveType": if request.kind == "sick" { 1 } else { 3 },
                "allDay": 1,
                "comment": request.reason,
            });
            let mut send = || -> Result<()> {
                let response = connection.request(
                    "/api/RegisterAbsence/AddNewLeave",
                    &[],
                    Some(body.to_string()),
                )?;
                let id = response.get("id").and_then(positive).ok_or(Fail::Invalid)?;
                record.state = State::Submitted;
                record.upstream_id = Some(id);
                absence::write(&self.path, &record)
            };

            match send() {
                Ok(()) => Ok(record_fields(&record)),
                // Any failure, the final save included, leaves the outcome unknown.
                Err(_) => {
                    record.state = State::Unknown;
                    absence::write(&self.path, &record)?;
                    Err(Fail::Safe(
                        "Absence submission outcome is uncertain. Do not retry; review the saved operation and Inna history.",
                    ))
                }
            }
        })
    }
}

/// A record's fields, for a tool's output.
fn record_fields(record: &Record) -> Map<String, Value> {
    match record.to_json() {
        Value::Object(fields) => fields,
        _ => unreachable!("a record is an object"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(value: Value) -> User {
        let mut base = json!({
            "userId": 1, "studentId": "2", "schoolId": "3", "studentName": "s", "name": "n",
            "schoolLong": "l", "defaultTermId": "4", "isGuardian": true, "logInType": "2",
            "olderThan18": false, "registerAbsenceGuardian": "1", "registerAbsenceUnder18": "0",
            "registerAbsenceOver18": "1", "registerAbsence": "1", "student18RegisterAbsence": "1",
            "registerLeave": "1", "student18RegisterLeave": "1", "registerIllnessTomorrow": "1",
        });
        base.as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        User::parse(&base).unwrap()
    }

    #[test]
    fn access_entries_are_read_without_guessing() {
        let entries = |access: Value| student_entries(&user(json!({ "access": access })));
        let found = entries(json!([
            {"system": "2", "userId": "x"},
            {"system": 1, "status": 2, "userId": 5, "loggedIn": 1, "skoli_id": "x", "nafn": 3, "title": "t"},
            {"system": "1", "status": "1", "userId": "1", "loggedIn": "0", "skoli_id": 3},
        ]))
        .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(
            (
                found[0].index,
                found[0].user_id.as_str(),
                found[0].logged_in
            ),
            (1, "5", true)
        );
        assert_eq!(
            (found[0].school_id.as_deref(), found[0].name.as_deref()),
            (None, None)
        );
        assert_eq!(found[1].school_id.as_deref(), Some("3"));
        assert_eq!(selected_key(Some(&found)), Some("5"));

        for access in [
            json!({}),
            json!([null]),
            json!([{"system": "x"}]),
            json!([{"system": "1", "status": "1", "userId": "1", "loggedIn": 2}]),
            json!([
                {"system": "1", "status": "1", "userId": "1", "loggedIn": true},
                {"system": "1", "status": "1", "userId": 1, "loggedIn": false},
            ]),
        ] {
            assert!(entries(access.clone()).is_none(), "{access}");
        }
        assert!(student_entries(&user(json!({}))).is_none());
    }

    #[test]
    fn the_selected_entry_must_match_the_context() {
        let access = |selected: &str, school: Value| {
            json!({ "access": [
                {"system": "1", "status": "1", "userId": "1", "loggedIn": selected == "1", "skoli_id": school},
                {"system": "1", "status": "2", "userId": "5", "loggedIn": selected == "5", "skoli_id": "8"},
            ]})
        };
        assert!(matches_entry(&user(access("1", json!("3"))), "1"));
        assert!(!matches_entry(&user(access("1", json!("9"))), "1"));
        assert!(!matches_entry(&user(access("1", json!(null))), "1"));
        assert!(!matches_entry(&user(access("5", json!("3"))), "1"));
        assert!(!matches_entry(&user(access("1", json!("3"))), "5"));
    }

    #[test]
    fn learned_students_keep_their_first_binding() {
        let mut saved = Saved {
            jar: String::new(),
            account: user(json!({})).binding(),
            students: Vec::new(),
            pause_until: 0.0,
        };
        let sibling = user(json!({"userId": 5, "studentId": "6", "schoolId": "8"}));
        assert_eq!(learn(&mut saved, "5", &sibling).unwrap(), sibling.binding());
        assert_eq!(learn(&mut saved, "1", &user(json!({}))).unwrap().user_id, 1);
        assert_eq!(saved.students.len(), 2);
        let moved = user(json!({"userId": 5, "studentId": "7", "schoolId": "8"}));
        assert_eq!(learn(&mut saved, "5", &moved), Err(CONTEXT_CHANGED));
        // Another key may not take a student already saved.
        let copy = user(json!({"userId": 9, "studentId": "6", "schoolId": "8"}));
        assert!(
            matches!(learn(&mut saved, "9", &copy), Err(Fail::Safe(text)) if text.contains("already saved"))
        );
        assert_eq!(
            learn(
                &mut saved,
                "1",
                &user(json!({"userId": 1, "studentId": "2", "schoolId": "9"}))
            ),
            Err(CONTEXT_CHANGED)
        );
    }

    #[test]
    fn inna_dates_are_day_first() {
        assert_eq!(inna_date("2040-01-02"), "02.01.2040");
    }
}
