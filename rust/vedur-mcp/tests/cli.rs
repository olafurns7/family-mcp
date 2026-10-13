//! The command line: `--version` prints the bare package version, `--help` names the stdio
//! server, anything else fails without starting it.

use std::path::PathBuf;
use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_vedur-mcp"))
        .args(args)
        .env_clear()
        .output()
        .unwrap()
}

#[test]
fn the_version_is_the_package_version() {
    let manifest = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/vedur-mcp/package.json"),
    )
    .unwrap();
    let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));

    for flag in ["--version", "-v"] {
        let output = run(&[flag]);
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\n", env!("CARGO_PKG_VERSION"))
        );
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn help_names_the_stdio_server_and_unknown_arguments_fail() {
    let help = run(&["--help"]);
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("Start the stdio MCP server"));

    for args in [&["auth", "login"][..], &["--verbose"], &["serve", "extra"]] {
        let output = run(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
    }
}
