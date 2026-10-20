//! infomentor_get_attendance against a local fake upstream: a CLI login, then `serve` over
//! stdio. Needs the `test-origin` feature, without which the binary would talk to InfoMentor. All
//! data is synthetic.
#![cfg(feature = "test-origin")]

mod scratch;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

const HOME: &str = r#"<script>IMHome.home.homeData = {"account":{"currentUser":{"id":"parent"},"pupils":[{"id":"child","name":"Child","selected":true,"switchPupilUrl":null}]},"apps":[]}; IMHome.home.init(IMHome.home.homeData);</script>"#;

const LIST: &str = r#"{"page":1,"pageSize":2,"totalItems":3,"more":true,"items":[
  {"id":11,"shortDate":"05.01.2026","longDate":"Monday, 5. January 2026","time":"08:10","subject":"Class time",
   "reason":"Late","comment":"","registeredByName":"Teacher","establishmentName":null,"minutes":"7","halfDaysCount":null,"extra":1},
  {"id":"malformed"},
  {"id":10,"shortDate":"02.01.2026","reason":"Absent","minutes":40,"halfDaysCount":1}
]}"#;

/// Answers one request and logs it as `METHOD target body`.
fn handle(stream: TcpStream, log: &Mutex<Vec<String>>) {
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
        ("POST", "/minn.infomentor.is/attendance/attendance/GetAttendanceList") => {
            (200, vec![], LIST)
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

/// A signed-in `serve` process against a fake upstream.
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    log: Arc<Mutex<Vec<String>>>,
    next: u64,
    _home: scratch::Scratch,
}

impl Mcp {
    fn start(name: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let log = Arc::new(Mutex::new(Vec::new()));
        let shared = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                handle(stream, &shared);
            }
        });
        let home = scratch::Scratch::new(&format!("attendance-{name}"));
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
            json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "attendance", "version": "1"}}),
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

    /// The attendance requests the fake saw.
    fn attendance_requests(&self) -> Vec<String> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|request| request.contains("/attendance/"))
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
fn attendance_reads_one_page_with_every_field_and_counts_as_text() {
    let mut mcp = Mcp::start("page");
    let page = mcp.call(
        "infomentor_get_attendance",
        json!({"page": 2, "pageSize": 2}),
    );
    let row = |id: i64, date: &str| {
        json!({"id": id, "shortDate": date, "longDate": null, "time": null, "subject": null,
               "reason": null, "comment": null, "registeredByName": null,
               "establishmentName": null, "minutes": null, "halfDaysCount": null})
    };
    let mut late = row(11, "05.01.2026");
    late["longDate"] = json!("Monday, 5. January 2026");
    late["time"] = json!("08:10");
    late["subject"] = json!("Class time");
    late["reason"] = json!("Late");
    late["comment"] = json!("");
    late["registeredByName"] = json!("Teacher");
    late["minutes"] = json!("7");
    let mut absent = row(10, "02.01.2026");
    absent["reason"] = json!("Absent");
    absent["minutes"] = json!("40");
    absent["halfDaysCount"] = json!("1");
    assert_eq!(
        page["structuredContent"],
        json!({
            "attendance": [late, absent],
            "page": 2,
            "pageSize": 2,
            "totalItems": 3,
            "more": true,
            "skipped": 1,
            "retrievedAt": page["structuredContent"]["retrievedAt"],
        }),
        "{page}"
    );
    assert_eq!(
        mcp.attendance_requests(),
        ["POST /minn.infomentor.is/attendance/attendance/GetAttendanceList page=2&pageSize=2"]
    );
}

#[test]
fn invalid_attendance_input_is_refused_before_any_request() {
    let mut mcp = Mcp::start("invalid");
    for arguments in [
        json!({"page": 0}),
        json!({"pageSize": 101}),
        json!({"unknown": 1}),
    ] {
        let answer = mcp.request(
            "tools/call",
            json!({"name": "infomentor_get_attendance", "arguments": arguments}),
        );
        let refused = answer["result"]["isError"] == true || answer.get("error").is_some();
        assert!(refused, "{arguments}: {answer}");
    }
    assert!(mcp.attendance_requests().is_empty());
}
