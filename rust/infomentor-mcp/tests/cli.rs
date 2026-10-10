//! Behavior parity.rs cannot compare with the TypeScript package: the version, and the test
//! build's refusal of a non-local upstream.
#![cfg(feature = "test-origin")]

use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let name = format!(
            "infomentor-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(name);
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    fn command(&self, origin: Option<&str>, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_infomentor-mcp"));
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join(".config"))
            .env("XDG_DATA_HOME", self.0.join(".local/share"))
            .env("FAMILY_MCP_STORE_TEST_SEAM", "1")
            .stdin(Stdio::null());

        if let Some(origin) = origin {
            command.env("INFOMENTOR_TEST_ORIGIN", origin);
        }
        command
    }

    fn run(&self, origin: Option<&str>, args: &[&str]) -> Output {
        self.command(origin, args).output().unwrap()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn the_version_is_the_typescript_package_version() {
    let manifest = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/infomentor-mcp/package.json"),
    )
    .unwrap();
    let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));

    let output = Home::new().run(None, &["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn the_test_build_refuses_to_start_without_a_local_upstream() {
    let home = Home::new();

    for origin in [
        None,
        Some("https://minn.infomentor.is"),
        Some("http://localhost:9"),
    ] {
        let output = home.run(origin, &["status"]);
        assert!(!output.status.success(), "{origin:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("INFOMENTOR_TEST_ORIGIN must be local."),
            "{origin:?}"
        );
    }
    // Nothing was created: the refusal comes before the store is touched.
    assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
}
