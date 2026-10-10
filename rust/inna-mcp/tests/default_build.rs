//! A build without the `test-origin` feature has none of the test seams: their names and texts
//! are not in the binary at all, so a release build only uses the real store and the real hosts.
//! Nothing runs the binary, so nothing can reach Inna.

use std::path::{Path, PathBuf};
use std::process::Command;

fn mentions(binary: &Path, text: &[u8]) -> bool {
    let bytes = std::fs::read(binary).unwrap();
    bytes.windows(text.len()).any(|window| window == text)
}

/// The test build's refusal to choose a store outside a scratch home.
const SEAMS: [&[u8]; 1] = [b"the real store is never used"];

#[test]
fn the_default_build_has_no_test_seams() {
    let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("default-features");
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--offline",
            "--locked",
            "-p",
            "inna-mcp",
            "--target-dir",
        ])
        .arg(&target)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(status.success());
    for seam in SEAMS {
        assert!(!mentions(&target.join("debug/inna-mcp"), seam));

        // The check would see the seam: the test build has it.
        if cfg!(feature = "test-origin") {
            assert!(mentions(Path::new(env!("CARGO_BIN_EXE_inna-mcp")), seam));
        }
    }
}
