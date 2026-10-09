//! The saved access token: the encrypted store record `{version, token}` shared with the
//! TypeScript CLI, with packages/kronan-mcp/src/auth.ts's rules and messages. Everything here
//! blocks; the server calls it from `spawn_blocking`.

use family_store::{
    Error as StoreError, SecretRecordOptions, default_key_provider, default_secret_record_path,
    retired_store_paths, startup_check,
};

use crate::error::{Fail, Result};

/// One access token of at most 4 KiB fits comfortably; anything larger is not a token file.
pub const TOKEN_MAX_BYTES: usize = 16_384;

const APP: &str = "kronan-mcp";

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
        SecretRecordOptions::new(path, APP, "default", "token", 1, keys, TOKEN_MAX_BYTES);
    record.retired = retired_store_paths(APP, "default")?;
    Ok(record)
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
