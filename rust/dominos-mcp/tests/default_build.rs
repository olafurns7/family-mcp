//! A build without the `test-origin` feature cannot read DOMINOS_TEST_ORIGIN: its name is not in
//! the binary at all, so every request goes to https://api.dominos.is/api/. Nothing runs the binary, so
//! nothing can reach Domino’s.

use std::path::{Path, PathBuf};
use std::process::Command;

fn mentions(binary: &Path, variable: &[u8]) -> bool {
    let bytes = std::fs::read(binary).unwrap();
    bytes
        .windows(variable.len())
        .any(|window| window == variable)
}

const VARIABLES: [&[u8]; 1] = [b"DOMINOS_TEST_ORIGIN"];

#[test]
fn the_default_build_ignores_the_test_variables() {
    let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("default-features");
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--offline",
            "--locked",
            "-p",
            "dominos-mcp",
            "--target-dir",
        ])
        .arg(&target)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(status.success());
    let built = target.join("debug/dominos-mcp");

    for variable in VARIABLES {
        assert!(!mentions(&built, variable));
    }
    assert!(mentions(&built, b"https://api.dominos.is/api/"));
}

/// Not vacuous: the search finds the variables in the binary that reads them.
#[cfg(feature = "test-origin")]
#[test]
fn the_test_build_names_the_test_variables() {
    let built = Path::new(env!("CARGO_BIN_EXE_dominos-mcp"));

    for variable in VARIABLES {
        assert!(mentions(built, variable));
    }
}
