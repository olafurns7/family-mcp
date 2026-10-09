//! The saved access token: the encrypted store record `{version, token}` shared with the
//! TypeScript CLI, and the plaintext file older versions wrote, with
//! packages/kronan-mcp/src/auth.ts's rules and messages. Everything here blocks; the server calls
//! it from blocking threads.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use family_store::{
    Code, DEFAULT_SWEEP_AGE, Error as StoreError, LockOptions, SecretRecordOptions, SecretStore,
    default_key_provider, default_secret_record_path, default_session_path, read_private_file,
    retired_store_paths, startup_check, sweep_temp, with_file_lock, with_secret_store,
};
use serde_json::Value;

use crate::error::{Fail, Result};
use crate::js;

/// One access token of at most 4 KiB fits comfortably; anything larger is not a token file.
pub const TOKEN_MAX_BYTES: usize = 16_384;

const APP: &str = "kronan-mcp";

const NO_TOKEN: &str = "No saved Krónan access token. Run kronan-mcp auth set first.";

const STORAGE: &str = "an encrypted file";

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

/// The pre-store plaintext token file. Order-attempt records still derive their path from it, so
/// it stays the same whether or not the token was migrated.
pub fn token_path() -> Result<PathBuf> {
    match std::env::var_os("KRONAN_TOKEN_FILE").filter(|file| !file.is_empty()) {
        Some(file) => Ok(resolve(Path::new(&file))),
        None => Ok(resolve(
            &default_session_path(APP, None).map_err(|_| Fail::Unknown)?,
        )),
    }
}

/// Fixed messages: a store failure never shows a path, key or token, and never falls back.
fn store_error(error: &StoreError) -> Fail {
    Fail::Safe(match error.code {
        Code::StoreUnavailable => {
            "The Krónan store key is missing. Run kronan-mcp auth set to save the token again."
        }
        Code::StoreBackendRetired => {
            "The Krónan token store is a leftover of an earlier test build that kept its key in the macOS Keychain. Remove session.enc and session.enc.marker from ~/Library/Application Support/family-mcp/kronan-mcp, then run kronan-mcp auth set again."
        }
        Code::StoreWriteUncertain => {
            "The last write to the Krónan token store did not complete, so its token is not used. Remove session.enc and session.enc.marker from the Krónan store folder (~/Library/Application Support/family-mcp/kronan-mcp on macOS, ~/.config/kronan-mcp on Linux by default), then run kronan-mcp auth set again."
        }
        Code::SecretNotFound => NO_TOKEN,
        Code::Busy => "Another kronan-mcp process is using the Krónan token store. Try again.",
        Code::Cancelled => "Cancelled before the Krónan token store changed.",
        Code::TooLarge => {
            "The Krónan token store holds more than one access token. Run kronan-mcp auth set again."
        }
        Code::UnsafeFile => {
            "Cannot use the Krónan token store. Run kronan-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first."
        }
        // TypeScript throws a RangeError here, which is not a store error.
        Code::InvalidArgument => return Fail::Unknown,
        _ => {
            "Cannot use the Krónan token store. Its files or key are damaged, unsafe, or not readable."
        }
    })
}

/// `guarded`: every store failure becomes its fixed message.
impl From<StoreError> for Fail {
    fn from(error: StoreError) -> Self {
        store_error(&error)
    }
}

/// The store's options; the key is the store's key file.
fn token_record() -> std::result::Result<SecretRecordOptions, StoreError> {
    let path = default_secret_record_path(APP)?;
    let keys = default_key_provider(APP, "default")?;
    // A test never reaches the real store. The test build refuses to choose one unless the store
    // test seam points it at absolute XDG directories, as the packages' bunfig preload does, or
    // the production layout sits under a scratch HOME in the temporary directory.
    #[cfg(feature = "test-origin")]
    {
        let environment = family_store::StoreEnvironment::current();
        let absolute = |variable: &Option<std::ffi::OsString>| {
            variable
                .as_deref()
                .is_some_and(|value| Path::new(value).is_absolute())
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
        SecretRecordOptions::new(path, APP, "default", "token", 1, keys, TOKEN_MAX_BYTES);
    record.retired = retired_store_paths(APP, "default")?;
    Ok(record)
}

/// Printable ASCII only, so the value can never smuggle header separators or line breaks.
pub fn valid_token(token: &str) -> bool {
    (8..=4096).contains(&token.len()) && token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// `{version: 1, token}` with a valid token; `null` (logged out) only where `nullable`.
fn token_of(text: &str, nullable: bool) -> Option<Option<String>> {
    let value = js::parse(text.as_bytes())?;
    let object = value.as_object()?;
    (object.get("version")? == 1).then_some(())?;

    match object.get("token")? {
        Value::Null if nullable => Some(None),
        Value::String(token) if valid_token(token) => Some(Some(token.clone())),
        _ => None,
    }
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Fail::Safe(
            "Cannot inspect the Krónan token store. Check its permissions.",
        )),
    }
}

/// A marker, or even a lone record, means the store decides; the legacy file is never read.
fn store_decides(store: &SecretStore, record: &Path) -> Result<bool> {
    Ok(store.exists()? || exists(record)?)
}

/// The committed record's token (`Some(None)` after logout), or `None` while the store holds no
/// record.
fn stored_token(store: &mut SecretStore) -> Result<Option<Option<String>>> {
    match store.update(|_| Ok::<_, Fail>(None))? {
        None => Ok(None),
        Some(text) => token_of(&text, true).map(Some).ok_or(Fail::Safe(
            "Invalid Krónan token store record. Run kronan-mcp auth set again.",
        )),
    }
}

/// The pre-store plaintext file, read with the rules it always had.
fn load_legacy_token(path: &Path) -> Result<String> {
    let raw = read_private_file(path, TOKEN_MAX_BYTES).map_err(|error| {
        Fail::Safe(match error.code {
            Code::NotFound => NO_TOKEN,
            Code::TooLarge => {
                "The Krónan token file is too large to be a token file. Run kronan-mcp auth set again."
            }
            _ => {
                "Cannot read the Krónan token file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link."
            }
        })
    })?;
    token_of(&raw, false).flatten().ok_or(Fail::Safe(
        "Invalid Krónan token file. Run kronan-mcp auth set again.",
    ))
}

fn encode_record(token: Option<&str>) -> String {
    serde_json::json!({ "version": 1, "token": token }).to_string()
}

/// The token and how it is saved.
pub struct Saved {
    pub token: String,
    pub storage: String,
}

/// Before the store has a marker the legacy file is authoritative, and `storage` says so. Once it
/// has one only the store is read, whatever it holds.
pub fn load_saved_token() -> Result<Saved> {
    let record = token_record()?;

    with_secret_store(&record, |store| {
        if !store_decides(store, &record.path)? {
            return Ok(Saved {
                token: load_legacy_token(&token_path()?)?,
                storage: "Saved in a plaintext file. Run kronan-mcp auth migrate.".to_owned(),
            });
        }
        let token = stored_token(store)?.flatten().ok_or(Fail::Safe(NO_TOKEN))?;
        Ok(Saved {
            token,
            storage: format!("Saved in {STORAGE}."),
        })
    })
}

pub fn load_token() -> Result<String> {
    Ok(load_saved_token()?.token)
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
        "Saved in the encrypted store, but the old plaintext token file could not be removed. Remove it by hand.",
    ))
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
        "Cannot resolve the Krónan token paths. Check their permissions.",
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

/// The order-attempt journal beside the legacy token file.
pub fn journal_of(legacy: &Path) -> PathBuf {
    let mut name = legacy.as_os_str().to_owned();
    name.push(".order-attempts.json");
    PathBuf::from(name)
}

/// The legacy file is removed and swept, and the store can be reset, so neither may alias the
/// other, the key file, or the order-attempt journal. Checked before anything is touched.
fn reject_collisions(record: &SecretRecordOptions, legacy: &Path) -> Result<()> {
    let store = canonical(&record.path)?;
    let token = canonical(legacy)?;
    let journal = canonical(&journal_of(legacy))?;
    let mut owned = vec![store];

    if let Some(key) = record.keys.key_file() {
        owned.push(canonical(key)?);
    }

    if owned
        .iter()
        .any(|path| overlaps(&token, path) || overlaps(&journal, path))
    {
        return Err(Fail::Safe(
            "KRONAN_TOKEN_FILE overlaps the encrypted Krónan token store or its key. Choose another path.",
        ));
    }
    Ok(())
}

/// Set, migrate and logout hold the legacy file's lock and then the store's for the whole
/// authority decision, legacy read, store commit and legacy removal. Readers take only the
/// store's lock, so the order never inverts.
fn change_token<T>(
    work: impl FnOnce(&mut SecretStore, &SecretRecordOptions, &Path) -> Result<T>,
) -> Result<T> {
    let record = token_record()?;
    let legacy = token_path()?;
    reject_collisions(&record, &legacy)?;

    with_file_lock(&legacy, &LockOptions::default(), || {
        with_secret_store(&record, |store| work(store, &record, &legacy))
    })
}

/// Save a verified token in the store, then remove the plaintext file. True if a store was reset.
pub fn save_token(token: &str) -> Result<bool> {
    if !valid_token(token) {
        // TypeScript's schema parse throws a ZodError here, which no caller reaches.
        return Err(Fail::Unknown);
    }
    let plaintext = encode_record(Some(token));

    change_token(|store, record, legacy| {
        let replaced = prepare_key(store, record, true)?;
        store.update(|_| Ok::<_, Fail>(Some(plaintext)))?;
        remove_legacy(legacy)?;
        Ok(replaced)
    })
}

#[derive(Debug, PartialEq)]
pub enum Migrated {
    Moved,
    Already,
    AlreadyRemovedLegacy,
}

/// Move the legacy token into the store, read it back, then remove the plaintext file. A store
/// with a marker but no record (an interrupted first write or reset) takes the explicit migration.
pub fn migrate_token() -> Result<Migrated> {
    change_token(|store, record, legacy| {
        if store_decides(store, &record.path)? && stored_token(store)?.is_some() {
            return Ok(match remove_legacy(legacy)? {
                true => Migrated::AlreadyRemovedLegacy,
                false => Migrated::Already,
            });
        }
        let token = load_legacy_token(legacy)?;
        prepare_key(store, record, false)?;
        store.update(|_| Ok::<_, Fail>(Some(encode_record(Some(&token)))))?;
        remove_legacy(legacy)?;
        Ok(Migrated::Moved)
    })
}

/// Store a logged-out record when the store decides, and remove any plaintext file.
pub fn logout_token() -> Result<()> {
    change_token(|store, record, legacy| {
        if store_decides(store, &record.path)? {
            store.update(|_| Ok::<_, Fail>(Some(encode_record(None))))?;
        }
        remove_legacy(legacy)?;
        Ok(())
    })
}

/// Accept pasted or piped input with surrounding whitespace; reject anything that is not one token.
pub fn normalize_token(raw: &str) -> Result<String> {
    let token = js::trim(raw);

    match valid_token(token) {
        true => Ok(token.to_owned()),
        false => Err(Fail::Safe(
            "Invalid Krónan access token. Paste the token exactly as Krónan shows it, on one line.",
        )),
    }
}

/// A pasted-token source file is a credential too; it must meet the same private-file rules.
pub fn read_token_source(path: &Path) -> Result<String> {
    read_private_file(path, TOKEN_MAX_BYTES).map_err(|error| {
        Fail::Safe(match error.code {
            Code::NotFound => "The token source file does not exist.",
            Code::TooLarge => "The token source file is too large to hold one access token.",
            _ => {
                "Cannot read the token source file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link."
            }
        })
    })
}

/// The CLI's store preflight before it serves or runs an auth command: false, after the refusal
/// on stderr, when the store is unsafe; a notice there when an earlier build's store is still on
/// disk.
pub fn check_store_at_startup() -> Result<bool> {
    startup_check(APP, "kronan-mcp auth set", token_record, &mut |text| {
        eprint!("{text}")
    })
    // A bug, not a store refusal: TypeScript rethrows it, and the CLI hides it.
    .map_err(|_| Fail::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_parse_like_the_typescript_schemas() {
        let token = "synthetic-token-0123456789";
        assert_eq!(
            token_of(
                &format!(r#"{{"version":1,"token":"{token}","x":1}}"#),
                false
            ),
            Some(Some(token.to_owned()))
        );
        assert_eq!(token_of(r#"{"version":1,"token":null}"#, true), Some(None));
        for invalid in [
            r#"{"version":1,"token":null}"#,
            r#"{"version":2,"token":"synthetic-token-0123456789"}"#,
            r#"{"version":1,"token":"short"}"#,
            r#"{"version":1,"token":"synthetic token 0123"}"#,
            r#"{"version":1}"#,
            "[]",
        ] {
            assert_eq!(token_of(invalid, false), None, "{invalid}");
        }
        assert!(valid_token(&"x".repeat(4096)) && !valid_token(&"x".repeat(4097)));
        assert!(!valid_token("synthetic-tökén"));
    }

    /// The checks of integration.test.ts that inject a key provider, which the binary cannot be
    /// given: tests/ts/integration.test.ts runs the rest through it.
    #[test]
    fn injected_store_failures_have_the_typescript_messages() {
        for (code, ending) in [
            (
                Code::UnsafeFile,
                "Cannot use the Krónan token store. Run kronan-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first.",
            ),
            (Code::StoreBackendRetired, "run kronan-mcp auth set again."),
            // A code no key file produces gets the general text.
            (Code::StoreLocked, "damaged, unsafe, or not readable."),
        ] {
            let Fail::Safe(message) = store_error(&StoreError::new(code, "")) else {
                panic!("{code:?} is not a store failure");
            };
            assert!(message.ends_with(ending), "{message}");
        }
        let Fail::Safe(retired) = store_error(&StoreError::new(Code::StoreBackendRetired, ""))
        else {
            panic!("STORE_BACKEND_RETIRED is not a store failure");
        };
        assert!(retired.contains("leftover of an earlier test build "));
    }
}
