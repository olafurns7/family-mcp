//! What the frozen-fixture replay and the executing tests share: a scratch home laid out as
//! tests/ts/parity.ts laid out its own, a loopback Abler that records every request, a scripted
//! mode that serves recorded exchanges in order, the binary's CLI and a raw JSON-RPC client for
//! `serve`, and the normalizations the TypeScript freeze applied
//! (tooling/ts-freeze/abler-parity.ts). No test here needs Bun.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::fs::{self, DirBuilder};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use family_store::{
    SecretRecordOptions, StoreEnvironment, default_secret_record_path_in, key_provider_in,
    with_secret_store,
};
use serde_json::{Map, Value, json};

pub const BINARY: &str = env!("CARGO_BIN_EXE_abler-mcp");

/// How long one answer, one exit or one request may take before a test fails instead of hanging.
pub const PATIENCE: Duration = Duration::from_secs(60);

/// The store's record bound, as parity.ts and src/auth.rs set it.
pub const RECORD_MAX_BYTES: usize = 262_144 * 2 + 4096;

/// The headers parity.ts recorded of each request (`null` when absent).
pub const COMPARED: [&str; 4] = ["cookie", "accept", "content-type", "content-length"];

/// How far a cookie expiry may lie from a case's start and still be one the fake set (40 days).
const RELATIVE_SPAN_MS: f64 = 40.0 * 24.0 * 3600.0 * 1000.0;

/// A private home for one case, removed on drop, with its temporary folder `<home>.tmp` beside it
/// so no listing of the home holds it. Its path is canonical.
pub struct Home(pub PathBuf);

impl Home {
    pub fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "abler-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        let home = Self(fs::canonicalize(path).unwrap());
        DirBuilder::new().mode(0o700).create(home.tmp()).unwrap();
        home
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    /// The temporary folder of the binary's runs.
    pub fn tmp(&self) -> PathBuf {
        let mut path = self.0.clone().into_os_string();
        path.push(".tmp");
        PathBuf::from(path)
    }

    /// parity.ts's `environment`: scratch XDG folders, the store test seam and the fake.
    pub fn environment(&self, origin: &str) -> Vec<(String, String)> {
        let home = self.0.display().to_string();
        vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.clone()),
            ("TMPDIR".into(), self.tmp().display().to_string()),
            ("XDG_CONFIG_HOME".into(), format!("{home}/.config")),
            ("XDG_DATA_HOME".into(), format!("{home}/.local/share")),
            ("XDG_STATE_HOME".into(), format!("{home}/.local/state")),
            ("XDG_CACHE_HOME".into(), format!("{home}/.cache")),
            ("FAMILY_MCP_STORE_TEST_SEAM".into(), "1".into()),
            ("ABLER_TEST_ORIGIN".into(), origin.into()),
        ]
    }

    /// A command for the binary in this home, with nothing inherited from the test's environment.
    pub fn command(&self, origin: &str, extra: &[(String, String)], args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .current_dir(&self.0)
            .env_clear()
            .envs(self.environment(origin))
            .envs(extra.iter().cloned());
        command
    }

    /// parity.ts's `write`: a file with its folders (0700) and `mode`.
    pub fn write(&self, relative: &str, text: &str, mode: u32) {
        let path = self.path(relative);
        DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(path.parent().unwrap())
            .unwrap();
        fs::write(&path, text).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    }

    pub fn chmod(&self, relative: &str, mode: u32) {
        fs::set_permissions(self.path(relative), fs::Permissions::from_mode(mode)).unwrap();
    }

    /// The store options the binary uses in this home: the default record and key file.
    pub fn store_options(&self) -> SecretRecordOptions {
        family_store::enable_test_seam();
        let environment = StoreEnvironment {
            os: std::env::consts::OS.to_owned(),
            home: Some(self.0.clone()),
            xdg_config_home: Some(self.0.join(".config").into_os_string()),
            xdg_data_home: Some(self.0.join(".local/share").into_os_string()),
            key_backend: None,
            test_seam: true,
        };
        SecretRecordOptions::new(
            default_secret_record_path_in(&environment, "abler-mcp").unwrap(),
            "abler-mcp",
            "default",
            "session",
            1,
            key_provider_in(&environment, "abler-mcp", "default").unwrap(),
            RECORD_MAX_BYTES,
        )
    }

    /// The freeze's `stored`: `{"store": "none"}`, `{"record": value}` (`null` once logged out)
    /// named as the freeze named it, or `{"error": CODE}`.
    pub fn stored(&self, names: &Names) -> Value {
        let options = self.store_options();
        let mut marker = options.path.clone().into_os_string();
        marker.push(".marker");

        if !options.path.exists() && !Path::new(&marker).exists() {
            return json!({"store": "none"});
        }
        match with_secret_store(&options, |store| store.read()) {
            Ok(Some(record)) => json!({ "record": names.text(&record) }),
            Ok(None) => json!({ "record": null }),
            Err(error) => json!({ "error": error.code.as_str() }),
        }
    }

    /// The decrypted record text as the binary left it (`null` once logged out), if any.
    pub fn record(&self) -> Option<String> {
        with_secret_store(&self.store_options(), |store| store.read()).unwrap()
    }

    /// Every path under the home, relative, in no particular order.
    fn walk(&self) -> Vec<PathBuf> {
        fn walk(root: &Path, directory: &Path, paths: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                paths.push(path.strip_prefix(root).unwrap().to_path_buf());

                if fs::symlink_metadata(&path).unwrap().is_dir() {
                    walk(root, &path, paths);
                }
            }
        }
        let mut paths = Vec::new();
        walk(&self.0, &self.0, &mut paths);
        paths
    }

    /// The freeze's `files`: every path with its permission bits (a directory ends in `/`), in
    /// JavaScript's default sort order.
    pub fn files(&self, names: &Names) -> Value {
        let mut entries: Vec<String> = self
            .walk()
            .into_iter()
            .map(|relative| {
                let info = fs::symlink_metadata(self.0.join(&relative)).unwrap();
                let mode = format!("{:o}", info.permissions().mode() & 0o777);
                let path = names.fresh(&relative.display().to_string());
                match info.is_dir() {
                    true => format!("{path}/ {mode}"),
                    false => format!("{path} {mode}"),
                }
            })
            .collect();
        entries.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        json!(entries)
    }

    /// The freeze's `texts`: every regular file but the store's record and key, by path, a JSON
    /// text named as the freeze named it, any other text as it is.
    pub fn texts(&self, names: &Names) -> Value {
        let mut paths: Vec<String> = self
            .walk()
            .into_iter()
            .filter(|relative| {
                fs::symlink_metadata(self.0.join(relative))
                    .unwrap()
                    .is_file()
            })
            .map(|relative| relative.display().to_string())
            .filter(|path| {
                path != ".config/abler-mcp/session.enc"
                    && !path.starts_with(".local/share/family-mcp/keys/")
            })
            .collect();
        paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Value::Object(
            paths
                .into_iter()
                .map(|path| {
                    let text = fs::read_to_string(self.0.join(&path)).unwrap();
                    (names.fresh(&path), names.text(&text))
                })
                .collect(),
        )
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        // A test may leave a folder it closed; open it again so it can be removed.
        for relative in self.walk() {
            let path = self.0.join(relative);

            if path.is_dir() {
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o700));
            }
        }
        let _ = fs::remove_dir_all(&self.0);
        let _ = fs::remove_dir_all(self.tmp());
    }
}

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}

/// JavaScript's `Math.round`: halves round up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// The freeze's `Names`, per home: `<home>` for the home; in a JSON text, each cookie's `expires`
/// as `<now±Nks>` (its offset from the case's start in kiloseconds, rounded) when it lies within
/// 40 days of the start, otherwise `<at:S>` (S in whole seconds); and a candidate's random ID as
/// `<candidate-id>`.
#[derive(Clone)]
pub struct Names {
    home: String,
    start: f64,
}

impl Names {
    /// Names for `home`, the case starting now.
    pub fn new(home: &Home) -> Self {
        Self {
            home: home.0.display().to_string(),
            start: now(),
        }
    }

    pub fn fresh(&self, text: &str) -> String {
        text.replace(&self.home, "<home>")
    }

    pub fn expires(&self, seconds: f64) -> String {
        let offset = seconds * 1000.0 - self.start;

        match offset.abs() < RELATIVE_SPAN_MS {
            true => format!(
                "<now{}{}ks>",
                if offset < 0.0 { '-' } else { '+' },
                js_round(offset / 1_000_000.0).abs()
            ),
            false => format!("<at:{}>", js_round(seconds)),
        }
    }

    /// A JSON value with every `expires` named and candidate IDs hidden.
    pub fn named(&self, value: &Value) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.named(item)).collect())
            }
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, item)| {
                        let named = match (key.as_str(), item) {
                            ("expires", Value::Number(number)) => {
                                json!(self.expires(number.as_f64().unwrap()))
                            }
                            ("id", Value::String(id)) if uuid(id) => json!("<candidate-id>"),
                            _ => self.named(item),
                        };
                        (key.clone(), named)
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// A JSON text named, or any other text with the home named.
    pub fn text(&self, text: &str) -> Value {
        match serde_json::from_str::<Value>(text) {
            Ok(value) => self.named(&value),
            Err(_) => json!(self.fresh(text)),
        }
    }
}

/// zod's `z.uuid()`: an RFC 9562 UUID (versions 1 to 8), or the nil or max UUID.
fn uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    shaped
        && ((b'1'..=b'8').contains(&bytes[14])
            && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
            || text == "00000000-0000-0000-0000-000000000000"
            || text.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff"))
}

/// Fails if `text` holds a cookie assignment or a cookie value the fakes hand out: `r0` and its
/// rotations `rN`, the access tokens `aN`, `stale`, and the analytics `GA1`.
pub fn no_leak(text: &str, at: &str) {
    for assignment in ["refreshToken=", "id_token="] {
        assert!(
            !text.contains(assignment),
            "{at}: an output holds {assignment}: {text}"
        );
    }
    for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        let token = word
            .strip_prefix('a')
            .or_else(|| word.strip_prefix('r'))
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()));
        assert!(
            !(token || word == "GA1" || word == "stale"),
            "{at}: an output holds {word}: {text}"
        );
    }
}

/// One request as the fake saw it: the path with its query, and the compared headers (`null`
/// when absent).
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Map<String, Value>,
    pub body: String,
}

impl Request {
    pub fn json(&self) -> Value {
        json!({"method": self.method, "path": self.path, "headers": self.headers, "body": self.body})
    }

    /// `METHOD /path` without the query.
    pub fn line(&self) -> String {
        format!("{} {}", self.method, self.path.split('?').next().unwrap())
    }

    pub fn cookie(&self) -> &str {
        self.headers["cookie"].as_str().unwrap_or("")
    }
}

/// What the fake answers.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, body: &Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string().into_bytes(),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    /// No answer: the connection closes once the request was read, as a failed fetch.
    pub fn dropped() -> Self {
        Self::empty(0)
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// A frozen `{status, headers, body}` response; a header may hold several values.
    pub fn frozen(response: &Value) -> Self {
        let mut headers = Vec::new();

        for (name, value) in response["headers"].as_object().unwrap() {
            match value {
                Value::Array(values) => {
                    for value in values {
                        headers.push((name.clone(), value.as_str().unwrap().to_owned()));
                    }
                }
                value => headers.push((name.clone(), value.as_str().unwrap().to_owned())),
            }
        }
        Self {
            status: response["status"].as_u64().unwrap() as u16,
            headers,
            body: response["body"].as_str().unwrap().as_bytes().to_vec(),
        }
    }
}

type Handler = Box<dyn Fn(&Request) -> Reply + Send + Sync>;

/// A loopback Abler at the binary's test origin. Every request is recorded in arrival order and
/// answered by the handler; a loopback port scanner's bare `GET /` gets a 404 and no record. Each
/// answer closes its connection.
pub struct Upstream {
    pub origin: String,
    seen: Arc<(Mutex<Vec<Request>>, Condvar)>,
}

impl Upstream {
    pub fn new(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let handler: Arc<Handler> = Arc::new(Box::new(handler));
        let record = seen.clone();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let (record, handler) = (record.clone(), handler.clone());
                std::thread::spawn(move || serve(stream, &record, &handler));
            }
        });
        Self { origin, seen }
    }

    /// Every request so far, in arrival order.
    pub fn seen(&self) -> Vec<Request> {
        self.seen.0.lock().unwrap().clone()
    }

    /// `METHOD /path` per request, without the query.
    pub fn sent(&self) -> Vec<String> {
        self.seen().iter().map(Request::line).collect()
    }

    pub fn count(&self) -> usize {
        self.seen.0.lock().unwrap().len()
    }

    /// Waits, at most `patience`, until `count` requests have come; whether they did.
    pub fn until_count(&self, count: usize, patience: Duration) -> bool {
        let (lock, changed) = &*self.seen;
        let (_seen, timeout) = changed
            .wait_timeout_while(lock.lock().unwrap(), patience, |seen| seen.len() < count)
            .unwrap();
        !timeout.timed_out()
    }
}

fn serve(stream: TcpStream, seen: &(Mutex<Vec<Request>>, Condvar), handler: &Handler) {
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
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let method = start.next().unwrap_or_default().to_owned();
    let path = start.next().unwrap_or_default().to_owned();

    if method == "GET" && path == "/" {
        let _ = reader
            .get_mut()
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let mut found: Vec<(String, String)> = Vec::new();
    let mut length = 0;

    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();

        if name == "content-length" {
            length = value.parse().unwrap_or(0);
        }
        found.push((name, value));
    }
    // As the Fetch API joins a repeated header: `; ` for cookies, `, ` otherwise.
    let headers = COMPARED
        .iter()
        .map(|name| {
            let values: Vec<&str> = found
                .iter()
                .filter(|(found, _)| found == name)
                .map(|(_, value)| value.as_str())
                .collect();
            let joined = match values.is_empty() {
                true => Value::Null,
                false if *name == "cookie" => json!(values.join("; ")),
                false => json!(values.join(", ")),
            };
            ((*name).to_owned(), joined)
        })
        .collect();
    let mut body = vec![0; length];

    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let request = Request {
        method,
        path,
        headers,
        body: String::from_utf8(body).unwrap(),
    };
    {
        let (lock, changed) = seen;
        lock.lock().unwrap().push(request.clone());
        changed.notify_all();
    }
    let reply = handler(&request);

    if reply.status == 0 {
        let _ = reader.get_mut().shutdown(std::net::Shutdown::Both);
        return;
    }
    let mut out = format!("HTTP/1.1 {} Status\r\nConnection: close\r\n", reply.status);

    for (name, value) in &reply.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if !matches!(reply.status, 204 | 304) {
        out.push_str(&format!("Content-Length: {}\r\n", reply.body.len()));
    }
    out.push_str("\r\n");
    let stream = reader.get_mut();
    let _ = stream
        .write_all(out.as_bytes())
        .and_then(|()| stream.write_all(&reply.body));
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
    // Read to the end, so closing never resets a connection whose answer is still in flight.
    let _ = std::io::copy(reader.get_mut(), &mut std::io::sink());
}

/// One expected exchange: the request and its reply.
struct Expected {
    request: Value,
    reply: Reply,
}

#[derive(Default)]
struct ScriptState {
    queue: VecDeque<Expected>,
    failures: Vec<String>,
    served: usize,
}

/// A held reply: the fake has received the request to `path` and waits for `release`.
#[derive(Default)]
struct Gate {
    path: Option<String>,
    reached: bool,
    released: bool,
}

/// Expected exchanges, served in order: each request must equal the next one whole (method, path
/// with its query, the compared headers, body), or the fake records the difference, answers 599
/// and the test fails. Nothing else is allowed: parity.ts compared the TypeScript and Rust
/// request lists whole, so the binary adds no request of its own.
#[derive(Clone)]
pub struct Script {
    state: Arc<Mutex<ScriptState>>,
    gate: Arc<(Mutex<Gate>, Condvar)>,
    names: Names,
}

impl Script {
    pub fn new(names: Names) -> Self {
        Self {
            state: Arc::default(),
            gate: Arc::default(),
            names,
        }
    }

    /// A fake that serves this script.
    pub fn upstream(&self) -> Upstream {
        let script = self.clone();
        Upstream::new(move |request| script.answer(request))
    }

    /// What the fake answers `request`; the upstream's handler, public for the fake's own check.
    pub fn answer(&self, request: &Request) -> Reply {
        let seen: Value =
            serde_json::from_str(&self.names.fresh(&request.json().to_string())).unwrap();
        let reply = {
            let mut state = self.state.lock().unwrap();

            match state.queue.pop_front() {
                Some(expected) if expected.request == seen => {
                    state.served += 1;
                    expected.reply
                }
                Some(expected) => {
                    state
                        .failures
                        .push(format!("expected {}\n     got {seen}", expected.request));
                    Reply::empty(599)
                }
                None => {
                    state.failures.push(format!("unexpected request {seen}"));
                    Reply::empty(599)
                }
            }
        };
        let (lock, changed) = &*self.gate;
        let mut gate = lock.lock().unwrap();

        if gate.path.as_deref() == Some(request.path.split('?').next().unwrap()) {
            gate.reached = true;
            changed.notify_all();

            while !gate.released {
                gate = changed.wait(gate).unwrap();
            }
        }
        reply
    }

    /// Serve `exchanges` (frozen `{request, response}` values) next.
    pub fn expect(&self, exchanges: &Value) {
        let mut state = self.state.lock().unwrap();

        for exchange in exchanges.as_array().unwrap() {
            state.queue.push_back(Expected {
                request: exchange["request"].clone(),
                reply: Reply::frozen(&exchange["response"]),
            });
        }
    }

    /// Hold the reply to the next request for `path` (no query) until `release`.
    pub fn hold(&self, path: &str) {
        let (lock, _) = &*self.gate;
        *lock.lock().unwrap() = Gate {
            path: Some(path.to_owned()),
            ..Gate::default()
        };
    }

    /// Wait until the held request has reached the fake.
    pub fn reached(&self, at: &str) {
        let (lock, changed) = &*self.gate;
        let gate = lock.lock().unwrap();
        let (gate, timeout) = changed
            .wait_timeout_while(gate, PATIENCE, |gate| !gate.reached)
            .unwrap();
        assert!(
            !timeout.timed_out(),
            "{at}: the held request never came: {:?}",
            gate.path
        );
    }

    pub fn release(&self) {
        let (lock, changed) = &*self.gate;
        let mut gate = lock.lock().unwrap();
        gate.released = true;
        gate.path = None;
        changed.notify_all();
    }

    /// Fails unless every expected exchange was served and nothing else was asked.
    pub fn finish(&self, context: &str) {
        let mut state = self.state.lock().unwrap();
        let failures = std::mem::take(&mut state.failures);
        let left = state.queue.len();
        state.queue.clear();
        assert!(failures.is_empty(), "{context}:\n{}", failures.join("\n"));
        assert_eq!(left, 0, "{context}: {left} expected requests never came");
    }

    /// Recorded exchanges served.
    pub fn served(&self) -> usize {
        self.state.lock().unwrap().served
    }
}

/// A finished CLI run.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The binary's CLI in `home`, with `stdin` (none: an empty, closed input). It must exit within
/// [`PATIENCE`], or it is killed and the test fails.
pub fn cli(
    home: &Home,
    origin: &str,
    extra: &[(String, String)],
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Run {
    let mut child = home
        .command(origin, extra, args)
        .stdin(match stdin {
            None => Stdio::null(),
            Some(_) => Stdio::piped(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    if let Some(bytes) = stdin {
        let mut input = child.stdin.take().unwrap();
        let bytes = bytes.to_owned();
        std::thread::spawn(move || {
            let _ = input.write_all(&bytes);
        });
    }
    let stdout = Stream::read(child.stdout.take().unwrap());
    let stderr = Stream::read(child.stderr.take().unwrap());
    let Some(status) = wait(&mut child, PATIENCE) else {
        let _ = child.kill();
        let _ = child.wait();
        panic!("{args:?} did not exit within {PATIENCE:?}");
    };
    assert!(
        stdout.ended(PATIENCE) && stderr.ended(PATIENCE),
        "{args:?}: output never closed"
    );
    Run {
        code: status.code(),
        stdout: stdout.text(),
        stderr: stderr.text(),
    }
}

/// `abler-mcp serve` over raw newline-delimited JSON-RPC.
pub struct Mcp {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Stream>,
    next: u64,
}

/// What a child wrote on a pipe so far, and whether it has ended, with a wait on both.
#[derive(Default)]
pub struct Stream {
    state: Mutex<(Vec<u8>, bool)>,
    changed: Condvar,
}

impl Stream {
    /// Reads `pipe` to its end on a thread of its own.
    pub fn read(mut pipe: impl Read + Send + 'static) -> Arc<Self> {
        let stream = Arc::new(Self::default());
        let sink = stream.clone();

        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];

            while let Ok(read @ 1..) = pipe.read(&mut buffer) {
                sink.state
                    .lock()
                    .unwrap()
                    .0
                    .extend_from_slice(&buffer[..read]);
                sink.changed.notify_all();
            }
            sink.state.lock().unwrap().1 = true;
            sink.changed.notify_all();
        });
        stream
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.state.lock().unwrap().0).into_owned()
    }

    pub fn until(&self, patience: Duration, mut ready: impl FnMut(&str, bool) -> bool) -> bool {
        let state = self.state.lock().unwrap();
        let (_state, timeout) = self
            .changed
            .wait_timeout_while(state, patience, |(bytes, ended)| {
                !ready(&String::from_utf8_lossy(bytes), *ended)
            })
            .unwrap();
        !timeout.timed_out()
    }

    /// Waits, at most `patience`, for the end of the pipe; whether it came.
    pub fn ended(&self, patience: Duration) -> bool {
        self.until(patience, |_, ended| ended)
    }
}

/// The answer to one request, as the line the server wrote, and the notifications before it.
#[derive(Debug, Clone)]
pub struct Answer {
    pub notifications: Vec<String>,
    pub line: String,
}

impl Answer {
    pub fn value(&self) -> Value {
        serde_json::from_str(&self.line).unwrap()
    }

    /// A tool result's structured content, or its error text.
    pub fn outcome(&self) -> Result<Value, String> {
        let value = self.value();
        let result = &value["result"];

        match result["isError"] == true {
            true => Err(result["content"][0]["text"].as_str().unwrap().to_owned()),
            false => Ok(result["structuredContent"].clone()),
        }
    }
}

/// The protocol version and client the freeze sent.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": "2025-11-25",
        "capabilities": {},
        "clientInfo": {"name": "abler-parity", "version": "1.0.0"}
    })
}

/// How a process ended, as Bun's `exited` and `signalCode` report it.
pub fn ended(status: ExitStatus) -> Value {
    match (status.code(), status.signal()) {
        (Some(code), _) => json!({"exited": code, "signal": null}),
        (None, Some(signal)) => json!({"exited": 128 + signal, "signal": signal}),
        (None, None) => unreachable!(),
    }
}

impl Mcp {
    /// Start `serve` and initialize it, returning the initialize answer.
    pub fn start(home: &Home, origin: &str, extra: &[(String, String)]) -> (Self, Answer) {
        let mut mcp = Self::spawn(home.command(origin, extra, &["serve"]));
        mcp.next = 0;
        let initialized = mcp.request("initialize", initialize_params());
        mcp.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        (mcp, initialized)
    }

    /// Start `command` (a `serve`), uninitialized; its requests are numbered from 1.
    pub fn spawn(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, lines) = channel();

        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };

                if send.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr = Stream::read(child.stderr.take().unwrap());
        let stdin = child.stdin.take();
        Self {
            child,
            stdin,
            lines,
            stderr,
            next: 1,
        }
    }

    /// Write one message without waiting for an answer.
    pub fn send(&mut self, message: &Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{message}").unwrap();
        stdin.flush().unwrap();
    }

    /// Send a request without waiting for its answer; its id.
    pub fn begin(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        id
    }

    /// The next message that carries an id, with the notifications before it.
    pub fn answer(&mut self, context: &str) -> Answer {
        let mut notifications = Vec::new();

        loop {
            let line = self
                .lines
                .recv_timeout(PATIENCE)
                .unwrap_or_else(|error| panic!("no answer to {context}: {error}"));

            if line.trim().is_empty() {
                continue;
            }
            let message: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(message["jsonrpc"], "2.0", "{line}");

            match message.get("id") {
                None => notifications.push(line),
                Some(_) => {
                    return Answer {
                        notifications,
                        line,
                    };
                }
            }
        }
    }

    /// Send one request and wait for its answer, which must carry its id.
    pub fn request(&mut self, method: &str, params: Value) -> Answer {
        let id = self.begin(method, params);
        let answer = self.answer(method);
        assert_eq!(answer.value()["id"], json!(id), "{}", answer.line);
        answer
    }

    pub fn call(&mut self, name: &str, arguments: Value) -> Answer {
        self.request("tools/call", json!({"name": name, "arguments": arguments}))
    }

    pub fn end_input(&mut self) {
        drop(self.stdin.take());
    }

    /// Send `signal` (`INT`, `TERM`, ...) to the server.
    pub fn signal(&self, signal: &str) {
        let status = Command::new("kill")
            .arg(format!("-{signal}"))
            .arg(self.child.id().to_string())
            .status()
            .unwrap();
        assert!(status.success(), "kill -{signal}");
    }

    /// Wait for the exit (standard input closed first): how it ended and what went to stderr.
    pub fn finish(mut self) -> (ExitStatus, String) {
        drop(self.stdin.take());
        let status =
            wait(&mut self.child, PATIENCE).expect("serve did not exit after its input closed");
        // All of stderr: the reader may still be draining the pipe.
        assert!(self.stderr.ended(PATIENCE), "serve's stderr never closed");
        (status, self.stderr.text())
    }

    /// The exit within `patience`, if it came.
    pub fn exit_within(&mut self, patience: Duration) -> Option<ExitStatus> {
        wait(&mut self.child, patience)
    }

    /// Close standard input and wait for the exit: the exit code and what went to stderr.
    pub fn close(self) -> (Option<i32>, String) {
        let (status, stderr) = self.finish();
        (status.code(), stderr)
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// What the server wrote on stderr so far.
    pub fn stderr(&self) -> String {
        self.stderr.text()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether process `pid` waits for the lock on `locked`: its `<file>.lock-tmp.<pid>-<id>`
/// temporary (family-store/src/lock.rs) sits beside the file.
pub fn waits_for_lock(locked: &Path, pid: u32) -> bool {
    let prefix = format!(
        "{}.lock-tmp.{pid}-",
        locked.file_name().unwrap().to_string_lossy()
    );
    fs::read_dir(locked.parent().unwrap())
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        })
        .unwrap_or(false)
}

/// The exit of `child` within `patience`, if it came.
pub fn wait(child: &mut Child, patience: Duration) -> Option<ExitStatus> {
    let deadline = std::time::Instant::now() + patience;

    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A frozen value with its packed runs expanded: the freeze wrote each run of 1024 or more of one
/// character inside a string as U+0001, the character, `*`, the count, U+0001.
pub fn unpack(value: Value) -> Value {
    match value {
        Value::String(text) if text.contains('\u{1}') => {
            let mut out = String::new();
            let mut parts = text.split('\u{1}');
            out.push_str(parts.next().unwrap());

            while let Some(run) = parts.next() {
                let (unit, count) = run.split_once('*').unwrap();
                out.push_str(&unit.repeat(count.parse().unwrap()));
                out.push_str(parts.next().unwrap());
            }
            Value::String(out)
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, item)| (key, unpack(item)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(unpack).collect()),
        other => other,
    }
}
