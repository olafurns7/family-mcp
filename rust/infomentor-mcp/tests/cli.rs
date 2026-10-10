//! Behavior parity.rs cannot compare with the TypeScript package: the version, the test build's
//! refusal of a non-local upstream, and the proxy variables Bun's fetch honours.
#![cfg(feature = "test-origin")]

use std::fs::{self, DirBuilder};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let name = format!(
            "infomentor-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(name);
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    fn command(&self, origin: Option<&str>, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_infomentor-mcp"));
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join(".config"))
            .env("XDG_DATA_HOME", self.0.join(".local/share"))
            .env("FAMILY_MCP_STORE_TEST_SEAM", "1")
            .stdin(Stdio::null());

        if let Some(origin) = origin {
            command.env("INFOMENTOR_TEST_ORIGIN", origin);
        }
        command
    }

    fn run(&self, origin: Option<&str>, args: &[&str]) -> Output {
        self.command(origin, args).output().unwrap()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn the_version_is_the_typescript_package_version() {
    let manifest = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/infomentor-mcp/package.json"),
    )
    .unwrap();
    let package: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));

    let output = Home::new().run(None, &["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn the_test_build_refuses_to_start_without_a_local_upstream() {
    let home = Home::new();

    for origin in [
        None,
        Some("https://minn.infomentor.is"),
        Some("http://localhost:9"),
    ] {
        let output = home.run(origin, &["status"]);
        assert!(!output.status.success(), "{origin:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("INFOMENTOR_TEST_ORIGIN must be local."),
            "{origin:?}"
        );
    }
    // Nothing was created: the refusal comes before the store is touched.
    assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
}

#[test]
fn requests_go_through_the_proxy_in_http_proxy() {
    let home = Home::new();
    let session = home.0.join("session.json");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&session)
        .unwrap()
        .write_all(br#"{"version":2,"savedAt":"2026-09-01T00:00:00.000Z","cookies":[{"key":"IMHome","value":"synthetic","domain":"minn.infomentor.is","path":"/","secure":true,"httpOnly":true,"hostOnly":true,"creation":"2026-09-01T00:00:00.000Z","lastAccessed":"2026-09-01T00:00:00.000Z"}]}"#)
        .unwrap();
    let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = proxy.local_addr().unwrap();
    let seen = std::thread::spawn(move || {
        let (stream, _) = proxy.accept().unwrap();
        let mut request = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        request.read_line(&mut line).unwrap();
        (&stream)
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        line
    });
    // The test origin is a closed port: only the proxy can answer.
    let output = home
        .command(
            Some("http://127.0.0.1:9"),
            &["status", "--session", "session.json"],
        )
        .current_dir(&home.0)
        .env("HTTP_PROXY", format!("http://{address}"))
        .output()
        .unwrap();
    assert_eq!(
        seen.join().unwrap(),
        "GET http://127.0.0.1:9/minn.infomentor.is/ HTTP/1.1\r\n"
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "InfoMentor returned an error. Try again later.\n"
    );
}
