use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::errors::{Code, Error, Result};
use crate::keys::{KeyProvider, LocalKeyFileProvider};
use crate::seam::test_seam;
use crate::secret::check_names;

/// The variable that once chose the macOS Keychain; it is retired (see [`default_key_provider`]).
pub const KEY_BACKEND: &str = "FAMILY_MCP_KEY_BACKEND";

/// What the store's paths depend on: the platform and the process environment. A test seam; the
/// functions without `_in` read [`StoreEnvironment::current`].
#[derive(Debug, Clone, Default)]
pub struct StoreEnvironment {
    /// A `std::env::consts::OS` value.
    pub os: String,
    /// HOME, else the password entry's home.
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<OsString>,
    pub xdg_data_home: Option<OsString>,
    pub key_backend: Option<OsString>,
    /// `FAMILY_MCP_STORE_TEST_SEAM=1`.
    pub test_seam: bool,
}

impl StoreEnvironment {
    /// This process's platform and environment, read now.
    pub fn current() -> Self {
        Self {
            os: std::env::consts::OS.to_owned(),
            // HOME, or the password entry's home while HOME is unset or empty, as Node's homedir.
            home: std::env::home_dir(),
            xdg_config_home: std::env::var_os("XDG_CONFIG_HOME"),
            xdg_data_home: std::env::var_os("XDG_DATA_HOME"),
            key_backend: std::env::var_os(KEY_BACKEND),
            test_seam: test_seam(),
        }
    }

    /// True where the store lives under `~/Library/Application Support/family-mcp`.
    pub fn mac_store(&self) -> bool {
        self.os == "macos" && !self.test_seam
    }

    /// The user's absolute home directory; anything else is refused.
    pub fn home_directory(&self) -> Result<PathBuf> {
        match &self.home {
            Some(home) if home.is_absolute() => Ok(normalize(home)),
            _ => Err(Error::new(
                Code::StoreUnavailable,
                "The home directory is not known; set HOME to an absolute path.",
            )),
        }
    }

    /// macOS: `~/Library/Application Support/family-mcp`, holding `keys/` and one directory per
    /// server.
    pub fn mac_store_root(&self) -> Result<PathBuf> {
        Ok(self
            .home_directory()?
            .join("Library/Application Support/family-mcp"))
    }

    /// A relative XDG variable is ignored, as the XDG base directory specification requires.
    fn xdg_base(&self, configured: Option<&OsString>, fallback: &str) -> Result<PathBuf> {
        match configured.map(PathBuf::from) {
            Some(configured) if configured.is_absolute() => Ok(normalize(&configured)),
            _ => Ok(self.home_directory()?.join(fallback)),
        }
    }

    fn config_base(&self) -> Result<PathBuf> {
        self.xdg_base(self.xdg_config_home.as_ref(), ".config")
    }

    fn data_base(&self) -> Result<PathBuf> {
        self.xdg_base(self.xdg_data_home.as_ref(), ".local/share")
    }
}

/// `$XDG_CONFIG_HOME/<app_name>/session.json`, defaulting to `~/.config/<app_name>/session.json`,
/// on every platform: only the encrypted store moves on macOS. `legacy` is a pre-XDG location that
/// keeps precedence while its file exists.
pub fn default_session_path(app_name: &str, legacy: Option<&Path>) -> Result<PathBuf> {
    let directory = StoreEnvironment::current()
        .config_base()?
        .join(plain_name(app_name)?);

    Ok(match legacy {
        Some(legacy) if legacy.is_file() => legacy.to_owned(),
        _ => directory.join("session.json"),
    })
}

/// [`default_secret_record_path_in`] for this process.
pub fn default_secret_record_path(app_name: &str) -> Result<PathBuf> {
    default_secret_record_path_in(&StoreEnvironment::current(), app_name)
}

/// macOS: `~/Library/Application Support/family-mcp/<app_name>/session.enc`. Linux and other
/// platforms: `$XDG_CONFIG_HOME/<app_name>/session.enc`, defaulting to `~/.config`. `keys` is
/// refused as a name, so a store never shares the key directory.
pub fn default_secret_record_path_in(
    environment: &StoreEnvironment,
    app_name: &str,
) -> Result<PathBuf> {
    plain_name(app_name)?;

    if app_name == "keys" {
        return Err(Error::invalid("appName must not be keys."));
    }
    let base = match environment.mac_store() {
        true => environment.mac_store_root()?,
        false => environment.config_base()?,
    };
    Ok(base.join(app_name).join("session.enc"))
}

/// [`key_provider_in`] for this process.
pub fn default_key_provider(server: &str, profile: &str) -> Result<Arc<dyn KeyProvider>> {
    key_provider_in(&StoreEnvironment::current(), server, profile)
}

/// The key file on macOS and Linux, the only key provider: macOS
/// `~/Library/Application Support/family-mcp/keys/<server>.<profile>.key`, Linux
/// `$XDG_DATA_HOME/family-mcp/keys/<server>.<profile>.key` (default `~/.local/share`), apart from
/// the records. `FAMILY_MCP_KEY_BACKEND` is retired: unset, empty or `file` changes nothing and
/// any other value is refused. Other platforms have no provider: STORE_UNAVAILABLE.
pub fn key_provider_in(
    environment: &StoreEnvironment,
    server: &str,
    profile: &str,
) -> Result<Arc<dyn KeyProvider>> {
    check_names(&[server, profile])?;
    let backend = environment.key_backend.as_deref().unwrap_or_default();

    if !backend.is_empty() && backend != "file" {
        return Err(Error::new(
            Code::StoreUnavailable,
            "FAMILY_MCP_KEY_BACKEND is not supported. Set it to file or unset it.",
        ));
    }

    if environment.os != "macos" && environment.os != "linux" {
        return Err(Error::new(
            Code::StoreUnavailable,
            "This platform has no supported store key.",
        ));
    }
    let root = match environment.mac_store() {
        true => environment.mac_store_root()?,
        false => environment.data_base()?.join("family-mcp"),
    };
    Ok(Arc::new(LocalKeyFileProvider::new(
        root.join("keys").join(format!("{server}.{profile}.key")),
    )))
}

const RECORD_FILES: [&str; 3] = ["session.enc", "session.enc.marker", "session.enc.lock"];

/// [`retired_store_paths_in`] for this process.
pub fn retired_store_paths(server: &str, profile: &str) -> Result<Vec<PathBuf>> {
    retired_store_paths_in(&StoreEnvironment::current(), server, profile)
}

/// Where an earlier, unreleased build kept this store on macOS (`~/.config/<server>/session.enc`
/// and its marker and lock, `~/.local/share/family-mcp/keys/<server>.<profile>.key`, or their
/// absolute-XDG equivalents), without the current store's own record, marker, lock and key, which
/// XDG variables pointing into Application Support would otherwise name. Paths only; nothing here
/// touches the files. Empty off macOS.
pub fn retired_store_paths_in(
    environment: &StoreEnvironment,
    server: &str,
    profile: &str,
) -> Result<Vec<PathBuf>> {
    check_names(&[server, profile])?;

    if !environment.mac_store() {
        return Ok(Vec::new());
    }
    let home = environment.home_directory()?;
    let key = format!("{server}.{profile}.key");
    let configs = distinct([home.join(".config"), environment.config_base()?]);
    let data = distinct([home.join(".local/share"), environment.data_base()?]);
    let root = environment.mac_store_root()?;
    let mut current: Vec<PathBuf> = RECORD_FILES
        .iter()
        .map(|name| root.join(server).join(name))
        .collect();
    current.push(root.join("keys").join(&key));

    let records = configs.iter().flat_map(|config| {
        RECORD_FILES
            .iter()
            .map(move |name| config.join(server).join(name))
    });
    let keys = data
        .iter()
        .map(|base| base.join("family-mcp/keys").join(&key));

    Ok(records
        .chain(keys)
        .filter(|path| !current.contains(&normalize(path)))
        .collect())
}

/// In order, without repeats.
fn distinct<const N: usize>(paths: [PathBuf; N]) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = Vec::new();

    for path in paths {
        if !kept.contains(&path) {
            kept.push(path);
        }
    }
    kept
}

fn plain_name(app_name: &str) -> Result<&str> {
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
    Ok(app_name)
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
