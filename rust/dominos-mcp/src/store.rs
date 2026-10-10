use crate::error::{Fail, Result};
use family_store::{
    SecretRecordOptions, default_key_provider, default_secret_record_path, retired_store_paths,
    startup_check,
};
#[cfg(feature = "test-origin")]
use std::path::Path;

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
