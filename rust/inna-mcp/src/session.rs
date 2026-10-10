//! The saved session of packages/inna-mcp/src/client.ts: its schema (`savedSchema`), where it is
//! kept (the encrypted store, or before migration the plaintext legacy file), and the hold every
//! operation takes on both (`locked`). Everything here blocks; callers run it on blocking threads.

use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use family_store::{
    Cancel, Code as StoreCode, DEFAULT_SWEEP_AGE, DEFAULT_WAIT, Error as StoreError, LockOptions,
    SecretRecordOptions, SecretStore, default_session_path, read_private_bytes, sweep_temp,
    with_file_lock, with_secret_store, write_private_file,
};
use serde_json::{Map, Value, json};

use crate::error::{Fail, Result};
use crate::js;
use crate::shapes::is_id;
use crate::store::{APP, MAX_NAME_LENGTH, MAX_SESSION_BYTES, MAX_STUDENTS, session_record};

/// The three nam.inna.is cookies a saved session holds; no other cookie is kept.
pub const COOKIE_NAMES: [&str; 3] = ["SESSION", "JSESSIONID", "XSRF-TOKEN"];

pub const STORAGE: &str = "Saved in an encrypted file.";

const PLAINTEXT: &str = "Saved in a plaintext file. Run inna-mcp auth migrate.";

pub const TOO_MANY_STUDENTS: Fail = Fail::Safe(
    "This Inna session holds more saved students than this version keeps. Run inna-mcp auth logout, then sign in again.",
);

pub const UNCERTAIN: Fail = Fail::Safe(
    "The last write to the Inna session store did not complete, so its session is not used. Remove session.enc and session.enc.marker from the Inna store folder (~/Library/Application Support/family-mcp/inna-mcp on macOS, ~/.config/inna-mcp on Linux by default), then run inna-mcp auth login again.",
);

const INVALID_RECORD: Fail =
    Fail::Safe("Invalid Inna session store record. Run inna-mcp auth login or auth import again.");

const UNREADABLE: Fail =
    Fail::Safe("Cannot read the Inna session. Check its format and owner-only permissions.");

/// `bindingSchema`: the account, student and school a session or student key is bound to.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub user_id: i64,
    pub student_id: String,
    pub school_id: String,
}

/// `z.number().int().positive()`, as a safe integer.
pub fn positive(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number > 0.0 && number <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

impl Binding {
    pub fn parse(value: &Value) -> Option<Self> {
        let id = |key: &str| {
            value
                .get(key)?
                .as_str()
                .filter(|text| is_id(text))
                .map(str::to_owned)
        };
        value.as_object()?;
        Some(Self {
            user_id: positive(value.get("userId")?)?,
            student_id: id("studentId")?,
            school_id: id("schoolId")?,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({ "userId": self.user_id, "studentId": self.student_id, "schoolId": self.school_id })
    }
}

/// `learnedStudentSchema`: a student key's binding and the name Inna reported for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Learned {
    pub binding: Binding,
    pub student_name: String,
}

impl Learned {
    /// The saved form: the name cut to MAX_NAME_LENGTH UTF-16 units.
    fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            binding: Binding::parse(value)?,
            student_name: js::slice_units(value.get("studentName")?.as_str()?, MAX_NAME_LENGTH)
                .to_owned(),
        })
    }

    fn to_json(&self, saved: bool) -> Value {
        let name = match saved {
            true => js::slice_units(&self.student_name, MAX_NAME_LENGTH),
            false => &self.student_name,
        };
        let mut value = self.binding.to_json();
        value["studentName"] = json!(name);
        value
    }
}

/// `Saved`: version 1 files hold one binding and are read as version 2 without learned students.
#[derive(Debug, Clone)]
pub struct Saved {
    /// The tough-cookie jar, serialized.
    pub jar: String,
    pub account: Binding,
    /// By student key, in the order they were learned (written in JavaScript key order).
    pub students: Vec<(String, Learned)>,
    pub pause_until: f64,
}

impl Saved {
    /// `savedSchema.parse`.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let version = object.get("version")?.as_f64()?;
        (version == 1.0 || version == 2.0).then_some(())?;
        let jar = object.get("jar")?.as_str()?;
        (js::length(jar) <= MAX_SESSION_BYTES).then_some(())?;
        let students = match object.get("students") {
            None => Vec::new(),
            Some(Value::Object(students)) => students
                .iter()
                .map(|(key, value)| {
                    is_id(key)
                        .then(|| Learned::parse(value))
                        .flatten()
                        .map(|learned| (key.clone(), learned))
                })
                .collect::<Option<_>>()?,
            Some(_) => return None,
        };
        let pause_until = match object.get("pauseUntil") {
            None => 0.0,
            Some(value) => value.as_f64()?,
        };
        Some(Self {
            jar: jar.to_owned(),
            account: Binding::parse(object.get("account")?)?,
            students,
            pause_until,
        })
    }

    /// The session as JSON. `saved` is `savedSchema.parse`'s output, as the store keeps it;
    /// otherwise the object as the client holds it, as the legacy file keeps it.
    pub fn to_json(&self, saved: bool) -> Value {
        let students: Map<String, Value> = self
            .students
            .iter()
            .map(|(key, learned)| (key.clone(), learned.to_json(saved)))
            .collect();
        json!({
            "version": 2,
            "jar": self.jar,
            "account": self.account.to_json(),
            "students": js::order(students),
            "pauseUntil": js::number(self.pause_until),
        })
    }

    pub fn student(&self, key: &str) -> Option<&Learned> {
        self.students
            .iter()
            .find_map(|(saved, learned)| (saved == key).then_some(learned))
    }

    /// `bounded`: the student bound keeps RECORD_MAX_BYTES finite.
    fn bounded(self) -> Result<Self> {
        match self.students.len() > MAX_STUDENTS {
            true => Err(TOO_MANY_STUDENTS),
            false => Ok(self),
        }
    }
}

/// `encode`: the store record's plaintext, the saved session or `null` after logout.
pub fn encode(saved: Option<&Saved>) -> Result<String> {
    let Some(saved) = saved else {
        return Ok("null".to_owned());
    };

    // `savedSchema.parse` refuses a jar over the bound with a ZodError.
    if js::length(&saved.jar) > MAX_SESSION_BYTES {
        return Err(Fail::Invalid);
    }

    if saved.students.len() > MAX_STUDENTS {
        return Err(TOO_MANY_STUDENTS);
    }
    Ok(saved.to_json(true).to_string())
}

/// `credentials`: the saved credentials by cookie values alone, so rewritten access times do not
/// change it.
pub fn credentials(saved: &Saved) -> Result<String> {
    let jar = js::parse(saved.jar.as_bytes()).ok_or(Fail::Unknown)?;
    let cookies = jar
        .as_object()
        .and_then(|jar| jar.get("cookies"))
        .and_then(Value::as_array)
        .ok_or(Fail::Invalid)?;
    let mut pairs = Vec::new();

    for cookie in cookies {
        let key = cookie.get("key").and_then(Value::as_str);
        let value = match cookie.get("value") {
            None => Some(""),
            Some(value) => value.as_str(),
        };
        let (Some(key), Some(value), true) = (key, value, cookie.is_object()) else {
            return Err(Fail::Invalid);
        };

        if COOKIE_NAMES.contains(&key) {
            pairs.push(format!("{key}={value}"));
        }
    }
    pairs.sort_by(|a, b| js::compare(a, b));
    Ok(js::sha256_hex(&pairs.join("\n")))
}

/// `storeError`: fixed messages; a store failure never shows a path, key or cookie, and never
/// falls back.
pub fn store_error(error: &StoreError) -> Fail {
    match error.code {
        StoreCode::StoreUnavailable => Fail::Safe(
            "The Inna store key is missing. Run inna-mcp auth login or auth import to sign in again.",
        ),
        StoreCode::StoreBackendRetired => Fail::Safe(
            "The Inna session store is a leftover of an earlier test build that kept its key in the macOS Keychain. Remove session.enc and session.enc.marker from ~/Library/Application Support/family-mcp/inna-mcp, then run inna-mcp auth login again.",
        ),
        StoreCode::StoreWriteUncertain => UNCERTAIN,
        StoreCode::UnsafeFile => Fail::Safe(
            "Cannot use the Inna session store. Run inna-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first.",
        ),
        StoreCode::StoreError => Fail::Safe(
            "Cannot use the Inna session store. Its files or key are damaged, unsafe, or not readable.",
        ),
        // TypeScript throws a RangeError here, which is not a store error.
        StoreCode::InvalidArgument => Fail::Unknown,
        _ => Fail::Safe(
            "Cannot access the private Inna files. Check permissions or wait for another operation.",
        ),
    }
}

/// A failure inside the hold: a store error takes its fixed message.
struct Failed(Fail);

impl From<StoreError> for Failed {
    fn from(error: StoreError) -> Self {
        Failed(store_error(&error))
    }
}

impl From<Fail> for Failed {
    fn from(fail: Fail) -> Self {
        Failed(fail)
    }
}

/// `sessionPath`: INNA_SESSION_FILE, or the default legacy path.
pub fn session_path() -> Result<PathBuf> {
    let path = match std::env::var_os("INNA_SESSION_FILE") {
        Some(path) => PathBuf::from(path),
        // A SessionStoreError outside `locked`, which the boundaries hide.
        None => default_session_path(APP, None).map_err(|_| Fail::Unknown)?,
    };

    match path.is_absolute() {
        true => Ok(path),
        false => Err(Fail::Safe("INNA_SESSION_FILE must be an absolute path.")),
    }
}

/// `<legacy>.absence.json`: the private absence record beside the legacy file.
pub fn absence_path(legacy: &Path) -> PathBuf {
    let mut path = OsString::from(legacy.as_os_str());
    path.push(".absence.json");
    PathBuf::from(path)
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Fail::Safe(
            "Cannot inspect the private Inna files. Check their permissions.",
        )),
    }
}

/// Node's `path.resolve` of an absolute path: `.` and `..` resolved lexically.
fn resolve(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::from("/");

    for component in path.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    resolved
}

/// Resolve symbolic links in the longest existing prefix, so aliases compare equal.
fn canonical(path: &Path) -> Result<PathBuf> {
    let mut existing = resolve(path);
    let mut rest = Vec::new();

    loop {
        match fs::canonicalize(&existing) {
            Ok(real) => return Ok(rest.iter().rev().fold(real, |path, name| path.join(name))),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
                    break;
                };
                rest.push(name.to_owned());
                existing = parent.to_owned();
            }
            Err(_) => break,
        }
    }
    Err(Fail::Safe(
        "Cannot resolve the Inna session paths. Check their permissions.",
    ))
}

/// Node's `dirname`: the root is its own.
fn dirname(path: &Path) -> &Path {
    path.parent().unwrap_or(path)
}

/// Same file, or one name is the other's `<name>.` namespace (lock, marker, temporaries) beside it.
fn overlaps(first: &Path, second: &Path) -> bool {
    let name = |path: &Path| {
        path.file_name()
            .map(|name| name.as_encoded_bytes().to_vec())
            .unwrap_or_default()
    };
    let (a, b) = (name(first), name(second));
    let namespace =
        |name: &[u8], of: &[u8]| name.starts_with(of) && name.get(of.len()) == Some(&b'.');
    dirname(first) == dirname(second) && (a == b || namespace(&a, &b) || namespace(&b, &a))
}

/// `lineage`: the path and every directory above it, short of the root.
fn lineage(path: &Path) -> impl Iterator<Item = &Path> {
    path.ancestors().filter(|up| up.parent().is_some())
}

fn collides(file: &Path, owned: &Path) -> bool {
    lineage(file).any(|up| overlaps(up, owned)) || lineage(owned).any(|up| overlaps(file, up))
}

/// `rejectCollisions`: the legacy file is locked, swept and removed, and the store can be reset, so
/// neither the legacy file nor its absence record may hold, or sit inside a directory of, the
/// record or the key file, or the reverse. Checked before anything is touched.
fn reject_collisions(record: &SecretRecordOptions, legacy: &Path) -> Result<()> {
    let files = [canonical(legacy)?, canonical(&absence_path(legacy))?];
    let mut owned = vec![canonical(&record.path)?];

    if let Some(key) = record.keys.key_file() {
        owned.push(canonical(key)?);
    }

    if files
        .iter()
        .any(|file| owned.iter().any(|path| collides(file, path)))
    {
        return Err(Fail::Safe(
            "INNA_SESSION_FILE overlaps the encrypted Inna session store or its key. Choose another path.",
        ));
    }
    Ok(())
}

/// `Held`: one hold of the legacy lock and the store lock, where the session is, and how to save
/// it there.
pub struct Held<'h, 'o> {
    pub store: &'h mut SecretStore<'o>,
    pub record: &'h SecretRecordOptions,
    /// A marker, or even a lone record, means the store decides; the legacy file is never read.
    pub decides: bool,
    pub legacy: &'h Path,
    cancel: &'h Cancel,
}

impl Held<'_, '_> {
    pub fn storage(&self) -> &'static str {
        match self.decides {
            true => STORAGE,
            false => PLAINTEXT,
        }
    }

    /// `stored`: the committed record, `Some(None)` after logout, or `None` while the store holds
    /// none.
    pub fn stored(&mut self) -> Result<Option<Option<Saved>>> {
        let Some(text) = self.store.read().map_err(|error| store_error(&error))? else {
            return Ok(None);
        };
        let saved = match js::parse(text.as_bytes()).ok_or(INVALID_RECORD)? {
            Value::Null => None,
            value => Some(Saved::parse(&value).ok_or(INVALID_RECORD)?),
        };
        Ok(Some(saved.map(Saved::bounded).transpose()?))
    }

    /// `read`: the saved session, wherever it is; `None` without one.
    pub fn read(&mut self) -> Result<Option<Saved>> {
        match self.decides {
            true => Ok(self.stored()?.flatten()),
            false => read_saved(self.legacy),
        }
    }

    /// `write`: save the session where it was read from.
    pub fn write(&mut self, saved: &Saved) -> Result<()> {
        match self.decides {
            true => {
                let text = encode(Some(saved))?;
                self.store.write(&text).map_err(|error| store_error(&error))
            }
            false => write_private_file(
                self.legacy,
                saved.to_json(false).to_string().as_bytes(),
                self.cancel,
            )
            .map_err(|error| store_error(&error)),
        }
    }

    /// `writeBack`: always write back the jar and any rate-limit pause. A failed write keeps the
    /// record when the cookies are unchanged; rotated cookies must never be offered again, so the
    /// record goes, which reads as STORE_WRITE_UNCERTAIN until the next sign-in.
    pub fn write_back(&mut self, saved: &Saved, before: &str) -> Result<()> {
        let Err(fail) = self.write(saved) else {
            return Ok(());
        };

        if !self.decides || credentials(saved)? == before {
            return Err(fail);
        }
        let _ = fs::remove_file(&self.record.path);
        Err(UNCERTAIN)
    }
}

/// `keyLost`: true when the store's key is missing; any other key failure, a retired store
/// first, is an error.
pub fn key_lost(store: &SecretStore) -> Result<bool> {
    match store.check_key() {
        Ok(()) => Ok(false),
        Err(error) if error.code == StoreCode::StoreUnavailable => Ok(true),
        Err(error) => Err(store_error(&error)),
    }
}

/// `removeLegacy`: the legacy session file is a credential; remove it and its orphaned
/// temporaries, never the absence record. True when it was there.
pub fn remove_legacy(path: &Path) -> Result<bool> {
    let failed = Fail::Safe(
        "Cannot remove the old plaintext Inna session file. Any encrypted-store change already completed; remove that file by hand.",
    );
    let found = exists(path).map_err(|_| failed)?;

    match fs::remove_file(path) {
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(failed),
        _ => {}
    }
    sweep_temp(path, DEFAULT_SWEEP_AGE).map_err(|_| failed)?;
    Ok(found)
}

/// `readSaved`: the legacy plaintext file, or `None` when there is none.
pub fn read_saved(path: &Path) -> Result<Option<Saved>> {
    let bytes = match read_private_bytes(path, MAX_SESSION_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.code == StoreCode::NotFound => return Ok(None),
        Err(_) => return Err(UNREADABLE),
    };
    let saved = js::parse(&bytes)
        .as_ref()
        .and_then(Saved::parse)
        .ok_or(UNREADABLE)?;
    saved.bounded().map(Some)
}

/// `locked`: every operation holds the legacy file's lock, which also guards the absence record,
/// and the store's lock inside it: always in that order, and never taken again within the hold.
pub fn locked<T>(
    legacy: &Path,
    cancel: &Cancel,
    work: impl FnOnce(&mut Held) -> Result<T>,
) -> Result<T> {
    let mut record = session_record(None).map_err(|error| store_error(&error))?;
    record.cancel = cancel.clone();
    reject_collisions(&record, legacy)?;
    let options = LockOptions {
        cancel: cancel.clone(),
        wait: DEFAULT_WAIT,
    };

    with_file_lock(legacy, &options, || -> std::result::Result<T, Failed> {
        sweep_temp(legacy, DEFAULT_SWEEP_AGE)?;
        sweep_temp(&absence_path(legacy), DEFAULT_SWEEP_AGE)?;

        with_secret_store(&record, |store| -> std::result::Result<T, Failed> {
            let decides = store.exists()? || exists(&record.path)?;
            let mut held = Held {
                store,
                record: &record,
                decides,
                legacy,
                cancel,
            };
            Ok(work(&mut held)?)
        })
    })
    .map_err(|Failed(fail)| fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_sessions_parse_and_write_as_the_typescript_schema() {
        let text = r#"{"x":1,"pauseUntil":5.5,"students":{"9":{"studentName":"n","schoolId":"3","studentId":"2","userId":9,"z":0},"10":{"userId":10,"studentId":"4","schoolId":"3","studentName":"m"}},"account":{"schoolId":"3","studentId":"2","userId":1},"jar":"{}","version":1}"#;
        let saved = Saved::parse(&js::parse(text.as_bytes()).unwrap()).unwrap();
        assert_eq!(
            encode(Some(&saved)).unwrap(),
            r#"{"version":2,"jar":"{}","account":{"userId":1,"studentId":"2","schoolId":"3"},"students":{"9":{"userId":9,"studentId":"2","schoolId":"3","studentName":"n"},"10":{"userId":10,"studentId":"4","schoolId":"3","studentName":"m"}},"pauseUntil":5.5}"#
        );
        let bare =
            r#"{"version":2,"jar":"","account":{"userId":1,"studentId":"2","schoolId":"3"}}"#;
        let saved = Saved::parse(&js::parse(bare.as_bytes()).unwrap()).unwrap();
        assert_eq!(
            saved.to_json(false).to_string(),
            r#"{"version":2,"jar":"","account":{"userId":1,"studentId":"2","schoolId":"3"},"students":{},"pauseUntil":0}"#
        );

        for invalid in [
            r#"{"version":3,"jar":"","account":{"userId":1,"studentId":"2","schoolId":"3"}}"#,
            r#"{"version":2,"jar":"","account":{"userId":0,"studentId":"2","schoolId":"3"}}"#,
            r#"{"version":2,"jar":"","account":{"userId":1,"studentId":"x","schoolId":"3"}}"#,
            r#"{"version":2,"jar":"","account":{"userId":1,"studentId":"2","schoolId":"3"},"students":[]}"#,
            r#"{"version":2,"jar":"","account":{"userId":1,"studentId":"2","schoolId":"3"},"students":{"a":{"userId":1,"studentId":"2","schoolId":"3","studentName":""}}}"#,
            r#"{"version":2,"jar":"","account":{"userId":1,"studentId":"2","schoolId":"3"},"pauseUntil":null}"#,
            r#"{"version":2,"jar":1,"account":{"userId":1,"studentId":"2","schoolId":"3"}}"#,
        ] {
            assert!(
                Saved::parse(&js::parse(invalid.as_bytes()).unwrap()).is_none(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn saved_names_are_cut_but_held_names_are_not() {
        let mut saved = Saved {
            jar: String::new(),
            account: Binding {
                user_id: 1,
                student_id: "2".to_owned(),
                school_id: "3".to_owned(),
            },
            students: Vec::new(),
            pause_until: 0.0,
        };
        let long = "é".repeat(MAX_NAME_LENGTH + 1);
        saved.students.push((
            "1".to_owned(),
            Learned {
                binding: saved.account.clone(),
                student_name: long.clone(),
            },
        ));
        assert!(saved.to_json(false).to_string().contains(&long));
        assert!(!encode(Some(&saved)).unwrap().contains(&long));
        assert!(
            encode(Some(&saved))
                .unwrap()
                .contains(&"é".repeat(MAX_NAME_LENGTH))
        );
        saved.jar = "x".repeat(MAX_SESSION_BYTES + 1);
        assert_eq!(encode(Some(&saved)), Err(Fail::Invalid));
        assert_eq!(encode(None).unwrap(), "null");
    }

    #[test]
    fn credentials_hash_the_session_cookie_values_only() {
        let saved = |jar: &str| Saved {
            jar: jar.to_owned(),
            account: Binding {
                user_id: 1,
                student_id: "2".to_owned(),
                school_id: "3".to_owned(),
            },
            students: Vec::new(),
            pause_until: 0.0,
        };
        // createHash('sha256').update('SESSION=a\nXSRF-TOKEN=').digest('hex').
        assert_eq!(
            credentials(&saved(
                r#"{"cookies":[{"key":"XSRF-TOKEN","lastAccessed":"x"},{"key":"SESSION","value":"a"},{"key":"other","value":"b"}]}"#
            ))
            .unwrap(),
            js::sha256_hex("SESSION=a\nXSRF-TOKEN=")
        );
        assert_eq!(
            credentials(&saved(r#"{"cookies":[{"value":"a"}]}"#)),
            Err(Fail::Invalid)
        );
        assert_eq!(credentials(&saved("{")), Err(Fail::Unknown));
    }

    /// The table of the TypeScript case 'store failures are fixed messages or a keep-alive status;
    /// only a login or import replaces a lost key', whose key provider throws each code: the
    /// binary reads only its key file, so the codes are checked here.
    #[test]
    fn store_failures_get_fixed_messages() {
        let message = |code| message_of(store_error(&StoreError::new(code, "Synthetic.")));
        for (code, start) in [
            (
                StoreCode::UnsafeFile,
                "Cannot use the Inna session store. Run inna-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first.",
            ),
            // A code no key file produces gets the general text.
            (
                StoreCode::StoreLocked,
                "Cannot access the private Inna files.",
            ),
            (
                StoreCode::StoreBackendRetired,
                "The Inna session store is a leftover of an earlier test build",
            ),
            (StoreCode::StoreError, "Cannot use the Inna session store."),
            (StoreCode::Io, "Cannot access the private Inna files."),
            (
                StoreCode::StoreUnavailable,
                "The Inna store key is missing. Run inna-mcp auth",
            ),
        ] {
            assert!(message(code).starts_with(start), "{code:?}");
        }
        assert_eq!(
            message(StoreCode::StoreWriteUncertain),
            message_of(UNCERTAIN)
        );
        assert_eq!(message(StoreCode::InvalidArgument), "unknown");
    }

    fn message_of(fail: Fail) -> &'static str {
        match fail {
            Fail::Safe(message) => message,
            Fail::Invalid | Fail::Unknown => "unknown",
        }
    }

    #[test]
    fn collisions_compare_namespaces_beside_and_above_each_other() {
        let path = Path::new;
        assert!(collides(
            path("/a/session.enc"),
            path("/a/session.enc.lock")
        ));
        assert!(collides(path("/a/session.enc/x"), path("/a/session.enc")));
        assert!(collides(path("/a/b"), path("/a/b/c/session.enc")));
        assert!(!collides(path("/a/session.json"), path("/a/session.enc")));
        assert!(!collides(path("/a/session.enc"), path("/b/session.enc")));
        // Unlike InfoMentor's, the root is never compared: lineage stops short of it.
        assert!(!collides(path("/.store"), path("/x/y")));
    }
}
