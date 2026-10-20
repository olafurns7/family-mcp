//! Both CLIs against one offline acceptance suite, with isolated disposable session stores.
#![cfg(feature = "test-origin")]
mod scratch;
use std::process::Command;

#[test]
fn guardian_rsvp_checks_and_uncertain_writes() {
    let bun = std::env::var_os("FAMILY_MCP_BUN").expect("FAMILY_MCP_BUN must name Bun 1.4.2");
    let scratch = scratch::Scratch::new("attendance");
    let mut command = Command::new(bun);
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/ts/attendance.ts"
        ))
        .arg(env!("CARGO_BIN_EXE_abler-mcp"));
    scratch.isolate(&mut command);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("attendance ok:"));
}
