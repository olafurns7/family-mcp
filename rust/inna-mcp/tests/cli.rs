//! Behavior parity.rs does not compare with the TypeScript package: the version against the
//! package manifest.
#![cfg(feature = "test-origin")]

mod scratch;

use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn the_version_is_the_typescript_package_version() {
    let manifest = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/inna-mcp/package.json"),
    )
    .unwrap();
    let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));

    let scratch = scratch::Scratch::new("version");
    let mut command = Command::new(env!("CARGO_BIN_EXE_inna-mcp"));
    command.arg("--version").stdin(Stdio::null());
    scratch.isolate(&mut command);
    let output = command.output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
}
