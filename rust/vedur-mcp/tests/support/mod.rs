//! A loopback IMO (api.vedur.is and gottvedur.is under one origin), the binary driven over
//! stdio as an MCP host drives it, and the subset of JSON Schema the surface uses.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

pub fn fixture_json(name: &str) -> Value {
    serde_json::from_slice(&fixture(name)).unwrap()
}

/// What the fake answers.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Duration,
}

impl Reply {
    pub fn body(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), content_type.into())],
            body,
            delay: Duration::ZERO,
        }
    }

    pub fn json(body: Vec<u8>) -> Self {
        Self::body(200, "application/json", body)
    }

    pub fn fixture(name: &str) -> Self {
        let content_type = if name.ends_with(".xml") {
            "text/xml"
        } else {
            "application/json"
        };
        Self::body(200, content_type, fixture(name))
    }

    pub fn status(status: u16) -> Self {
        Self::body(status, "text/plain", b"SECRET-UPSTREAM-TEXT".to_vec())
    }

    /// The connection closes once the request was read.
    pub fn dropped() -> Self {
        Self::status(0)
    }

    pub fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

type Handler = Box<dyn Fn(&str, usize) -> Reply + Send + Sync>;

/// The fake. The handler gets each request's path (with its query) and how many requests came
/// before it; every request is recorded.
pub struct Upstream {
    pub origin: String,
    seen: Arc<Mutex<Vec<String>>>,
    versions: Arc<Mutex<Versions>>,
}

/// Each request's path with its `x-vi-api-version` header.
type Versions = Vec<(String, Option<String>)>;

impl Upstream {
    pub fn new(handler: impl Fn(&str, usize) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let versions = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(Box::new(handler));
        let (record, record_versions) = (seen.clone(), versions.clone());

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let (record, record_versions, handler) =
                    (record.clone(), record_versions.clone(), handler.clone());
                std::thread::spawn(move || serve(stream, &record, &record_versions, &handler));
            }
        });
        Self {
            origin,
            seen,
            versions,
        }
    }

    /// Each request's path with its `x-vi-api-version` header, in arrival order.
    pub fn api_versions(&self) -> Versions {
        self.versions.lock().unwrap().clone()
    }

    /// Every request path so far, in arrival order.
    pub fn seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn serve(
    stream: TcpStream,
    seen: &Mutex<Vec<String>>,
    versions: &Mutex<Versions>,
    handler: &Handler,
) {
    let mut reader = BufReader::new(stream);
    let mut head = Vec::new();

    while !head.ends_with(b"\r\n\r\n") {
        let mut line = Vec::new();

        if reader.read_until(b'\n', &mut line).unwrap_or(0) == 0 {
            return;
        }
        head.extend(line);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut start = head.split("\r\n").next().unwrap_or_default().split(' ');
    let method = start.next().unwrap_or_default().to_owned();
    let path = start.next().unwrap_or_default().to_owned();
    assert_eq!(method, "GET", "vedur-mcp only reads");
    let user_agent = head.split("\r\n").find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("user-agent:")
            .map(str::to_owned)
    });
    assert!(
        user_agent.is_some_and(|agent| agent.contains("vedur-mcp/")
            && agent.contains("github.com/olafurns7/family-mcp")),
        "polite user agent"
    );
    let version = head.split("\r\n").find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("x-vi-api-version")
            .then(|| value.trim().to_owned())
    });
    let reply = {
        versions.lock().unwrap().push((path.clone(), version));
        let mut seen = seen.lock().unwrap();
        seen.push(path.clone());
        handler(&path, seen.len() - 1)
    };
    std::thread::sleep(reply.delay);
    let stream = reader.get_mut();

    if reply.status == 0 {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    let mut out = format!("HTTP/1.1 {} Status\r\nConnection: close\r\n", reply.status);

    for (name, value) in &reply.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\n\r\n", reply.body.len()));
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.write_all(&reply.body);
    let _ = stream.flush();
}

/// The binary over stdio, initialized.
pub struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

pub const NOW: &str = "2026-10-13T10:00:00Z";

impl Mcp {
    pub fn start(upstream: &Upstream) -> Self {
        Self::start_with(upstream, &[("VEDUR_TEST_NOW", NOW)])
    }

    pub fn start_with(upstream: &Upstream, env: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_vedur-mcp"));
        command
            .arg("serve")
            .env_clear()
            .env("VEDUR_TEST_ORIGIN", &upstream.origin)
            .env("VEDUR_TEST_ATTEMPT_TIMEOUT_MS", "1500");

        for (name, value) in env {
            command.env(name, value);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut mcp = Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        };
        let init = mcp.request(
            "initialize",
            json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}),
        );
        assert_eq!(init["result"]["serverInfo"]["name"], "vedur-mcp");
        assert_eq!(
            init["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        assert!(
            init["result"]["instructions"]
                .as_str()
                .is_some_and(|text| text.contains("never an empty result"))
        );
        mcp.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        mcp
    }

    fn send(&mut self, message: &Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    pub fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));

        loop {
            let mut line = String::new();
            assert!(
                self.stdout.read_line(&mut line).unwrap() > 0,
                "the server closed stdout"
            );
            let message: Value = serde_json::from_str(&line).unwrap();

            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    pub fn tools(&mut self) -> Vec<Value> {
        self.request("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .clone()
    }

    /// The `tools/call` result.
    pub fn call(&mut self, name: &str, arguments: Value) -> Value {
        let response = self.request("tools/call", json!({"name": name, "arguments": arguments}));
        response["result"].clone()
    }

    /// A successful call's structured content, checked against the tool's output schema.
    pub fn ok(&mut self, name: &str, arguments: Value) -> Value {
        let result = self.call(name, arguments);
        assert_ne!(result["isError"], true, "{result}");
        let structured = result["structuredContent"].clone();
        assert_eq!(
            result["content"][0]["text"]
                .as_str()
                .map(|text| serde_json::from_str::<Value>(text).unwrap()),
            Some(structured.clone())
        );
        let schema = self
            .tools()
            .into_iter()
            .find(|tool| tool["name"] == name)
            .unwrap()["outputSchema"]
            .clone();
        let mut problems = Vec::new();
        validate(&schema, &structured, "$", &mut problems);
        assert!(problems.is_empty(), "{name}: {problems:?}");
        structured
    }

    /// A failed call's only text.
    pub fn error(&mut self, name: &str, arguments: Value) -> String {
        let result = self.call(name, arguments);
        assert_eq!(result["isError"], true, "{result}");
        assert!(result.get("structuredContent").is_none());
        let text = result["content"][0]["text"].as_str().unwrap().to_owned();
        assert!(!text.contains("SECRET-UPSTREAM-TEXT"), "{text}");
        text
    }

    /// Closes stdin and returns what the server wrote to stderr.
    pub fn finish(mut self) -> String {
        drop(self.stdin);
        let status = self.child.wait().unwrap();
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "{stderr}");
        stderr
    }
}

/// The JSON Schema keywords the surface may use; validate() understands exactly these.
pub const KEYWORDS: [&str; 11] = [
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "additionalProperties",
    "description",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
];

fn type_matches(kind: &str, value: &Value) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        _ => panic!("unknown type {kind}"),
    }
}

pub fn validate(schema: &Value, value: &Value, at: &str, problems: &mut Vec<String>) {
    let schema = schema.as_object().unwrap();

    for key in schema.keys() {
        assert!(
            KEYWORDS.contains(&key.as_str()),
            "unsupported keyword {key} at {at}"
        );
    }

    if let Some(kind) = schema.get("type") {
        let kinds: Vec<&str> = match kind {
            Value::String(kind) => vec![kind],
            Value::Array(kinds) => kinds.iter().map(|kind| kind.as_str().unwrap()).collect(),
            _ => panic!("bad type at {at}"),
        };

        if !kinds.iter().any(|kind| type_matches(kind, value)) {
            problems.push(format!("{at}: expected {kinds:?}, got {value}"));
            return;
        }
    }

    if let Some(Value::Array(options)) = schema.get("enum")
        && !options.contains(value)
    {
        problems.push(format!("{at}: {value} not in enum"));
    }

    if let Value::Object(object) = value {
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(Map::new);

        for required in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !object.contains_key(required.as_str().unwrap()) {
                problems.push(format!("{at}: missing {required}"));
            }
        }

        for (key, item) in object {
            match (properties.get(key), schema.get("additionalProperties")) {
                (Some(property), _) => validate(property, item, &format!("{at}.{key}"), problems),
                (None, Some(Value::Bool(false))) => {
                    problems.push(format!("{at}: unexpected {key}"))
                }
                (None, Some(additional @ Value::Object(_))) => {
                    validate(additional, item, &format!("{at}.{key}"), problems)
                }
                _ => {}
            }
        }
    }

    if let (Value::Array(items), Some(item_schema)) = (value, schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            validate(item_schema, item, &format!("{at}[{index}]"), problems);
        }
    }
}
