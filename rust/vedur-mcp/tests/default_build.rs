//! A build without the `test-origin` feature cannot read the test variables: their names are not
//! in the binary at all, so every request goes to the public IMO hosts. Nothing runs the binary,
//! so nothing can reach IMO.

use std::path::{Path, PathBuf};
use std::process::Command;

fn mentions(binary: &Path, text: &[u8]) -> bool {
    let bytes = std::fs::read(binary).unwrap();
    bytes.windows(text.len()).any(|window| window == text)
}

const VARIABLES: [&[u8]; 3] = [
    b"VEDUR_TEST_ORIGIN",
    b"VEDUR_TEST_NOW",
    b"VEDUR_TEST_ATTEMPT_TIMEOUT_MS",
];

#[test]
fn the_default_build_ignores_the_test_variables() {
    let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("default-features");
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--offline",
            "--locked",
            "-p",
            "vedur-mcp",
            "--target-dir",
        ])
        .arg(&target)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(status.success());
    let built = target.join("debug/vedur-mcp");

    for variable in VARIABLES {
        assert!(!mentions(&built, variable));
    }
    assert!(mentions(&built, b"https://api.vedur.is/"));
    assert!(mentions(&built, b"https://gottvedur.is"));
}

/// Not vacuous: the search finds the variables in the binary that reads them.
#[cfg(feature = "test-origin")]
#[test]
fn the_test_build_names_the_test_variables() {
    let built = Path::new(env!("CARGO_BIN_EXE_vedur-mcp"));

    for variable in VARIABLES {
        assert!(mentions(built, variable));
    }
}
