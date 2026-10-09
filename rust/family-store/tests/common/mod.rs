#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use family_store::{
    Cancel, Code, Error, FakeKeyProvider, KeyProvider, SecretRecordOptions, TEST_SEAM,
    enable_test_seam, with_secret_record, write_private_file,
};

pub const KEY: [u8; 32] = [7; 32];

pub const SECRET: &str = "refresh-token-c2VjcmV0";

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A private directory under the system temporary directory, removed on drop. Making one turns
/// the store test seam on in this process first, so no test needs FAMILY_MCP_STORE_TEST_SEAM.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new() -> Self {
        enable_test_seam();
        let name = format!(
            "family-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(name);
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// This test binary running only the ignored case `test`, with the store test seam on and its
/// home, XDG directories and temporary directory in `root`: the child never sees the real store.
pub fn child_case(test: &str, root: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--ignored", "--nocapture"])
        .env(TEST_SEAM, "1")
        .env("HOME", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("TMPDIR", root);
    command
}

pub fn options_with(
    directory: &Path,
    keys: Arc<dyn KeyProvider>,
    max_bytes: usize,
) -> SecretRecordOptions {
    SecretRecordOptions::new(
        directory.join("records").join("session.enc"),
        "test-mcp",
        "default",
        "session",
        1,
        keys,
        max_bytes,
    )
}

pub fn options(directory: &Path) -> SecretRecordOptions {
    options_with(directory, Arc::new(FakeKeyProvider::new(Some(KEY))), 1024)
}

pub fn put(store: &SecretRecordOptions, value: &str) -> Result<Option<String>, Error> {
    with_secret_record(store, |_| Ok::<_, Error>(Some(value.to_owned())))
}

pub fn code<T>(result: Result<T, Error>) -> Option<Code> {
    result.err().map(|error| error.code)
}

pub fn marker_path(store: &SecretRecordOptions) -> PathBuf {
    let mut name = store.path.clone().into_os_string();
    name.push(".marker");
    name.into()
}

pub fn text(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

pub fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

pub fn write(path: &Path, data: impl AsRef<[u8]>) {
    write_private_file(path, data.as_ref(), &Cancel::default()).unwrap();
}
