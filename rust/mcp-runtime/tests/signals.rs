//! A server on the documented entry point (examples/stdio.rs): when a tool call's `Cancelled`
//! completes, and that SIGINT and SIGTERM end the process while a call is in flight and the host
//! still holds stdin open. Without `shutdown_background`, dropping the runtime waits for Tokio's
//! blocking stdin read, which never returns. The example's call ends only once it is cancelled,
//! and its `close` waits for it, so a cancel that never arrives keeps the process alive.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::ChildStderr;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal, kill_process};

/// `cargo test` builds the examples next to the test binaries' `deps` directory; a run limited
/// to `--test signals` does not rebuild it.
fn example() -> PathBuf {
    let deps = std::env::current_exe().unwrap();
    let path = deps
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/stdio");
    assert!(
        path.exists(),
        "build the example first: cargo test --examples --tests"
    );
    path
}

fn send(stdin: &mut ChildStdin, message: &str) {
    writeln!(stdin, "{message}").unwrap();
    stdin.flush().unwrap();
}

fn exits_within(child: &mut Child, limit: Duration) -> Option<i32> {
    let deadline = Instant::now() + limit;

    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

/// The example, initialized, with one `hang` call in flight (id 2).
fn hanging() -> (Child, ChildStdin, BufReader<ChildStderr>) {
    let mut child = Command::new(example())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    send(
        &mut stdin,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#,
    );
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(line.contains(r#""serverInfo""#), "{line}");
    send(
        &mut stdin,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    );
    send(
        &mut stdin,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hang","arguments":{}}}"#,
    );
    assert_eq!(next(&mut stderr), "HANG\n");
    // Drain stdout so the server never blocks on a full pipe.
    std::thread::spawn(move || {
        let _ = stdout.read_to_end(&mut Vec::new());
    });
    (child, stdin, stderr)
}

fn next(stderr: &mut BufReader<ChildStderr>) -> String {
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    line
}

#[test]
fn a_signal_cancels_the_call_in_flight_and_ends_the_process_while_stdin_stays_open() {
    for signal in [Signal::INT, Signal::TERM] {
        let (mut child, stdin, mut stderr) = hanging();
        kill_process(Pid::from_child(&child), signal).unwrap();
        assert_eq!(next(&mut stderr), "CANCELLED\n", "{signal:?}");
        assert_eq!(next(&mut stderr), "CLOSE\n", "{signal:?}");
        assert_eq!(
            exits_within(&mut child, Duration::from_secs(5)),
            Some(0),
            "{signal:?}"
        );
        // Held open until the process has exited.
        drop(stdin);
    }
}

#[test]
fn the_host_cancelling_a_call_cancels_it_at_once() {
    let (mut child, mut stdin, mut stderr) = hanging();
    let sent = Instant::now();
    send(
        &mut stdin,
        r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}"#,
    );
    assert_eq!(next(&mut stderr), "CANCELLED\n");
    assert!(
        sent.elapsed() < Duration::from_secs(2),
        "{:?}",
        sent.elapsed()
    );
    drop(stdin);
    assert_eq!(next(&mut stderr), "CLOSE\n");
    assert_eq!(exits_within(&mut child, Duration::from_secs(5)), Some(0));
}

/// rmcp first waits up to 5 s for calls in flight to answer, then stops serving, which cancels
/// them. A server that must stop its calls at once does so in `stdin_ended`.
#[test]
fn the_end_of_stdin_cancels_a_call_in_flight_only_after_rmcps_drain() {
    let (mut child, stdin, mut stderr) = hanging();
    let ended = Instant::now();
    drop(stdin);
    assert_eq!(next(&mut stderr), "CANCELLED\n");
    let waited = ended.elapsed();
    assert!(
        (Duration::from_secs(4)..Duration::from_secs(8)).contains(&waited),
        "{waited:?}"
    );
    assert_eq!(next(&mut stderr), "CLOSE\n");
    assert_eq!(exits_within(&mut child, Duration::from_secs(5)), Some(0));
}
