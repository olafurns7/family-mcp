//! The store test seam never reaches a process that Cargo launches: `cargo run`, debug and
//! release, starts examples/store_layout.rs with the production policy (on macOS the store under
//! Application Support), while this test process has the seam on. A variable the caller sets is
//! still honoured, as by the TypeScript runtime.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::Scratch;
use family_store::{TEST_LS, TEST_SEAM, TEST_TMUTIL};

/// `cargo run` of the example from this workspace with `home` as HOME, the seam variable only
/// when `seam`, and no XDG directories otherwise; Cargo and rustup keep their own homes.
fn cargo_run(release: bool, home: &Path, seam: bool) -> String {
    let user = std::env::home_dir().unwrap();
    let own = |variable: &str, fallback: &str| {
        std::env::var_os(variable).map_or_else(|| user.join(fallback), PathBuf::from)
    };
    let mut command = Command::new(env!("CARGO"));
    command
        .args(["run", "--quiet", "--offline", "--locked"])
        .args([
            "-p",
            "family-store",
            "--example",
            "store_layout",
            "--target-dir",
        ])
        .arg(Path::new(env!("CARGO_TARGET_TMPDIR")).join("launch"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("CARGO_HOME", own("CARGO_HOME", ".cargo"))
        .env("RUSTUP_HOME", own("RUSTUP_HOME", ".rustup"))
        .env("HOME", home)
        .env_remove(TEST_SEAM)
        .env_remove(TEST_TMUTIL)
        .env_remove(TEST_LS)
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME");

    if release {
        command.arg("--release");
    }

    if seam {
        command
            .env(TEST_SEAM, "1")
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_DATA_HOME", home.join("data"));
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
}

fn expected(home: &Path, variable: bool) -> String {
    let (record, key) = if variable {
        (home.join("config"), home.join("data/family-mcp"))
    } else if cfg!(target_os = "macos") {
        let root = home.join("Library/Application Support/family-mcp");
        (root.clone(), root)
    } else {
        (home.join(".config"), home.join(".local/share/family-mcp"))
    };
    format!(
        "variable:{variable}\nseam:{variable}\nrecord:{}\nkey:{}\n",
        record.join("test-mcp/session.enc").display(),
        key.join("keys/test-mcp.default.key").display()
    )
}

#[test]
fn a_process_cargo_runs_gets_the_production_store_and_never_the_test_seam() {
    let scratch = Scratch::new();
    let home = &scratch.0;
    // This test process has the seam on, as every store test does.
    assert!(family_store::test_seam());

    for release in [false, true] {
        assert_eq!(
            cargo_run(release, home, false),
            expected(home, false),
            "release: {release}"
        );
    }
    // The variable itself is still honoured by a launched process, as by the TypeScript runtime.
    assert_eq!(cargo_run(false, home, true), expected(home, true));
    // Paths only: the example made nothing.
    assert_eq!(std::fs::read_dir(home).unwrap().count(), 0);
}
