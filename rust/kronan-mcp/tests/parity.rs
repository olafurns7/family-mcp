//! The Rust binary against the TypeScript CLI and server, scenario by scenario, through
//! tests/ts/parity.ts and its local fake upstream. `FAMILY_MCP_BUN` must name a Bun 1.4.2
//! executable: this test fails without it and is never skipped. It needs the `test-origin`
//! feature, without which the binary would only talk to Krónan itself.
#![cfg(feature = "test-origin")]

mod scratch;

use std::path::Path;
use std::process::Command;

#[test]
fn every_scenario_matches_the_typescript_package() {
    let bun = std::env::var_os("FAMILY_MCP_BUN")
        .expect("FAMILY_MCP_BUN must name a Bun 1.4.2 executable; parity tests never skip");
    let scratch = scratch::Scratch::new("parity");
    let mut command = Command::new(bun);
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ts/parity.ts"))
        .arg(env!("CARGO_BIN_EXE_kronan-mcp"))
        .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0");
    scratch.isolate(&mut command);
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.starts_with("parity ok"), "{stdout}");
}
