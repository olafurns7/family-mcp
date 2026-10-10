//! The encrypted store record `{version, session, credentials}` shared with the TypeScript CLI,
//! with packages/infomentor-mcp/src/store.ts's rules and messages. Everything here blocks; callers
//! run it on blocking threads.

use std::sync::Arc;

use family_store::{
    Cancel, Error as StoreError, KeyProvider, SecretRecordOptions, default_key_provider,
    default_secret_record_path, retired_store_paths, startup_check,
};

use crate::error::{Fail, Result};

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
}
