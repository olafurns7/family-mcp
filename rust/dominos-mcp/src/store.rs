use crate::error::{Fail, Result};
use family_store::{
    SecretRecordOptions, default_key_provider, default_secret_record_path, retired_store_paths,
    startup_check,
};

pub const APP: &str = "dominos-mcp";
pub const SESSION_MAX_BYTES: usize = 132_707;

pub fn session_record() -> family_store::Result<SecretRecordOptions> {
    #[cfg(feature = "test-origin")]
    {
        let environment = family_store::StoreEnvironment::current();
        let absolute = |value: &Option<std::ffi::OsString>| {
            value.as_deref().is_some_and(|v| Path::new(v).is_absolute())
        };
        let scratch = if environment.test_seam {
            absolute(&environment.xdg_config_home) && absolute(&environment.xdg_data_home)
        } else {
            environment
                .home
                .is_some_and(|home| home.starts_with(std::env::temp_dir()))
        };
        assert!(
            scratch,
            "Tests require scratch XDG directories or a scratch HOME; the real store is never used."
        );
    }
    let mut record = SecretRecordOptions::new(
        default_secret_record_path(APP)?,
        APP,
        "default",
        "session",
        1,
        default_key_provider(APP, "default")?,
        SESSION_MAX_BYTES,
    );
    record.retired = retired_store_paths(APP, "default")?;
    Ok(record)
}

pub fn check_store_at_startup() -> Result<bool> {
    startup_check(APP, "dominos-mcp auth login", session_record, &mut |line| {
        eprint!("{line}")
    })
    .map_err(|_| Fail::Unknown)
}
use crate::js;
use family_store::{
    Cancel, Code, Error as StoreError, SecretStore, default_session_path, read_private_file,
    with_secret_store,
};
use serde_json::{Value, json};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

pub type Session = Value;
pub const NO_SESSION: &str = "No saved Domino’s session. Run dominos-mcp auth login first.";
fn store_error(error: &StoreError) -> Fail {
    Fail::Safe(match error.code {
        Code::StoreUnavailable => {
            "The Domino’s store key is missing. Run dominos-mcp auth login to sign in again."
        }
        Code::StoreBackendRetired => {
            "The Domino’s session store is a leftover of an earlier test build that kept its key in the macOS Keychain. Remove session.enc and session.enc.marker from ~/Library/Application Support/family-mcp/dominos-mcp, then run dominos-mcp auth login again."
        }
        Code::StoreWriteUncertain => {
            "The last write to the Domino’s session store did not complete, so its session is not used. Remove session.enc and session.enc.marker from the Domino’s store folder (~/Library/Application Support/family-mcp/dominos-mcp on macOS, ~/.config/dominos-mcp on Linux by default), then run dominos-mcp auth login again."
        }
        Code::SecretNotFound => NO_SESSION,
        Code::Busy => "Another dominos-mcp process is using the Domino’s session store. Try again.",
        Code::Cancelled => "Cancelled before the Domino’s session store changed.",
        Code::TooLarge => {
            "The Domino’s session is larger than the store allows. Run dominos-mcp auth login again."
        }
        Code::UnsafeFile => {
            "Cannot use the Domino’s session store. Run dominos-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first."
        }
        Code::InvalidArgument => return Fail::Unknown,
        _ => {
            "Cannot use the Domino’s session store. Its files or key are damaged, unsafe, or not readable."
        }
    })
}
impl From<StoreError> for Fail {
    fn from(error: StoreError) -> Self {
        store_error(&error)
    }
}

pub fn resolve(path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| Fail::Unknown)?
            .join(path)
    };
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
    Ok(resolved)
}
pub fn session_path() -> Result<PathBuf> {
    let path = match std::env::var_os("DOMINOS_SESSION_FILE").filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => default_session_path(APP, None)?,
    };
    resolve(&path)
}
pub fn valid_token(token: &str) -> bool {
    (1..=32768).contains(&token.len()) && token.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
pub fn parse_session(value: &Value) -> Option<Session> {
    (value["version"] == 1).then_some(())?;
    let access = value["accessToken"].as_str().filter(|s| valid_token(s))?;
    let refresh = value["refreshToken"].as_str().filter(|s| valid_token(s))?;
    let username = value["username"]
        .as_str()
        .filter(|s| (1..=256).contains(&s.chars().count()))?;
    value["expiresAt"].as_f64().filter(|n| n.is_finite())?;
    Some(
        json!({"version":1,"accessToken":access,"refreshToken":refresh,"username":username,"expiresAt":value["expiresAt"]}),
    )
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Fail::Safe(
            "Cannot inspect the Domino’s session store. Check its permissions.",
        )),
    }
}
fn store_decides(store: &SecretStore, record: &Path) -> Result<bool> {
    Ok(store.exists()? || exists(record)?)
}
fn stored_session(store: &mut SecretStore) -> Result<Option<Option<Session>>> {
    let Some(text) = store.read()? else {
        return Ok(None);
    };
    let value = js::parse(text.as_bytes()).ok_or(Fail::Safe(
        "Invalid Domino’s session store record. Run dominos-mcp auth login to sign in again.",
    ))?;
    if value.is_null() {
        return Ok(Some(None));
    }
    parse_session(&value)
        .map(|s| Some(Some(s)))
        .ok_or(Fail::Safe(
            "Invalid Domino’s session store record. Run dominos-mcp auth login to sign in again.",
        ))
}
pub fn load_legacy(path: &Path) -> Result<Session> {
    let text=read_private_file(path, SESSION_MAX_BYTES+1).map_err(|error|Fail::Safe(if error.code==Code::NotFound { NO_SESSION } else { "Cannot read the Domino’s session. Use a private regular file owned by you, or sign in again." }))?;
    js::parse(text.as_bytes()).and_then(|value|parse_session(&value)).ok_or(Fail::Safe("Cannot read the Domino’s session. Use a private regular file owned by you, or sign in again."))
}
pub fn with_session<T>(
    legacy: &Path,
    cancel: &Cancel,
    work: impl FnOnce(&Session) -> Result<T>,
) -> Result<T> {
    let mut record = session_record()?;
    record.cancel = cancel.clone();
    with_secret_store(&record, |store| {
        let current = if store_decides(store, &record.path)? {
            stored_session(store)?
                .flatten()
                .ok_or(Fail::Safe(NO_SESSION))?
        } else {
            load_legacy(legacy)?
        };
        work(&current)
    })
}
