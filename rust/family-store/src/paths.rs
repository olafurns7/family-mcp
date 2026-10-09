use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::errors::{Code, Error, Result};
use crate::keychain::KeychainAccessorKeyProvider;
use crate::keys::{KeyProvider, LocalKeyFileProvider};
use crate::secret::check_names;

/// `$XDG_CONFIG_HOME/<app_name>/session.json`, defaulting to `~/.config/<app_name>/session.json`.
/// `legacy` is a pre-XDG location that keeps precedence while its file exists.
pub fn default_session_path(app_name: &str, legacy: Option<&Path>) -> Result<PathBuf> {
    let directory = config_directory(app_name)?;

    Ok(match legacy {
        Some(legacy) if legacy.is_file() => legacy.to_owned(),
        _ => directory.join("session.json"),
    })
}

/// `$XDG_CONFIG_HOME/<app_name>/session.enc`, defaulting to `~/.config/<app_name>/session.enc`.
pub fn default_secret_record_path(app_name: &str) -> Result<PathBuf> {
    Ok(config_directory(app_name)?.join("session.enc"))
}

/// macOS: the login keychain through `/usr/bin/security`. Linux: a key file at
/// `$XDG_DATA_HOME/family-mcp/keys/<server>.<profile>.key` (default `~/.local/share`), apart from
/// the records under `~/.config`. `FAMILY_MCP_KEY_BACKEND=file` selects that key file on macOS
/// too, for a Mac whose keychain is locked; any other value is refused. Other platforms have no
/// provider: STORE_UNAVAILABLE.
pub fn default_key_provider(server: &str, profile: &str) -> Result<Arc<dyn KeyProvider>> {
    key_provider_for(
        std::env::consts::OS,
        std::env::var_os(KEY_BACKEND).as_deref(),
        server,
        profile,
    )
}

/// The variable [`default_key_provider`] reads.
pub const KEY_BACKEND: &str = "FAMILY_MCP_KEY_BACKEND";

/// [`default_key_provider`] for a named `std::env::consts::OS` value and a `FAMILY_MCP_KEY_BACKEND`
/// value (unset and empty are the same); a test seam.
pub fn key_provider_for(
    os: &str,
    backend: Option<&OsStr>,
    server: &str,
    profile: &str,
) -> Result<Arc<dyn KeyProvider>> {
    check_names(&[server, profile])?;
    let backend = backend.unwrap_or_default();

    if !backend.is_empty() && backend != "file" {
        return Err(Error::new(
            Code::StoreUnavailable,
            "FAMILY_MCP_KEY_BACKEND is not supported. Set it to file or unset it.",
        ));
    }

    match os {
        "macos" if backend.is_empty() => {
            Ok(Arc::new(KeychainAccessorKeyProvider::new(server, profile)?))
        }
        "macos" | "linux" => Ok(Arc::new(LocalKeyFileProvider::new(
            xdg_base("XDG_DATA_HOME", ".local/share")
                .join("family-mcp")
                .join("keys")
                .join(format!("{server}.{profile}.key")),
        ))),
        _ => Err(Error::new(
            Code::StoreUnavailable,
            "This platform has no supported store key.",
        )),
    }
}

fn config_directory(app_name: &str) -> Result<PathBuf> {
    let plain = app_name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && app_name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric());

    if !plain {
        return Err(Error::invalid("appName must be a plain directory name."));
    }
    Ok(xdg_base("XDG_CONFIG_HOME", ".config").join(app_name))
}

/// A relative XDG variable is ignored, as the XDG base directory specification requires.
fn xdg_base(variable: &str, fallback: &str) -> PathBuf {
    let base = match std::env::var_os(variable).map(PathBuf::from) {
        Some(configured) if configured.is_absolute() => configured,
        _ => std::env::home_dir().unwrap_or_default().join(fallback),
    };
    normalize(&base)
}

/// Node's `join` resolves `.` and `..` lexically; the same file must come out here.
fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();

    for component in path.components() {
        match component {
            Component::ParentDir => {
                normal.pop();
            }
            Component::CurDir => {}
            other => normal.push(other),
        }
    }
    normal
}
