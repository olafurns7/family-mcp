use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rustix::io::Errno;
use zeroize::{Zeroize, Zeroizing};

use crate::errors::{Cancel, Code, Error, Result, errno};
use crate::files::{
    create_private, ensure_private_dir, parent, random, read_private_bytes, sync_directory,
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

/// A raw 32-byte key in an owner-only file, read with the same checks as `read_private_file`: a
/// regular, single-link file owned by this user with no group or other permission bits.
pub struct LocalKeyFileProvider {
    /// The key file, kept in a different directory from the records it protects; never put it in
    /// an error message.
    pub path: PathBuf,
    key_id: String,
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
        }
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
        match read_private_bytes(&self.path, KEY_BYTES) {
            Ok(mut bytes) => {
                let key = <[u8; KEY_BYTES]>::try_from(bytes.as_slice())
                    .map(Key::new)
                    .map_err(|_| malformed_key());
                bytes.zeroize();
                key
            }
            Err(error) if error.code == Code::NotFound => Err(key_unavailable()),
            Err(error) if error.code == Code::TooLarge => Err(malformed_key()),
            Err(error) => Err(error),
        }
    }

    fn create_key(&self, _cancel: &Cancel) -> Result<()> {
        let directory = parent(&self.path);
        ensure_private_dir(directory, true)?;
        let mut file = create_private(&self.path).map_err(|error| {
            if errno(&error) == Some(Errno::EXIST) {
                key_exists()
            } else {
                Error::io(
                    error,
                    "Cannot create the store key. Check the key directory.",
                )
            }
        })?;
        let written = random::<KEY_BYTES>().and_then(|mut key| {
            let written = file.write_all(&key).and_then(|()| file.sync_all());
            key.zeroize();
            written.map_err(|error| Error::io(error, "Cannot write the store key. Check the disk."))
        });

        if written.is_err() {
            // Nothing was encrypted with a partial key yet, so it is not left behind as malformed.
            let _ = fs::remove_file(&self.path);
        }
        written?;
        sync_directory(directory);
        Ok(())
    }

    fn key_file(&self) -> Option<&Path> {
        Some(&self.path)
    }
}
