//! The encrypted store record `{version, session, credentials}` shared with the TypeScript CLI,
//! with packages/infomentor-mcp/src/store.ts's rules and messages. Everything here blocks; callers
//! run it on blocking threads.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use family_store::{
    Cancel, Code as StoreCode, DEFAULT_SWEEP_AGE, Error as StoreError, KeyProvider,
    SecretRecordOptions, SecretStore, default_key_provider, default_secret_record_path,
    retired_store_paths, startup_check, sweep_temp, with_secret_store,
};
use serde_json::{Map, Value, json};

use crate::error::{Code, Fail, LOGIN_REQUIRED, Result};
use crate::js;
use crate::session::{SavedSession, read_session, write_session};

const APP: &str = "infomentor-mcp";

/// A session file holds a cookie jar and identifiers; anything larger is not one.
pub const SESSION_MAX_BYTES: usize = 1_048_576;

pub const USERNAME_MAX: usize = 512;

pub const PASSWORD_MAX: usize = 4096;

/// Every storable record fits: a session is stored only when its JSON is at most
/// SESSION_MAX_BYTES (the old file's bound), and JSON writes a credential UTF-16 unit in at most 6
/// bytes (`\u0001`).
pub const RECORD_MAX_BYTES: usize =
    r#"{"version":1,"session":,"credentials":{"username":"","password":""}}"#.len()
        + SESSION_MAX_BYTES
        + 6 * (USERNAME_MAX + PASSWORD_MAX);

const PLAINTEXT: &str = "Saved in a plaintext file. Run infomentor-mcp auth migrate.";

const TOO_LARGE: Fail = Fail::new(
    Code::InvalidSession,
    "The InfoMentor session is larger than the store allows. Run infomentor-mcp login again.",
);

/// `Credentials`: a sign-in. Never printed.
#[derive(Clone, PartialEq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl Credentials {
    /// `credentialsSchema` (strict): both present, within their bounds, and nothing else.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let field = |name: &str, max: usize| {
            object
                .get(name)?
                .as_str()
                .filter(|text| (1..=max).contains(&js::length(text)))
                .map(str::to_owned)
        };
        (object.len() == 2).then_some(())?;
        Some(Self {
            username: field("username", USERNAME_MAX)?,
            password: field("password", PASSWORD_MAX)?,
        })
    }

    fn to_json(&self) -> Value {
        json!({ "username": self.username, "password": self.password })
    }
}

/// `StoredRecord`: the session in use (none after logout) and the sign-in that renews it.
#[derive(Clone)]
pub struct Record {
    pub session: Option<SavedSession>,
    pub credentials: Option<Credentials>,
}

/// `parseRecord`.
pub fn parse_record(text: &str) -> Option<Record> {
    let value = js::parse(text)?;
    let object = value.as_object()?;
    (object.get("version")?.as_f64()? == 1.0).then_some(())?;
    let session = match object.get("session")? {
        Value::Null => None,
        session => Some(SavedSession::parse(session)?),
    };
    let credentials = match object.get("credentials")? {
        Value::Null => None,
        credentials => Some(Credentials::parse(credentials)?),
    };
    Some(Record {
        session,
        credentials,
    })
}

/// `encodeRecord`: refuses a session larger than the old file's bound.
pub fn encode_record(record: &Record) -> Result<String> {
    let session = record.session.as_ref().map(SavedSession::to_json);

    if session
        .as_ref()
        .is_some_and(|session| session.to_string().len() > SESSION_MAX_BYTES)
    {
        return Err(TOO_LARGE);
    }
    let mut object = Map::new();
    object.insert("version".to_owned(), json!(1));
    object.insert("session".to_owned(), session.unwrap_or(Value::Null));
    object.insert(
        "credentials".to_owned(),
        record
            .credentials
            .as_ref()
            .map_or(Value::Null, Credentials::to_json),
    );
    Ok(Value::Object(object).to_string())
}

/// Fixed messages: a store failure never shows a path, key or secret, and never falls back.
pub fn store_error(error: &StoreError) -> Fail {
    let session = |message| Fail::new(Code::InvalidSession, message);
    let busy = |message| Fail::new(Code::OperationInProgress, message);

    match error.code {
        StoreCode::StoreUnavailable => session(
            "The InfoMentor store key is missing. Run infomentor-mcp login to sign in again.",
        ),
        StoreCode::StoreBackendRetired => session(
            "The InfoMentor session store is a leftover of an earlier test build that kept its key in the macOS Keychain. Remove session.enc and session.enc.marker from ~/Library/Application Support/family-mcp/infomentor-mcp, then run infomentor-mcp login again.",
        ),
        StoreCode::StoreWriteUncertain => session(
            "The last write to the InfoMentor session store did not complete, so its session is not used. Remove session.enc and session.enc.marker from the InfoMentor store folder (~/Library/Application Support/family-mcp/infomentor-mcp on macOS, ~/.config/infomentor-mcp on Linux by default), then run infomentor-mcp login again.",
        ),
        StoreCode::Busy => busy(
            "Another process is using the InfoMentor session store and did not finish within the wait limit. Retry after its operation finishes.",
        ),
        StoreCode::LockLost => busy(
            "Another process took over the InfoMentor session store lock during this operation. Retry it.",
        ),
        StoreCode::Cancelled => crate::error::CANCELLED,
        StoreCode::TooLarge => TOO_LARGE,
        StoreCode::UnsafeFile => Fail::config(
            "Cannot use the InfoMentor session store. Run infomentor-mcp status in a terminal; it shows what is wrong and where. Do not delete the store first.",
        ),
        // TypeScript throws a RangeError here, which is not a store error.
        StoreCode::InvalidArgument => Fail::Unknown,
        _ => session(
            "Cannot use the InfoMentor session store. Its files or key are damaged, unsafe, or not readable.",
        ),
    }
}

/// `guarded`: every store failure becomes its fixed message.
impl From<StoreError> for Fail {
    fn from(error: StoreError) -> Self {
        store_error(&error)
    }
}

/// `keys` is a test seam; the default is the store's key file.
fn session_record(
    keys: Option<Arc<dyn KeyProvider>>,
    cancel: Cancel,
) -> std::result::Result<SecretRecordOptions, StoreError> {
    let path = default_secret_record_path(APP)?;
    let keys = match keys {
        Some(keys) => keys,
        None => default_key_provider(APP, "default")?,
    };
    // A test never reaches the real store. The test build refuses to choose one unless the store
    // test seam points it at absolute XDG directories, as the packages' bunfig preload does, or
    // the production layout sits under a scratch HOME in the temporary directory.
    #[cfg(feature = "test-origin")]
    {
        let environment = family_store::StoreEnvironment::current();
        let absolute = |variable: &Option<std::ffi::OsString>| {
            variable
                .as_deref()
                .is_some_and(|value| std::path::Path::new(value).is_absolute())
        };
        let scratch = match environment.test_seam {
            true => absolute(&environment.xdg_config_home) && absolute(&environment.xdg_data_home),
            false => environment
                .home
                .is_some_and(|home| home.starts_with(std::env::temp_dir())),
        };
        assert!(
            scratch,
            "Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1 with scratch XDG directories, or a scratch HOME; the real store is never used."
        );
    }
    let mut record =
        SecretRecordOptions::new(path, APP, "default", "session", 1, keys, RECORD_MAX_BYTES);
    record.cancel = cancel;
    record.retired = retired_store_paths(APP, "default")?;
    Ok(record)
}

/// The committed record, or `None` while the store holds none.
fn stored_record(store: &mut SecretStore) -> Result<Option<Record>> {
    match store.read()? {
        None => Ok(None),
        Some(text) => parse_record(&text).map(Some).ok_or(Fail::new(
            Code::InvalidSession,
            "Invalid InfoMentor session store record. Run infomentor-mcp login to sign in again.",
        )),
    }
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Fail::config(
            "Cannot inspect the InfoMentor session store. Check its permissions.",
        )),
    }
}

/// A marker, or even a lone record, means the store decides; the legacy file is never read.
fn store_decides(store: &SecretStore, record: &Path) -> Result<bool> {
    Ok(store.exists()? || exists(record)?)
}

/// Node's `path.resolve`: absolute, with `.` and `..` resolved lexically.
pub fn resolve(path: &Path) -> PathBuf {
    let joined = std::env::current_dir().unwrap_or_default().join(path);
    let mut resolved = PathBuf::from("/");

    for component in joined.components() {
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
    Err(Fail::config(
        "Cannot resolve the InfoMentor session paths. Check their permissions.",
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

/// Either path, or a directory above it (the root included), is the other or lies in the other's
/// `<name>.` namespace.
fn collides(first: &Path, second: &Path) -> bool {
    first.ancestors().any(|up| overlaps(up, second))
        || second.ancestors().any(|up| overlaps(up, first))
}

/// The legacy file is removed and swept, logout removes the collection cursors, and the store
/// sweeps its own namespace and can be reset, so neither the legacy file nor its collections may
/// share the record's or key file's namespace or lie inside or around either. Checked before
/// anything is touched.
fn reject_collisions(record: &SecretRecordOptions, legacy: &Path) -> Result<()> {
    let mut collections = legacy.as_os_str().to_owned();
    collections.push(".collections");
    let used = [canonical(legacy)?, canonical(Path::new(&collections))?];
    let mut owned = vec![canonical(&record.path)?];

    if let Some(key) = record.keys.key_file() {
        owned.push(canonical(key)?);
    }

    if owned
        .iter()
        .any(|path| used.iter().any(|other| collides(path, other)))
    {
        return Err(Fail::config(
            "The InfoMentor session file path overlaps the encrypted InfoMentor session store or its key. Choose another INFOMENTOR_SESSION_PATH or --session.",
        ));
    }
    Ok(())
}

/// Where a held session persists a changed session.
enum Target<'h, 'o> {
    Legacy(&'h Path),
    Store {
        store: &'h mut SecretStore<'o>,
        record: Record,
    },
}

/// `HeldSession`: a session read under the store lock, saved where it was read from.
pub struct Held<'h, 'o> {
    pub session: SavedSession,
    /// The stored sign-in for renewal; `None` before migration or when none was stored.
    #[expect(dead_code, reason = "login uses it from slice 3")]
    pub credentials: Option<Credentials>,
    /// Where the session lives and whether a sign-in is stored; never a path or a value.
    pub storage: &'static str,
    cancel: &'h Cancel,
    target: Target<'h, 'o>,
}

impl Held<'_, '_> {
    /// Persist a changed session where it was read from, keeping the stored sign-in.
    pub fn save(&mut self, next: &SavedSession) -> Result<()> {
        match &mut self.target {
            Target::Legacy(path) => write_session(next, path, self.cancel),
            Target::Store { store, record } => {
                let next = Record {
                    session: Some(next.clone()),
                    credentials: record.credentials.clone(),
                };
                store.write(&encode_record(&next)?)?;
                *record = next;
                Ok(())
            }
        }
    }
}

/// A failure inside the store hold, or the store's own.
enum Failed {
    Fail(Fail),
    Store(StoreError),
}

impl From<StoreError> for Failed {
    fn from(error: StoreError) -> Self {
        Failed::Store(error)
    }
}

impl From<Fail> for Failed {
    fn from(fail: Fail) -> Self {
        Failed::Fail(fail)
    }
}

/// `withSession`: hold the store lock for all of `work`, so a renewal, the request and the cookies
/// it rotates use one session. Before the store has a marker the legacy file is authoritative
/// and changes are written back to it; once it has one only the store is used, whatever it holds.
pub fn with_session<T>(
    legacy: &Path,
    cancel: &Cancel,
    keys: Option<Arc<dyn KeyProvider>>,
    work: impl FnOnce(&mut Held) -> Result<T>,
) -> Result<T> {
    let record = session_record(keys, cancel.clone())?;
    reject_collisions(&record, legacy)?;

    let outcome = with_secret_store(&record, |store| -> std::result::Result<T, Failed> {
        if !store_decides(store, &record.path)? {
            // Temporaries orphaned by a hard crash hold cookies; old ones are removed.
            sweep_temp(legacy, DEFAULT_SWEEP_AGE).map_err(|_| {
                Fail::config(
                    "Cannot clean up beside the InfoMentor session file. Check its directory permissions.",
                )
            })?;
            let mut held = Held {
                session: read_session(legacy)?,
                credentials: None,
                storage: PLAINTEXT,
                cancel,
                target: Target::Legacy(legacy),
            };
            return Ok(work(&mut held)?);
        }
        let stored = stored_record(store)?;
        let Some((session, stored)) =
            stored.and_then(|stored| Some((stored.session.clone()?, stored)))
        else {
            return Err(LOGIN_REQUIRED.into());
        };
        let mut held = Held {
            session,
            credentials: stored.credentials.clone(),
            storage: match stored.credentials {
                Some(_) => {
                    "Saved in an encrypted file. Your InfoMentor sign-in is stored there for automatic renewal."
                }
                None => {
                    "Saved in an encrypted file. No InfoMentor sign-in is stored for automatic renewal."
                }
            },
            cancel,
            target: Target::Store {
                store,
                record: stored,
            },
        };
        Ok(work(&mut held)?)
    });

    match outcome {
        Ok(value) => Ok(value),
        Err(Failed::Fail(fail)) => Err(fail),
        Err(Failed::Store(error)) => Err(store_error(&error)),
    }
}

/// The CLI's store preflight before it serves or runs an auth command: false, after one stderr
/// line, when the store is unsafe; a notice there when an earlier build's store is still on disk.
pub fn check_store_at_startup() -> Result<bool> {
    startup_check(
        APP,
        "infomentor-mcp login",
        || session_record(None, Cancel::default()),
        &mut |text| eprint!("{text}"),
    )
    // A bug, not a store refusal: TypeScript rethrows it, and the CLI hides it.
    .map_err(|_| Fail::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_bound_matches_the_typescript_constant() {
        // '{"version":1,"session":,"credentials":{"username":"","password":""}}'.length is 68.
        assert_eq!(RECORD_MAX_BYTES, 68 + 1_048_576 + 6 * 4608);
    }

    #[test]
    fn records_parse_and_encode_like_the_typescript_schema() {
        let text =
            r#"{"credentials":{"password":"p","username":"u"},"session":null,"version":1,"x":1}"#;
        let record = parse_record(text).unwrap();
        assert_eq!(
            encode_record(&record).unwrap(),
            r#"{"version":1,"session":null,"credentials":{"username":"u","password":"p"}}"#
        );

        for invalid in [
            r#"{"version":1,"session":null}"#,
            r#"{"version":2,"session":null,"credentials":null}"#,
            r#"{"version":1,"session":null,"credentials":{"username":"u","password":"p","x":1}}"#,
            r#"{"version":1,"session":null,"credentials":{"username":"","password":"p"}}"#,
            r#"{"version":1,"session":{"version":2},"credentials":null}"#,
        ] {
            assert!(parse_record(invalid).is_none(), "{invalid}");
        }
        let long = "x".repeat(PASSWORD_MAX + 1);
        assert!(Credentials::parse(&json!({"username": "u", "password": long})).is_none());
    }

    #[test]
    fn collisions_compare_namespaces_beside_and_above_each_other() {
        let path = Path::new;
        assert!(collides(
            path("/a/session.enc"),
            path("/a/session.enc.lock")
        ));
        assert!(collides(path("/a/session.enc"), path("/a/session.enc/x")));
        assert!(collides(path("/a/b.enc"), path("/a/b.enc")));
        assert!(!collides(path("/a/session.enc"), path("/a/session.json")));
        assert!(!collides(path("/a/session.enc"), path("/b/session.enc")));
        // The root is a directory above both, as Node's dirname walks to it.
        assert!(collides(path("/.store"), path("/x/y")));
    }
}
