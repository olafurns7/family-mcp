//! Behavior parity.rs cannot compare with the TypeScript package: browser discovery, the
//! version, and shutdown while a request is in flight. A local listener stands in for Abler.
#![cfg(feature = "test-origin")]

use std::fs::{self, DirBuilder};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal, kill_process};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let name = format!(
            "abler-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(name);
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    fn command(&self, origin: &str, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_abler-mcp"));
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join(".config"))
            .env("XDG_DATA_HOME", self.0.join(".local/share"))
            .env("ABLER_SESSION_FILE", self.0.join("legacy.json"))
            .env("ABLER_TEST_ORIGIN", origin)
            .env("FAMILY_MCP_KEY_BACKEND", "file");
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command("http://127.0.0.1:9", args)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    /// A plaintext session as older versions saved it; the server reads it while no store exists.
    fn legacy(&self) {
        self.legacy_with(
            r#"{"version":1,"cookies":[{"name":"refreshToken","value":"r0","domain":"www.abler.io","path":"/oauth","expires":-1}]}"#,
        );
    }

    fn legacy_with(&self, session: &str) {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.0.join("legacy.json"))
            .unwrap()
            .write_all(session.as_bytes())
            .unwrap();
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn login_without_a_browser_names_the_alternatives_and_leaves_no_profile() {
    let home = Home::new();
    let found = "No Chromium-family browser found. Install Chrome, Chromium, Brave, or Edge, or set ABLER_BROWSER/--browser to its executable. Use 'abler-mcp auth capture <URL>' or 'abler-mcp auth import <file>'.\n";
    let run = |args: &[&str], browser: Option<&str>| {
        let mut command = home.command("http://127.0.0.1:9", args);
        // No PATH, so nothing is discovered; the profile directory is this test's own.
        command.env("TMPDIR", &home.0).stdin(Stdio::null());

        if let Some(browser) = browser {
            command.env("ABLER_BROWSER", browser);
        }
        command.output().unwrap()
    };

    // Without an override, macOS looks in /Applications rather than PATH, so a Mac with Chrome
    // installed finds it; the unit tests cover that list. Discovery cases run elsewhere only.
    let discovers = !cfg!(target_os = "macos");
    for (args, browser, discovery) in [
        (&["auth", "login"][..], None, true),
        (&["auth", "login"], Some("/nonexistent/chrome"), false),
        // A directory, and a file that is not executable, are not browsers.
        (&["auth", "login", "--browser", "/"], None, false),
        (
            &["auth", "login", "--browser", "/etc/hostname"],
            Some("/bin/sh"),
            false,
        ),
        (&["auth", "login", "--browser="], None, true),
    ] {
        if discovery && !discovers {
            continue;
        }
        let output = run(args, browser);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert_eq!(String::from_utf8_lossy(&output.stderr), found, "{args:?}");
        assert!(output.stdout.is_empty());
    }
    let left: Vec<_> = fs::read_dir(&home.0)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn the_version_is_the_typescript_package_version() {
    let manifest = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/abler-mcp/package.json"),
    )
    .unwrap();
    let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));

    let output = Home::new().run(&["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
}

/// An upstream that accepts connections and never answers; reports each one.
fn hanging_upstream() -> (String, mpsc::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::channel();

    std::thread::spawn(move || {
        let mut held: Vec<TcpStream> = Vec::new();

        for stream in listener.incoming().flatten() {
            let _ = sender.send(());
            held.push(stream);
        }
    });
    (origin, receiver)
}

fn send(stdin: &mut ChildStdin, message: &str) {
    stdin.write_all(message.as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

/// Start the server and call auth_status, whose session refresh then hangs upstream.
fn serve_with_a_hanging_request(home: &Home) -> (Child, ChildStdin) {
    let (origin, connected) = hanging_upstream();
    let mut child = home
        .command(&origin, &["serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

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
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"auth_status","arguments":{}}}"#,
    );
    connected
        .recv_timeout(Duration::from_secs(10))
        .expect("the refresh reached upstream");
    // Drain the rest so the server never blocks on a full pipe.
    std::thread::spawn(move || {
        let _ = stdout.read_to_end(&mut Vec::new());
    });
    (child, stdin)
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
fn sigterm_and_end_of_input_cancel_a_hanging_request_and_release_the_lock() {
    for stop in ["sigterm", "eof"] {
        let home = Home::new();
        home.legacy();
        let started = Instant::now();
        let (mut child, stdin) = serve_with_a_hanging_request(&home);

        match stop {
            "sigterm" => kill_process(Pid::from_child(&child), Signal::TERM).unwrap(),
            _ => drop(stdin),
        }
        // Well inside the 20 s request deadline: the request was cancelled, not timed out.
        assert_eq!(
            exits_within(&mut child, Duration::from_secs(5)),
            Some(0),
            "{stop}"
        );
        assert!(started.elapsed() < Duration::from_secs(15), "{stop}");

        // The session lock was released: logout takes it at once and removes the session file.
        let output = home.run(&["auth", "logout"]);
        assert!(
            output.status.success(),
            "{stop}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!home.0.join("legacy.json").exists());
    }
}

/// fetch under Bun reads up to 256 response headers; hyper's default of 100 would fail the request.
#[test]
fn a_response_with_as_many_headers_as_fetch_accepts_is_read() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let body = r#"{"data":{"me":{"id":"1","displayName":"A"}}}"#;
    // Content-Length and Connection make 256.
    let extra: String = (0..254).map(|index| format!("X-H{index}: a\r\n")).collect();
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    );

    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    let home = Home::new();
    home.legacy_with(
        r#"{"version":1,"cookies":[{"name":"refreshToken","value":"r0","domain":"www.abler.io","path":"/oauth","expires":-1},{"name":"id_token","value":"a0","domain":"www.abler.io","path":"/","expires":-1}]}"#,
    );
    let output = home.command(&origin, &["auth", "status"]).output().unwrap();

    assert!(
        String::from_utf8_lossy(&output.stdout).contains(r#""authenticated":true"#),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
