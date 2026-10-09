use std::fs::{self, Metadata};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rustix::io::Errno;
use zeroize::{Zeroize, Zeroizing};

use crate::backup::exclude_from_backups;
use crate::errors::{Cancel, Code, Error, Result, errno};
use crate::files::{
    DEFAULT_SWEEP_AGE, create_private, parent, random, read_private_bytes, suffixed, sweep_temp,
    sync_directory, uuid,
};
use crate::storage::{
    StorePaths, check_store_paths, lstat_or_missing, store_directories, temporaries_of,
};

pub const KEY_BYTES: usize = 32;

/// A record's 256-bit data key. It is wiped when dropped and is never copied implicitly: the
/// store keeps one for a hold and lends it out.
pub struct Key(pub(crate) Zeroizing<[u8; KEY_BYTES]>);

impl Key {
    pub fn new(bytes: [u8; KEY_BYTES]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    pub fn bytes(&self) -> &[u8; KEY_BYTES] {
        &self.0
    }
}

/// Never the key itself.
impl std::fmt::Debug for Key {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Key(..)")
    }
}

/// Where a record's data key lives. Runtime code only calls `get_key`.
pub trait KeyProvider: Send + Sync {
    /// Persisted in the marker; a different backend later is a mismatch, never a fallback.
    fn backend(&self) -> &str;
    fn key_source(&self) -> &str;
    fn key_id(&self) -> &str;
    /// Returns the existing key. Never creates one: a missing key is STORE_UNAVAILABLE.
    fn get_key(&self, cancel: &Cancel) -> Result<Key>;
    /// Explicit setup only; refuses to replace an existing key. Use `create_secret_key`.
    fn create_key(&self, cancel: &Cancel) -> Result<()>;
    /// The key file, for providers that keep the key in one; callers keep other paths apart from it.
    fn key_file(&self) -> Option<&Path> {
        None
    }
}

pub(crate) fn key_unavailable() -> Error {
    Error::new(
        Code::StoreUnavailable,
        "The store key is not available. Restore the key or set up the store again.",
    )
}

pub(crate) fn key_exists() -> Error {
    Error::new(
        Code::StoreError,
        "A store key already exists; it is never replaced.",
    )
}

pub(crate) fn malformed_key() -> Error {
    Error::new(
        Code::StoreError,
        "The store key is malformed; it must be 32 bytes.",
    )
}

/// In-memory key for tests.
pub struct FakeKeyProvider {
    key: Mutex<Option<[u8; KEY_BYTES]>>,
    key_id: String,
}

impl FakeKeyProvider {
    pub fn new(key: Option<[u8; KEY_BYTES]>) -> Self {
        Self::with_key_id(key, "test")
    }

    pub fn with_key_id(key: Option<[u8; KEY_BYTES]>, key_id: &str) -> Self {
        Self {
            key: Mutex::new(key),
            key_id: key_id.to_owned(),
        }
    }
}

impl KeyProvider for FakeKeyProvider {
    fn backend(&self) -> &str {
        "test"
    }

    fn key_source(&self) -> &str {
        "memory"
    }

    fn key_id(&self) -> &str {
        &self.key_id
    }

    fn get_key(&self, _cancel: &Cancel) -> Result<Key> {
        self.key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .map(Key::new)
            .ok_or_else(key_unavailable)
    }

    fn create_key(&self, _cancel: &Cancel) -> Result<()> {
        let mut key = self
            .key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if key.is_some() {
            return Err(key_exists());
        }
        *key = Some(random()?);
        Ok(())
    }
}

/// A step of key publication, for [`LocalKeyFileProvider::with_on_publish`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Publish {
    /// The temporary holds the whole key and is flushed.
    Written,
    /// The key's name is linked to the temporary.
    Linked,
}

type OnPublish = Box<dyn Fn(Publish) + Send + Sync>;

/// A raw 32-byte key in an owner-only file, read with the same checks as `read_private_file`: a
/// regular, single-link file owned by this user with no group or other permission bits, in store
/// directories that pass the store's path checks.
pub struct LocalKeyFileProvider {
    /// The key file, kept in a different directory from the records it protects; never put it in
    /// an error message.
    pub path: PathBuf,
    key_id: String,
    on_publish: Option<OnPublish>,
}

impl LocalKeyFileProvider {
    /// The key id recorded in the marker is `local`.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self::with_key_id(path, "local")
    }

    pub fn with_key_id(path: impl Into<PathBuf>, key_id: &str) -> Self {
        Self {
            path: path.into(),
            key_id: key_id.to_owned(),
            on_publish: None,
        }
    }

    /// Test seam: `on_publish` runs after each publication step, so a test can stop the process
    /// there.
    pub fn with_on_publish(mut self, on_publish: impl Fn(Publish) + Send + Sync + 'static) -> Self {
        self.on_publish = Some(Box::new(on_publish));
        self
    }

    fn published(&self, step: Publish) {
        if let Some(on_publish) = &self.on_publish {
            on_publish(step);
        }
    }

    fn read_key(&self) -> Result<Key> {
        check_store_paths(&StorePaths {
            directories: &store_directories(&self.path),
            ..StorePaths::default()
        })?;
        recover_key_link(&self.path)?;
        let mut bytes = read_private_bytes(&self.path, KEY_BYTES)?;
        let key = <[u8; KEY_BYTES]>::try_from(bytes.as_slice())
            .map(Key::new)
            .map_err(|_| malformed_key());
        bytes.zeroize();
        key
    }

    /// Write the key to an exclusive temporary, flush it, then `link` it to the key's name, which
    /// never replaces an existing key, and remove the temporary. A crash leaves either no key or
    /// the whole key, at worst with the temporary as a second name that `get_key` removes.
    fn publish(&self) -> Result<()> {
        let directories = store_directories(&self.path);
        check_store_paths(&StorePaths {
            directories: &directories,
            create: true,
            ..StorePaths::default()
        })?;
        let directory = parent(&self.path);
        // Excluded and confirmed before the first key byte exists.
        exclude_from_backups(&[directory], false)?;
        // A temporary that never became the key holds no key anyone uses; only old ones go.
        sweep_temp(&self.path, DEFAULT_SWEEP_AGE)?;
        let temporary = suffixed(&self.path, &format!(".{}.tmp", uuid()?));
        let linked = write_key(&temporary).and_then(|()| {
            self.published(Publish::Written);
            fs::hard_link(&temporary, &self.path).map_err(|error| {
                if errno(&error) == Some(Errno::EXIST) {
                    key_exists()
                } else {
                    Error::io(
                        error,
                        "Cannot create the store key. Check the key directory.",
                    )
                }
            })?;
            self.published(Publish::Linked);
            Ok(())
        });
        // A temporary left as a second name of the key is removed by the next get_key.
        let _ = fs::remove_file(&temporary);
        linked?;
        sync_directory(directory);
        Ok(())
    }
}

impl KeyProvider for LocalKeyFileProvider {
    fn backend(&self) -> &str {
        "encrypted-file"
    }

    fn key_source(&self) -> &str {
        "local-file"
    }

    fn key_id(&self) -> &str {
        &self.key_id
    }

    fn get_key(&self, _cancel: &Cancel) -> Result<Key> {
        self.read_key().map_err(|error| match error.code {
            Code::NotFound => key_unavailable(),
            Code::TooLarge => malformed_key(),
            _ => error,
        })
    }

    fn create_key(&self, _cancel: &Cancel) -> Result<()> {
        self.publish()
    }

    fn key_file(&self) -> Option<&Path> {
        Some(&self.path)
    }
}

fn write_key(temporary: &Path) -> Result<()> {
    let mut file = create_private(temporary).map_err(|error| {
        Error::io(
            error,
            "Cannot create the store key. Check the key directory.",
        )
    })?;
    random::<KEY_BYTES>().and_then(|mut key| {
        let written = file.write_all(&key).and_then(|()| file.sync_all());
        key.zeroize();
        written.map_err(|error| Error::io(error, "Cannot write the store key. Check the disk."))
    })
}

/// The store's own temporary that is a second name of `key` (same device and inode, owned by
/// this user): what a crash between `link` and the temporary's removal leaves. `None` otherwise.
pub(crate) fn key_temporary(key: &Path, info: &Metadata) -> Result<Option<PathBuf>> {
    let uid = rustix::process::getuid().as_raw();

    for temporary in temporaries_of(key)? {
        if let Some(candidate) = lstat_or_missing(&temporary)?
            && candidate.is_file()
            && (candidate.dev(), candidate.ino()) == (info.dev(), info.ino())
            && candidate.uid() == uid
        {
            return Ok(Some(temporary));
        }
    }
    Ok(None)
}

/// Remove that temporary, so the key has one name again; any other extra link stays refused by
/// the read that follows, which also catches a recovery another process finished first.
fn recover_key_link(key: &Path) -> Result<()> {
    let Some(info) = lstat_or_missing(key)? else {
        return Ok(());
    };

    if !info.is_file() || info.nlink() != 2 {
        return Ok(());
    }
    let Some(temporary) = key_temporary(key, &info)? else {
        return Ok(());
    };

    match fs::remove_file(&temporary) {
        Err(error) if errno(&error) != Some(Errno::NOENT) => Err(Error::io(
            error,
            "Cannot remove a temporary file. Check the directory permissions.",
        )),
        _ => Ok(()),
    }
}
