//! Encrypted session records, byte-compatible with the TypeScript `@family-mcp/session-store`
//! package: the same record and marker files, key locations, lock protocol and error codes, so a
//! Rust server and the TypeScript CLI can share one store. Unix only.

mod errors;
mod files;
mod keychain;
mod keys;
mod lock;
mod paths;
mod secret;

pub use errors::{Cancel, Code, Error, Result};
pub use files::{
    DEFAULT_SWEEP_AGE, ensure_private_dir, read_private_bytes, read_private_file, sweep_temp,
    write_private_file,
};
pub use keychain::{KeychainAccessorKeyProvider, KeychainAccessorOptions};
pub use keys::{FakeKeyProvider, KEY_BYTES, Key, KeyProvider, LocalKeyFileProvider};
pub use lock::{DEFAULT_WAIT, LockOptions, with_file_lock};
pub use paths::{
    default_key_provider, default_secret_record_path, default_session_path, key_provider_for,
};
pub use secret::{
    SecretRecordOptions, SecretStore, create_secret_key, read_secret_record, secret_store_exists,
    with_secret_record, with_secret_store,
};
