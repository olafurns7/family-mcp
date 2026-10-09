//! A server on the documented entry point (examples/stdio.rs) exits on SIGINT and SIGTERM while
//! a request is in flight and the host still holds stdin open. Without `shutdown_background`,
//! dropping the runtime waits for Tokio's blocking stdin read, which never returns.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
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

#[test]
fn a_signal_ends_the_process_while_stdin_stays_open() {
    for signal in [Signal::INT, Signal::TERM] {
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
        line.clear();
        stderr.read_line(&mut line).unwrap();
        assert_eq!(line, "HANG\n");
        // Drain stdout so the server never blocks on a full pipe.
        std::thread::spawn(move || {
            let _ = stdout.read_to_end(&mut Vec::new());
        });

        kill_process(Pid::from_child(&child), signal).unwrap();
        line.clear();
        stderr.read_line(&mut line).unwrap();
        assert_eq!(line, "CLOSE\n", "{signal:?}");
        assert_eq!(
            exits_within(&mut child, Duration::from_secs(5)),
            Some(0),
            "{signal:?}"
        );
        // Held open until the process has exited.
        drop(stdin);
    }
}
