//! infomentor_get_journal against a local fake upstream: a CLI login, then `serve` over stdio.
//! Needs the `test-origin` feature, without which the binary would talk to InfoMentor. All data
//! is synthetic.
#![cfg(feature = "test-origin")]

mod scratch;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

/// What `documentation/documentation/appData` answers.
#[derive(Clone, Copy, PartialEq)]
enum AppData {
    /// Journal tab enabled and a list URL of its own.
    Named,
    /// A failed read: the known endpoint is used.
    Missing,
    /// No journal tab in `tabs`.
    Denied,
}

const HOME: &str = r#"<script>IMHome.home.homeData = {"account":{"currentUser":{"id":"parent"},"pupils":[{"id":"child","name":"Child","selected":true,"switchPupilUrl":null}]},"apps":[]}; IMHome.home.init(IMHome.home.homeData);</script>"#;

const JOURNAL: &str = r#"{"entries":[
  {"id":2,"date":"09.01.2026","time":"08:30","author":"Teacher","categories":["Praise"," "],
   "text":"<p>Good work in class.</p><p>See <a href=\"https://notes.example/item\">note</a>.</p><script>ignored()</script>",
   "attachments":[{"title":"Worksheet","url":"/Resources/Resource/Download/7"},{"title":"Elsewhere","url":"https://files.example/x.pdf"}],"extra":1},
  {"id":"malformed"},
  {"id":1,"text":"<div><p>Older note</p></div>","author":null}
]}"#;

/// Answers one request and logs it as `METHOD target body`.
fn handle(stream: TcpStream, mode: AppData, log: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(&stream);
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let mut parts = first.split_whitespace();
    let (method, target) = (parts.next().unwrap(), parts.next().unwrap());
    let body = String::from_utf8(body).unwrap();
    log.lock()
        .unwrap()
        .push(format!("{method} {target} {body}").trim_end().to_owned());

    let im1 = "/im1.infomentor.is/production/mentor/";
    let minn = "https://minn.infomentor.is";
    let (status, headers, body): (u16, Vec<String>, &str) = match (method, target) {
        ("GET", path) if path == im1 => (
            200,
            vec!["Set-Cookie: preflight=ok; Path=/; Secure; HttpOnly".into()],
            r#"<form method="POST" action="./"><input type="hidden" name="__VIEWSTATE" value="s"><input type="hidden" name="__EVENTVALIDATION" value="v"></form>"#,
        ),
        ("POST", path) if path == im1 && body.contains("oauth_token") => (
            303,
            vec![
                format!("Location: {minn}/Authentication/Authentication/LoginCallback"),
                "Set-Cookie: relay=ok; Path=/; Secure; HttpOnly".into(),
            ],
            "",
        ),
        ("POST", path) if path == im1 => (
            302,
            vec![format!(
                "Location: {minn}/authentication/authentication/login"
            )],
            "",
        ),
        ("GET", "/minn.infomentor.is/authentication/authentication/login") => (
            200,
            vec![],
            r#"<form id="openid_message" method="post" action="https://im1.infomentor.is/production/mentor/"><input type="hidden" name="oauth_token" value="t"></form>"#,
        ),
        ("GET", "/minn.infomentor.is/Authentication/Authentication/LoginCallback") => (
            307,
            vec![
                format!("Location: {minn}/"),
                "Set-Cookie: IMHome=ok; Path=/; Secure; HttpOnly".into(),
            ],
            "",
        ),
        ("GET", "/minn.infomentor.is/") => (200, vec![], HOME),
        ("POST", "/minn.infomentor.is/authentication/authentication/isauthenticated/") => {
            (200, vec![], "true")
        }
        ("POST", "/minn.infomentor.is/documentation/documentation/appData") => match mode {
            AppData::Named => (
                200,
                vec![],
                r#"{"tabs":["portfolio","journal"],"urls":{"getJournalList":"/Documentation/Journal/NamedList"}}"#,
            ),
            AppData::Missing => (404, vec![], "missing"),
            AppData::Denied => (200, vec![], r#"{"tabs":["portfolio"],"urls":{}}"#),
        },
        ("POST", "/minn.infomentor.is/Documentation/Journal/NamedList")
            if mode == AppData::Named =>
        {
            (200, vec![], JOURNAL)
        }
        ("POST", "/minn.infomentor.is/Documentation/Journal/GetJournalList")
            if mode == AppData::Missing =>
        {
            (200, vec![], JOURNAL)
        }
        _ => (404, vec![], "unexpected"),
    };
    let kind = if body.starts_with('<') {
        "text/html"
    } else {
        "application/json"
    };
    let mut head = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for header in headers {
        head.push_str(&header);
        head.push_str("\r\n");
    }
    (&stream)
        .write_all(format!("{head}\r\n{body}").as_bytes())
        .unwrap();
}

/// A signed-in `serve` process against a fake upstream answering app data as `mode`.
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    log: Arc<Mutex<Vec<String>>>,
    next: u64,
    _home: scratch::Scratch,
}

impl Mcp {
    fn start(name: &str, mode: AppData) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let log = Arc::new(Mutex::new(Vec::new()));
        let shared = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                handle(stream, mode, &shared);
            }
        });
        let home = scratch::Scratch::new(&format!("journal-{name}"));
        let command = |args: &[&str]| {
            let mut command = Command::new(env!("CARGO_BIN_EXE_infomentor-mcp"));
            command
                .args(args)
                .env("INFOMENTOR_TEST_ORIGIN", &origin)
                .env_remove("INFOMENTOR_USERNAME")
                .env_remove("INFOMENTOR_PASSWORD");
            home.isolate(&mut command);
            command
        };
        let login = command(&["login"])
            .env("INFOMENTOR_USERNAME", "synthetic-user")
            .env("INFOMENTOR_PASSWORD", "synthetic-password")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(login.status.success(), "{login:?}");

        let mut child = command(&["serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut mcp = Self {
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            child,
            log,
            next: 1,
            _home: home,
        };
        mcp.request(
            "initialize",
            json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "journal", "version": "1"}}),
        );
        writeln!(
            mcp.stdin,
            r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
        )
        .unwrap();
        mcp
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{request}").unwrap();
        loop {
            let mut line = String::new();
            assert!(self.stdout.read_line(&mut line).unwrap() > 0, "serve ended");
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["id"] == id {
                return message;
            }
        }
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name": name, "arguments": arguments}))["result"].clone()
    }

    /// The journal list requests the fake saw.
    fn journal_requests(&self) -> Vec<String> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|request| request.contains("/Documentation/Journal/"))
            .cloned()
            .collect()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn journal_uses_the_app_data_url_as_plain_text_with_trusted_attachments_only() {
    let mut mcp = Mcp::start("named", AppData::Named);

    let list = mcp.call("infomentor_get_journal", json!({"limit": 1, "pageSize": 5}));
    assert_eq!(
        list["structuredContent"],
        json!({
            "entries": [{
                "id": 2,
                "date": "09.01.2026",
                "time": "08:30",
                "author": "Teacher",
                "categories": ["Praise"],
                "text": "Good work in class.\n\nSee note (https://notes.example/item).",
                "textTruncated": false,
                "attachments": [{"title": "Worksheet", "url": "https://minn.infomentor.is/Resources/Resource/Download/7"}],
                "attachmentsOmitted": 1,
            }],
            "total": 2,
            "skipped": 1,
            "hasJournalAccess": true,
            "retrievedAt": list["structuredContent"]["retrievedAt"],
        }),
        "{list}"
    );
    assert_eq!(
        mcp.journal_requests(),
        ["POST /minn.infomentor.is/Documentation/Journal/NamedList pageSize=5"]
    );
}

#[test]
fn journal_falls_back_to_the_known_endpoint_without_app_data() {
    let mut mcp = Mcp::start("fallback", AppData::Missing);
    let list = mcp.call("infomentor_get_journal", json!({}));
    assert_eq!(
        list["structuredContent"]["hasJournalAccess"],
        Value::Null,
        "{list}"
    );
    assert_eq!(list["structuredContent"]["total"], 2);
    assert_eq!(
        list["structuredContent"]["entries"][1]["text"],
        "Older note"
    );
    assert_eq!(
        mcp.journal_requests(),
        ["POST /minn.infomentor.is/Documentation/Journal/GetJournalList"]
    );
}

#[test]
fn journal_is_empty_without_journal_access_and_never_requested() {
    let mut mcp = Mcp::start("denied", AppData::Denied);
    let list = mcp.call("infomentor_get_journal", json!({}));
    assert_eq!(
        list["structuredContent"]["hasJournalAccess"], false,
        "{list}"
    );
    assert_eq!(list["structuredContent"]["entries"], json!([]));
    assert!(mcp.journal_requests().is_empty());
}

#[test]
fn invalid_journal_input_is_refused_before_any_request() {
    let mut mcp = Mcp::start("invalid", AppData::Named);
    for arguments in [
        json!({"limit": 0}),
        json!({"pageSize": 201}),
        json!({"unknown": 1}),
    ] {
        let answer = mcp.request(
            "tools/call",
            json!({"name": "infomentor_get_journal", "arguments": arguments}),
        );
        let refused = answer["result"]["isError"] == true || answer.get("error").is_some();
        assert!(refused, "{arguments}: {answer}");
    }
    assert!(mcp.journal_requests().is_empty());
}
