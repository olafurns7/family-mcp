//! The encrypted session store of packages/inna-mcp/src/client.ts: its record options and the
//! CLI's startup check.

use std::sync::Arc;

use family_store::{
    Error as StoreError, KeyProvider, SecretRecordOptions, default_key_provider,
    default_secret_record_path, retired_store_paths, startup_check,
};

use crate::error::{Fail, Result};

pub const APP: &str = "inna-mcp";

/// The largest cookie jar a session may save, in UTF-8 bytes of its serialized JSON.
pub const MAX_SESSION_BYTES: usize = 262_144;

pub const MAX_STUDENTS: usize = 64;

pub const MAX_NAME_LENGTH: usize = 256;

// A string character is at most six bytes of JSON (an escaped control character or surrogate).
const BINDING_BYTES: usize = r#"{"userId":,"studentId":"","schoolId":""}"#.len() + 16 + 32 + 32;

const STUDENT_BYTES: usize =
    r#""":,"#.len() + 32 + BINDING_BYTES + r#","studentName":"""#.len() + 6 * MAX_NAME_LENGTH;

/// The largest JSON the saved-session schema can produce, so a valid session always fits.
pub const RECORD_MAX_BYTES: usize =
    r#"{"version":2,"jar":"","account":,"students":{},"pauseUntil":}"#.len()
        + 6 * MAX_SESSION_BYTES
        + BINDING_BYTES
        + (MAX_STUDENTS * STUDENT_BYTES - 1)
        + 24;

/// The store's record options; `keys` is a test seam, the default being the store's key file.
pub fn session_record(
    keys: Option<Arc<dyn KeyProvider>>,
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
    record.retired = retired_store_paths(APP, "default")?;
    Ok(record)
}

/// The CLI's store preflight before it serves or runs an auth command: false, after the refusal
/// on stderr, when the store is unsafe; a notice there when an earlier build's store is still on
/// disk.
pub fn check_store_at_startup() -> Result<bool> {
    startup_check(
        APP,
        "inna-mcp auth login",
        || session_record(None),
        &mut |text| eprint!("{text}"),
    )
    // A bug, not a store refusal: TypeScript rethrows it, and the CLI hides it.
    .map_err(|_| Fail::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_bound_is_the_typescript_one() {
        // packages/inna-mcp/src/client.ts RECORD_MAX_BYTES, evaluated by Bun.
        assert_eq!(RECORD_MAX_BYTES, 1_682_444);
    }
}
