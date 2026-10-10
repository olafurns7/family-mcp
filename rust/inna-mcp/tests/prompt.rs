//! `auth login` on a terminal: the hidden phone prompt of this binary and of the TypeScript CLI,
//! typed the same keystrokes on a pseudo-terminal, read the same number (the sign-in's first
//! request goes to a local fake that refuses it), print the same text, exit the same way and leave
//! the terminal mode as they found it, also when signals arrive in the middle of the prompt: the
//! first SIGINT cancels the sign-in once the line ends, a second one ends the process, and
//! SIGTERM ends it at once; only the binary also restores the terminal after a second SIGINT
//! (`raw_left`). A terminal that hangs up has no mode left on Linux, so there that one
//! case checks the hang-up instead (see `typed`). Adapted from rust/kronan-mcp/tests/prompt.rs.
//! `FAMILY_MCP_BUN` must name a Bun 1.4.2 executable: this test fails without it and is never
//! skipped. It needs the `test-origin` feature, without which the binary would talk to Inna.
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

use rustix::io::{Errno, FdFlags, fcntl_setfd};
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use rustix::termios::{LocalModes, OptionalActions, tcgetattr, tcsetattr};

/// A fake upstream refusing every request with 404, recording each request line.
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
            record
                .lock()
                .unwrap()
                .push(text.lines().next().unwrap_or_default().to_owned());
            let _ = write!(
                stream,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
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

/// One case: keys typed once the prompt reads raw input, then signals from another process, then
/// more keys, and the terminal hung up at the end or not.
#[derive(Debug, Clone, Copy)]
struct Case {
    keys: &'static [u8],
    signals: &'static [&'static str],
    after: &'static [u8],
    hang_up: bool,
}

const fn keys(keys: &'static [u8]) -> Case {
    Case {
        keys,
        signals: &[],
        after: b"",
        hang_up: false,
    }
}

#[derive(Debug, PartialEq)]
struct Outcome {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
    sent: Vec<String>,
    /// Whether the terminal ended in the mode it started in; `None` when it hung up on Linux.
    restored: Option<bool>,
}

/// Run `auth login` on a fresh terminal and play `case` on it.
fn typed(command: &mut Command, case: Case) -> Outcome {
    let (origin, seen) = upstream();
    let (controller, terminal) = terminal();
    // Start from a mode no fresh terminal has, so a mode the kernel reset to its defaults never
    // passes for one the prompt restored. Neither prompt changes ECHOCTL.
    let mut marked = tcgetattr(&terminal).unwrap();
    marked.local_modes.toggle(LocalModes::ECHOCTL);
    tcsetattr(&terminal, OptionalActions::Now, &marked).unwrap();
    let before = tcgetattr(&terminal).unwrap();
    let child = command
        .env("INNA_TEST_ORIGIN", &origin)
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
    writer.write_all(case.keys).unwrap();

    for name in case.signals {
        // The typed bytes are read before the signal, so the prompt is mid-line.
        std::thread::sleep(Duration::from_millis(200));
        let sent = Command::new("kill")
            .arg(format!("-{name}"))
            .arg(child.id().to_string())
            .status()
            .unwrap();
        assert!(sent.success());
    }

    if !case.after.is_empty() {
        std::thread::sleep(Duration::from_millis(200));
        writer.write_all(case.after).unwrap();
    }

    if case.hang_up {
        drop(writer);
        drop(controller);
    }
    let output = child.wait_with_output().unwrap();
    // The kernel may set PENDIN when a terminal returns to canonical mode (macOS always does,
    // until the next read); it is not part of the mode the prompt saved.
    let restored = match tcgetattr(&terminal) {
        Ok(after) => Some(
            after.local_modes - LocalModes::PENDIN == before.local_modes
                && after.input_modes == before.input_modes,
        ),
        // When the controlling side's last descriptor closes, Linux hangs the terminal up: it
        // resets the mode to the pty driver's defaults, and every terminal call on any of its
        // descriptors, the child's included, fails with EIO. No descriptor is left that could show
        // a restored mode, so on Linux this case checks the hang-up itself. macOS keeps the mode
        // the prompt left, and there it is checked.
        Err(Errno::IO) if cfg!(target_os = "linux") && case.hang_up => None,
        Err(error) => panic!("{case:?}: cannot read the terminal mode: {error}"),
    };

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
fn the_hidden_phone_prompt_reads_keystrokes_like_the_typescript_cli() {
    let bun = std::env::var_os("FAMILY_MCP_BUN")
        .expect("FAMILY_MCP_BUN must name a Bun 1.4.2 executable; parity tests never skip");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let cases = [
        keys(b" 5550000 \r"),
        keys(b"55x\x7f50000\n"),
        // Ctrl-D does nothing on a line with text, and closes the input on an empty one.
        keys(b"5\x04550000\r"),
        keys(b"5\x7f\x04"),
        // Ctrl-C cancels.
        keys(b"555\x03"),
        keys(b"123\r5550000\r"),
        Case {
            hang_up: true,
            ..keys(b"5550000")
        },
        Case {
            signals: &["TERM"],
            ..keys(b"555")
        },
        // The first SIGINT cancels the sign-in once the line ends; the second ends the process.
        Case {
            signals: &["INT"],
            after: b"0000\r",
            ..keys(b"555")
        },
        Case {
            signals: &["INT", "INT"],
            ..keys(b"555")
        },
    ];

    for case in cases {
        let run = |side: &str| {
            let scratch = scratch::Scratch::new(&format!("prompt-{side}"));
            let mut command = match side {
                "ts" => {
                    let mut command = Command::new(&bun);
                    command
                        .arg("--preload")
                        .arg(manifest.join("tests/ts/rewrite.ts"))
                        .arg(manifest.join("../../packages/inna-mcp/src/cli.ts"))
                        .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0");
                    command
                }
                _ => Command::new(env!("CARGO_BIN_EXE_inna-mcp")),
            };
            command.args(["auth", "login"]);
            scratch.isolate(&mut command);
            typed(&mut command, case)
        };
        let ts = run("ts");
        let hung_up = cfg!(target_os = "linux") && case.hang_up;

        // A hang-up fails the read on Linux (EIO), which readline reports as an error; macOS
        // ends the input instead, which cancels. The binary must follow each.
        if case.hang_up {
            let after_prompt = match hung_up {
                true => {
                    "Inna MCP failed. Check input format, file permissions, and local configuration.\n"
                }
                false => "\nInna login cancelled.\n",
            };
            assert_eq!(
                (ts.code, ts.stderr.as_str()),
                (
                    Some(1),
                    format!("Icelandic phone number (input hidden): {after_prompt}").as_str()
                ),
                "{case:?}"
            );
        }
        // Rust: a deliberate difference. Bun dies of the second SIGINT with the terminal still in
        // raw mode; the binary gives the terminal its mode back first.
        let raw_left = case.signals == ["INT", "INT"];
        assert_eq!(
            ts.restored,
            (!hung_up).then_some(!raw_left),
            "{case:?}: {ts:?}"
        );
        let mut rust = run("rust");

        if (case.keys == b"55x\x7f50000\n" || case.keys == b"5\x04550000\r")
            && case.signals.is_empty()
            && case.after.is_empty()
            && !case.hang_up
        {
            check_keystrokes(&rust, &ts, case.keys);
            continue;
        }

        if raw_left {
            assert_eq!(rust.restored, Some(true), "{case:?}: {rust:?}");
            rust.restored = ts.restored;
        }

        // Bun dies of the signal; the binary keeps its handler installed, so it exits with the
        // status a shell reports for that death (128 + the signal number).
        if let (true, Some(signal)) = (!case.signals.is_empty(), ts.signal) {
            assert_eq!(rust.code, Some(128 + signal), "{case:?}: {rust:?}");
            (rust.code, rust.signal) = (None, Some(signal));
        }
        assert_eq!(rust, ts, "{case:?}");
    }
}

// taskr 76066/76588/76640/76644: Bun may ignore DEL or cancel on nonempty-line Ctrl-D on the pty.
// Rust stays strict; input-close, signal, hang-up and non-editing cases keep exact parity.
fn check_keystrokes(rust: &Outcome, ts: &Outcome, keys: &[u8]) {
    let documented = Outcome {
        code: Some(1),
        signal: None,
        stdout: String::new(),
        stderr: "Icelandic phone number (input hidden): \nInna electronic-ID login failed or expired. Check your phone and start a fresh explicit login.\n".into(),
        sent: vec!["GET /r.inna.is/auth/island HTTP/1.1".into()],
        restored: Some(true),
    };
    let plain_input = Outcome {
        code: Some(1),
        signal: None,
        stdout: String::new(),
        stderr: if keys == b"5\x04550000\r" {
            "Icelandic phone number (input hidden): \nInna login cancelled.\n"
        } else {
            "Icelandic phone number (input hidden): \nEnter a seven-digit Icelandic phone number.\n"
        }
        .into(),
        sent: Vec::new(),
        restored: Some(true),
    };
    assert_eq!(rust, &documented);
    assert!(ts == &documented || ts == &plain_input, "{keys:?}: {ts:?}");
}
