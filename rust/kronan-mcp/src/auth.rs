//! The saved access token: the encrypted store record `{version, token}` shared with the
//! TypeScript CLI, and the plaintext file older versions wrote, with
//! packages/kronan-mcp/src/auth.ts's rules and messages. Everything here blocks; the server calls
//! it from blocking threads.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use family_store::{
    Code, Error as StoreError, SecretRecordOptions, SecretStore, default_key_provider,
    default_secret_record_path, default_session_path, read_private_file, retired_store_paths,
    startup_check, with_secret_store,
};
use serde_json::Value;

use crate::error::{Fail, Result};
use crate::js;

/// One access token of at most 4 KiB fits comfortably; anything larger is not a token file.
pub const TOKEN_MAX_BYTES: usize = 16_384;

const APP: &str = "kronan-mcp";

const NO_TOKEN: &str = "No saved Krónan access token. Run kronan-mcp auth set first.";

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

/// Before the store has a marker the legacy file is authoritative. Once it has one only the store
/// is read, whatever it holds.
pub fn load_token() -> Result<String> {
    let record = token_record()?;

    with_secret_store(&record, |store| {
        if !store_decides(store, &record.path)? {
            return load_legacy_token(&token_path()?);
        }
        stored_token(store)?.flatten().ok_or(Fail::Safe(NO_TOKEN))
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
}
