use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::process::Command;

/// A private home for one Bun run, removed on drop. The run gets the store test seam and its home,
/// XDG directories and temporary directory in here, so neither language reaches the real store.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("abler-{name}-{}", std::process::id()));
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    pub fn isolate(&self, command: &mut Command) {
        command
            .env("FAMILY_MCP_STORE_TEST_SEAM", "1")
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("TMPDIR", &self.0);
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
