//! A build without the `test-origin` feature cannot read INFOMENTOR_TEST_ORIGIN: its name is not
//! in the binary at all, so every request goes to InfoMentor's own hosts. Nothing runs the binary,
//! so nothing can reach InfoMentor.

use std::path::{Path, PathBuf};
use std::process::Command;

fn mentions(binary: &Path, variable: &[u8]) -> bool {
    let bytes = std::fs::read(binary).unwrap();
    bytes
        .windows(variable.len())
        .any(|window| window == variable)
}

const VARIABLES: [&[u8]; 2] = [b"INFOMENTOR_TEST_ORIGIN", b"INFOMENTOR_TEST_FAILURES"];

#[test]
fn the_default_build_ignores_the_test_variables() {
    let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("default-features");
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--offline",
            "--locked",
            "-p",
            "infomentor-mcp",
            "--target-dir",
        ])
        .arg(&target)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(status.success());
    for variable in VARIABLES {
        assert!(!mentions(&target.join("debug/infomentor-mcp"), variable));

        // The check would see the variable: the test build reads it.
        if cfg!(feature = "test-origin") {
            assert!(mentions(
                Path::new(env!("CARGO_BIN_EXE_infomentor-mcp")),
                variable
            ));
        }
    }
}
