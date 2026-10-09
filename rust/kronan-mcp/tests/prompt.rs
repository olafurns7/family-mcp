//! `auth set` on a terminal: the hidden prompt of this binary and of the TypeScript CLI, typed
//! the same keystrokes on a pseudo-terminal, read the same token (sent to a local fake `/me/`),
//! print the same text, exit the same way and leave the terminal mode as they found it, also when
//! SIGTERM or SIGINT ends them in the middle of the prompt.
//! `FAMILY_MCP_BUN` must name a Bun 1.4.2 executable: this test fails without it and is never
//! skipped. It needs the `test-origin` feature, without which the binary would talk to Krónan.
#![cfg(feature = "test-origin")]

mod scratch;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rustix::io::{FdFlags, fcntl_setfd};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{LocalModes, tcgetattr};

/// A fake Krónan answering every request with an account, recording each Authorization header.
fn upstream() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = Vec::new();
            let mut byte = [0u8; 1];

            while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                request.push(byte[0]);
            }
            let text = String::from_utf8_lossy(&request).into_owned();

            if let Some(line) = text
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
            {
                record.lock().unwrap().push(line[14..].trim().to_owned());
            }
            let body = r#"{"type":"user","name":"Terminal"}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (origin, seen)
}

/// A pseudo-terminal: the controlling side and the terminal the child reads.
fn terminal() -> (OwnedFd, OwnedFd) {
    let controller = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).unwrap();
    // A child that inherited the controlling side would keep the terminal from hanging up.
    fcntl_setfd(&controller, FdFlags::CLOEXEC).unwrap();
    grantpt(&controller).unwrap();
    unlockpt(&controller).unwrap();
    let name = ptsname(&controller, Vec::new()).unwrap();
    let path = Path::new(std::ffi::OsStr::from_bytes(name.to_bytes()));
    let terminal = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    (controller, terminal.into())
}

/// How a case ends after its keys are typed.
#[derive(Debug, Clone, Copy)]
enum End {
    /// The keys finish the prompt.
    Typed,
    /// The controlling side closes: the terminal hangs up.
    HangUp,
    /// Another process sends this signal.
    Signal(&'static str),
}

#[derive(Debug, PartialEq)]
struct Outcome {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
    sent: Vec<String>,
    restored: bool,
}

/// Run `auth set` on a fresh terminal, type `keys` once it is in raw mode, then end it as `end`
/// says.
fn typed(command: &mut Command, keys: &[u8], end: End) -> Outcome {
    let (origin, seen) = upstream();
    let (controller, terminal) = terminal();
    let before = tcgetattr(&terminal).unwrap();
    let child = command
        .env("KRONAN_TEST_ORIGIN", &origin)
        .stdin(Stdio::from(terminal.try_clone().unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Typed keys reach the prompt only once it switched the terminal to raw mode.
    let deadline = Instant::now() + Duration::from_secs(20);

    while tcgetattr(&terminal)
        .unwrap()
        .local_modes
        .contains(LocalModes::ICANON)
    {
        assert!(Instant::now() < deadline, "the prompt never read raw input");
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut writer = std::fs::File::from(controller.try_clone().unwrap());
    writer.write_all(keys).unwrap();

    match end {
        End::Typed => {}
        End::HangUp => {
            drop(writer);
            drop(controller);
        }
        End::Signal(name) => {
            // The typed bytes are read before the signal, so the prompt is mid-line.
            std::thread::sleep(Duration::from_millis(200));
            let sent = Command::new("kill")
                .arg(format!("-{name}"))
                .arg(child.id().to_string())
                .status()
                .unwrap();
            assert!(sent.success());
        }
    }
    let output = child.wait_with_output().unwrap();
    // The kernel may set PENDIN when a terminal returns to canonical mode (macOS always does,
    // until the next read); it is not part of the mode the prompt saved.
    let after = tcgetattr(&terminal).unwrap();
    let restored = after.local_modes - LocalModes::PENDIN == before.local_modes
        && after.input_modes == before.input_modes;

    Outcome {
        code: output.status.code(),
        signal: output.status.signal(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        sent: seen.lock().unwrap().clone(),
        restored,
    }
}

#[test]
fn the_hidden_prompt_reads_keystrokes_like_the_typescript_cli() {
    let bun = std::env::var_os("FAMILY_MCP_BUN")
        .expect("FAMILY_MCP_BUN must name a Bun 1.4.2 executable; parity tests never skip");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let cases: [(&[u8], End); 9] = [
        (b"  synthetic-token-0123456789x\x7f\r", End::Typed),
        (b"synthetic-token-0123456789\x08\x086789\n", End::Typed),
        // Backspace removes one UTF-16 unit: one leaves half of the emoji, two remove it.
        ("synthetic-token-0123456789😀\x7f\r".as_bytes(), End::Typed),
        (
            "synthetic-token-0123456789😀\x7f\x7f\r".as_bytes(),
            End::Typed,
        ),
        (b"synthetic-tok\x03en-0123456789\r", End::Typed),
        (b"\x04", End::Typed),
        (b"synthetic-token-0123456789", End::HangUp),
        (b"synthetic-tok", End::Signal("TERM")),
        (b"synthetic-tok", End::Signal("INT")),
    ];

    for (keys, end) in cases {
        let run = |side: &str| {
            let scratch = scratch::Scratch::new(&format!("prompt-{side}"));
            let mut command = match side {
                "ts" => {
                    let mut command = Command::new(&bun);
                    command
                        .arg("--preload")
                        .arg(manifest.join("tests/ts/rewrite.ts"))
                        .arg(manifest.join("../../packages/kronan-mcp/src/cli.ts"))
                        .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0");
                    command
                }
                _ => Command::new(env!("CARGO_BIN_EXE_kronan-mcp")),
            };
            command.args(["auth", "set"]);
            scratch.isolate(&mut command);
            typed(&mut command, keys, end)
        };
        let ts = run("ts");
        assert!(ts.restored, "{keys:?}: {ts:?}");
        let mut rust = run("rust");

        // Bun dies of the signal; the binary keeps its handler installed, so it exits with the
        // status a shell reports for that death (128 + the signal number).
        if let (End::Signal(_), Some(signal)) = (end, ts.signal) {
            assert_eq!(rust.code, Some(128 + signal), "{end:?}: {rust:?}");
            (rust.code, rust.signal) = (None, Some(signal));
        }
        assert_eq!(rust, ts, "{keys:?} {end:?}");
    }
}
