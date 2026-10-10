//! The encrypted session store of packages/inna-mcp/src/client.ts: its record options and the
//! CLI's startup check.

use std::sync::Arc;

use family_store::{
    Error as StoreError, KeyProvider, SecretRecordOptions, StoreEnvironment,
    default_secret_record_path_in, key_provider_in, retired_store_paths_in, startup_check,
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

/// Where the store is: this process's environment, or in a unit test the scratch store
/// `tests::scratch` chose for its thread.
fn environment() -> StoreEnvironment {
    #[cfg(test)]
    return tests::SCRATCH
        .with(|scratch| scratch.borrow().clone())
        .expect(
            "A unit test opens its store with store::tests::scratch; the real store is never used.",
        );
    #[cfg(not(test))]
    StoreEnvironment::current()
}

/// The store's record options; `keys` is a test seam, the default being the store's key file.
pub fn session_record(
    keys: Option<Arc<dyn KeyProvider>>,
) -> std::result::Result<SecretRecordOptions, StoreError> {
    let environment = environment();
    let path = default_secret_record_path_in(&environment, APP)?;
    let keys = match keys {
        Some(keys) => keys,
        None => key_provider_in(&environment, APP, "default")?,
    };
    // A test never reaches the real store. The test build refuses to choose one unless the store
    // test seam points it at absolute XDG directories, as the packages' bunfig preload does, or
    // the production layout sits under a scratch HOME in the temporary directory.
    #[cfg(feature = "test-origin")]
    {
        let absolute = |variable: &Option<std::ffi::OsString>| {
            variable
                .as_deref()
                .is_some_and(|value| std::path::Path::new(value).is_absolute())
        };
        let scratch = match environment.test_seam {
            true => absolute(&environment.xdg_config_home) && absolute(&environment.xdg_data_home),
            false => environment
                .home
                .as_ref()
                .is_some_and(|home| home.starts_with(std::env::temp_dir())),
        };
        assert!(
            scratch,
            "Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1 with scratch XDG directories, or a scratch HOME; the real store is never used."
        );
    }
    let mut record =
        SecretRecordOptions::new(path, APP, "default", "session", 1, keys, RECORD_MAX_BYTES);
    record.retired = retired_store_paths_in(&environment, APP, "default")?;
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
pub mod tests {
    use std::cell::RefCell;
    use std::fs::{self, DirBuilder};
    use std::os::unix::fs::DirBuilderExt;
    use std::path::PathBuf;

    use super::*;

    thread_local! {
        pub static SCRATCH: RefCell<Option<StoreEnvironment>> = const { RefCell::new(None) };
    }

    /// A fresh scratch directory whose `config` and `data` hold this thread's store, through the
    /// store test seam, as the packages' tests keep theirs.
    pub fn scratch(name: &str) -> PathBuf {
        family_store::enable_test_seam();
        let root = std::env::temp_dir().join(format!("inna-unit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        SCRATCH.with(|scratch| {
            *scratch.borrow_mut() = Some(StoreEnvironment {
                os: std::env::consts::OS.to_owned(),
                home: Some(root.clone()),
                xdg_config_home: Some(root.join("config").into()),
                xdg_data_home: Some(root.join("data").into()),
                key_backend: None,
                test_seam: true,
            });
        });
        root
    }

    #[test]
    fn the_record_bound_is_the_typescript_one() {
        // packages/inna-mcp/src/client.ts RECORD_MAX_BYTES, evaluated by Bun.
        assert_eq!(RECORD_MAX_BYTES, 1_682_444);
    }
}
