use crate::error::{Fail, Result};
use family_store::{
    DEFAULT_SWEEP_AGE, LockOptions, SecretRecordOptions, default_key_provider,
    default_secret_record_path, retired_store_paths, startup_check, sweep_temp, with_file_lock,
    write_private_file,
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
    work: impl FnOnce(Session, &mut dyn FnMut(&Session) -> Result<()>, &'static str) -> Result<T>,
) -> Result<T> {
    let mut record = session_record()?;
    record.cancel = cancel.clone();
    with_secret_store(&record, |store| {
        if !store_decides(store, &record.path)? {
            return work(
                load_legacy(legacy)?,
                &mut |next| save_legacy(legacy, next),
                "Saved in a plaintext file. Run dominos-mcp auth migrate.",
            );
        }
        let current = stored_session(store)?
            .flatten()
            .ok_or(Fail::Safe(NO_SESSION))?;
        work(
            current,
            &mut |next| save_refreshed(store, &record.path, next),
            "Saved in an encrypted file.",
        )
    })
}
/// Create the key when it is missing; only an explicit new login may reset a lost key's store.
fn prepare_key(store: &mut SecretStore, record: &SecretRecordOptions, reset: bool) -> Result<bool> {
    match store.check_key() {
        Ok(()) => Ok(false),
        Err(error) if error.code != Code::StoreUnavailable => Err(error.into()),
        Err(error) => {
            let used = store_decides(store, &record.path)?;

            if used {
                if !reset {
                    return Err(error.into());
                }
                store.reset()?;
            }
            store.create_key()?;
            Ok(used)
        }
    }
}

/// The legacy file is a credential; remove it and any orphaned temporaries beside it.
fn remove_legacy(path: &Path) -> Result<bool> {
    let removed = (|| {
        let found = exists(path).ok()?;

        match fs::remove_file(path) {
            Err(error) if error.kind() != ErrorKind::NotFound => return None,
            _ => {}
        }
        sweep_temp(path, DEFAULT_SWEEP_AGE).ok()?;
        Some(found)
    })();
    removed.ok_or(Fail::Safe(
        "Saved in the encrypted store, but the old plaintext session file could not be removed. Remove it by hand.",
    ))
}

/// Resolve symbolic links in the longest existing prefix, so aliases compare equal.
fn canonical(path: &Path) -> Result<PathBuf> {
    let mut existing = resolve(path)?;
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
        "Cannot resolve the Domino’s session paths. Check their permissions.",
    ))
}

/// Same file, or one name is the other's `<name>.` namespace (lock, marker, temporaries) beside it.
fn overlaps(first: &Path, second: &Path) -> bool {
    let (Some(a), Some(b)) = (first.file_name(), second.file_name()) else {
        return false;
    };
    let (a, b) = (a.as_encoded_bytes(), b.as_encoded_bytes());
    let namespace =
        |name: &[u8], of: &[u8]| name.starts_with(of) && name.get(of.len()) == Some(&b'.');
    first.parent() == second.parent() && (a == b || namespace(a, b) || namespace(b, a))
}

fn collides(first: &Path, second: &Path) -> bool {
    first.ancestors().any(|path| overlaps(path, second))
        || second.ancestors().any(|path| overlaps(path, first))
}
fn checkout_directory(legacy: &Path) -> PathBuf {
    let mut path = legacy.as_os_str().to_owned();
    path.push(".checkouts");
    PathBuf::from(path)
}
fn reject_collisions(record: &SecretRecordOptions, legacy: &Path) -> Result<()> {
    let used = [canonical(legacy)?, canonical(&checkout_directory(legacy))?];
    let mut owned = vec![canonical(&record.path)?];
    if let Some(key) = record.keys.key_file() {
        owned.push(canonical(key)?);
    }
    if owned
        .iter()
        .any(|path| used.iter().any(|other| collides(path, other)))
    {
        return Err(Fail::Safe(
            "DOMINOS_SESSION_FILE overlaps the encrypted Domino’s session store or its key. Choose another path.",
        ));
    }
    Ok(())
}
pub fn change_session<T>(
    work: impl FnOnce(&mut SecretStore, &SecretRecordOptions, &Path) -> Result<T>,
) -> Result<T> {
    let record = session_record()?;
    let legacy = session_path()?;
    reject_collisions(&record, &legacy)?;
    with_file_lock(&legacy, &LockOptions::default(), || {
        with_secret_store(&record, |store| work(store, &record, &legacy))
    })
}
pub fn save_login(work: impl FnOnce() -> Result<Session>) -> Result<bool> {
    change_session(|store, record, legacy| {
        let replaced = prepare_key(store, record, true)?;
        if store_decides(store, &record.path)? {
            store.read()?;
        }
        let value = work()?;
        store.write(&value.to_string())?;
        remove_legacy(legacy)?;
        Ok(replaced)
    })
}
pub fn migrate() -> Result<&'static str> {
    change_session(|store, record, legacy| {
        if store_decides(store, &record.path)? && stored_session(store)?.is_some() {
            return Ok(if remove_legacy(legacy)? {
                "Already migrated. Removed a leftover plaintext session file."
            } else {
                "Already migrated."
            });
        }
        let value = load_legacy(legacy)?;
        prepare_key(store, record, false)?;
        store.write(&value.to_string())?;
        remove_legacy(legacy)?;
        Ok("Domino’s session moved to the encrypted store; the plaintext file was removed.")
    })
}
pub fn logout() -> Result<()> {
    change_session(|store, record, legacy| {
        if store_decides(store, &record.path)? {
            store.write("null")?;
        }
        remove_legacy(legacy)?;
        Ok(())
    })
}
fn save_refreshed(store: &mut SecretStore, path: &Path, next: &Session) -> Result<()> {
    if store.write(&next.to_string()).is_err() {
        let _ = fs::remove_file(path);
        return Err(store_error(&StoreError::new(
            Code::StoreWriteUncertain,
            "Refreshed session lost.",
        )));
    }
    Ok(())
}
fn save_legacy(path: &Path, next: &Session) -> Result<()> {
    write_private_file(path,format!("{next}\n").as_bytes(),&Cancel::default()).map_err(|_|Fail::Safe("Cannot save the refreshed Domino’s session file. Check its permissions, or sign in again."))
}
pub fn session_storage() -> Result<&'static str> {
    with_session(&session_path()?, &Cancel::default(), |_, _, storage| {
        Ok(storage)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_session_bound_and_schema_cover_the_largest_rotated_session() {
        let value = json!({"version":1,"accessToken":"\"".repeat(32768),"refreshToken":"\"".repeat(32768),"username":"\u{1}".repeat(256),"expiresAt":-f64::MAX});
        let session = parse_session(&value).unwrap();
        assert_eq!(session.to_string().len(), SESSION_MAX_BYTES);
        for (key, invalid) in [
            ("accessToken", json!("x".repeat(32769))),
            ("refreshToken", json!("not a header")),
            ("username", json!("x".repeat(257))),
            ("version", json!(2)),
        ] {
            let mut bad = value.clone();
            bad[key] = invalid;
            assert!(parse_session(&bad).is_none());
        }
    }
    #[test]
    fn every_store_failure_has_a_fixed_text_without_its_underlying_cause() {
        use mcp_runtime::Failure;
        for code in [
            Code::StoreUnavailable,
            Code::StoreBackendRetired,
            Code::StoreWriteUncertain,
            Code::SecretNotFound,
            Code::Busy,
            Code::Cancelled,
            Code::TooLarge,
            Code::UnsafeFile,
            Code::StoreError,
            Code::StoreLocked,
        ] {
            let text = store_error(&StoreError::new(code, "synthetic-secret-cause"))
                .safe()
                .unwrap();
            assert!(!text.contains("synthetic-secret-cause"));
        }
    }
}
