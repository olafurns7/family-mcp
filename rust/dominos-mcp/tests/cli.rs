//! Behavior parity.rs cannot compare with the TypeScript package.
#![cfg(feature = "test-origin")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[test]
fn the_version_is_the_typescript_package_version() {
    let manifest = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/dominos-mcp/package.json"),
    )
    .unwrap();
    let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));

    // --version never touches the store, so it needs no scratch home.
    let output = Command::new(env!("CARGO_BIN_EXE_dominos-mcp"))
        .arg("--version")
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
}
