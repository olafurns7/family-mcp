//! `auth login`: a temporary browser profile driven over a private Chrome debugging pipe, with
//! packages/abler-mcp/src/browser-login.ts's discovery, waiting rules, cleanup and messages.
//! Everything here blocks; the CLI calls it from `spawn_blocking`.

use std::ffi::OsString;
use std::fs::{self, DirBuilder, Permissions};
use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use rustix::fs::{Access, access};
use rustix::io::Errno;
use rustix::process::{
    Pid, Signal, getuid, kill_process, kill_process_group, test_kill_process,
    test_kill_process_group,
};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::signal::unix::{SignalKind, signal};

use crate::api::ORIGIN;
use crate::error::{Fail, Result};
use crate::jar::Jar;
use crate::js;

const MAC_BROWSERS: [&str; 4] = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const LINUX_BROWSERS: [&str; 6] = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
];

const PROFILE_PREFIX: &str = "abler-login-";

const ABANDONED_PROFILE_AGE: Duration = Duration::from_secs(60 * 60);

const DEBUG_READY_TIMEOUT: Duration = Duration::from_secs(15);

const BROWSER_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

const PROCESS_TERM_TIMEOUT: Duration = Duration::from_secs(5);

const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// How often a blocked read or delay looks for cancellation.
const CANCEL_INTERVAL: Duration = Duration::from_millis(50);

/// No Chrome debugging message comes near this; a browser that sends more is not answering.
const FRAME_MAX_BYTES: usize = 64 * 1024 * 1024;

const CANCELLED: Fail = Fail::Safe("Abler login cancelled.");

const INVALID_RESPONSE: &str = "Invalid Chrome debugging response.";

const CONNECTION_CLOSED: &str = "Chrome debugging connection closed.";

/// A failed debugging request: a fixed message, or the browser's own protocol error.
#[derive(Debug, PartialEq)]
enum Wire {
    Safe(&'static str),
    Protocol { code: f64, message: String },
}

/// An `AbortSignal`: the login's cancellation, and for one capture attempt also a deadline.
struct Abort<'a> {
    cancel: &'a AtomicBool,
    deadline: Option<Instant>,
}

impl Abort<'_> {
    fn aborted(&self) -> bool {
        self.cancel.load(Ordering::SeqCst) || self.deadline.is_some_and(|at| Instant::now() >= at)
    }
}

/// `/(?:session.*(?:not found|does not exist)|no session)/i`
fn session_is_gone(message: &str) -> bool {
    let message = message.to_lowercase();

    message.contains("no session")
        || message.lines().any(|line| {
            line.find("session").is_some_and(|at| {
                line[at..].contains("not found") || line[at..].contains("does not exist")
            })
        })
}

/// One debugging message, checked as `cdpEnvelopeSchema` checks it.
struct Envelope {
    id: Option<f64>,
    detached: Option<String>,
    reply: std::result::Result<Option<Value>, Wire>,
}

fn envelope(raw: &[u8]) -> Option<Envelope> {
    let value = js::parse(raw)?;
    let object = value.as_object()?;
    let id = match object.get("id") {
        None => None,
        Some(id) => Some(id.as_f64()?),
    };
    let method = match object.get("method") {
        None => None,
        Some(method) => Some(method.as_str()?),
    };
    let error = match object.get("error") {
        None => None,
        Some(error) => Some(Wire::Protocol {
            code: error.as_object()?.get("code")?.as_f64()?,
            message: error.get("message")?.as_str()?.to_owned(),
        }),
    };
    let detached = (id.is_none() && method == Some("Target.detachedFromTarget"))
        .then(|| object.get("params")?.get("sessionId")?.as_str())
        .flatten()
        .map(str::to_owned);

    Some(Envelope {
        id,
        detached,
        reply: match error {
            Some(error) => Err(error),
            None => Ok(object.get("result").cloned()),
        },
    })
}

/// The browser's `--remote-debugging-pipe`: NUL-terminated JSON, commands out and replies in.
/// One request is in flight at a time, as in the TypeScript login.
struct Pipe {
    /// The browser reads commands from its descriptor 3.
    input: UnixStream,
    /// The browser writes replies and events to its descriptor 4.
    output: UnixStream,
    buffer: Vec<u8>,
    replies: Vec<(f64, std::result::Result<Option<Value>, Wire>)>,
    closed: bool,
    closed_by_peer: bool,
    next_id: u64,
    session: Option<String>,
}

impl Pipe {
    fn new(input: UnixStream, output: UnixStream) -> Self {
        Self {
            input,
            output,
            buffer: Vec::new(),
            replies: Vec::new(),
            closed: false,
            closed_by_peer: false,
            next_id: 0,
            session: None,
        }
    }

    fn close(&mut self) {
        let _ = self.input.shutdown(Shutdown::Both);
        let _ = self.output.shutdown(Shutdown::Both);
        // A destroyed socket still emits `close`, which the TypeScript pipe counts as the peer's.
        self.closed = true;
        self.closed_by_peer = true;
    }

    /// Read what arrives within `wait` and file it. Returns the message a request in flight
    /// fails with when the pipe broke.
    fn pump(&mut self, wait: Duration) -> Option<&'static str> {
        if self.closed {
            return Some(CONNECTION_CLOSED);
        }
        let mut chunk = [0u8; 65_536];
        let _ = self
            .output
            .set_read_timeout(Some(wait.max(Duration::from_millis(1))));

        match self.output.read(&mut chunk) {
            Ok(0) => {
                self.closed = true;
                self.closed_by_peer = true;
                return Some(CONNECTION_CLOSED);
            }
            Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                return None;
            }
            Err(_) => {
                self.close();
                return Some(CONNECTION_CLOSED);
            }
        }

        while let Some(end) = self.buffer.iter().position(|byte| *byte == 0) {
            let raw: Vec<u8> = self.buffer.drain(..=end).collect();
            let Some(message) = envelope(&raw[..end]) else {
                self.close();
                return Some(INVALID_RESPONSE);
            };

            if message.detached.is_some() && message.detached == self.session {
                self.session = None;
            }

            if let Some(id) = message.id {
                self.replies.push((id, message.reply));
            }
        }

        if self.buffer.len() > FRAME_MAX_BYTES {
            self.close();
            return Some(INVALID_RESPONSE);
        }
        None
    }

    fn send(&mut self, method: &str, params: Option<Value>, session: Option<&str>) -> Option<f64> {
        self.next_id += 1;
        let mut command = json!({ "id": self.next_id, "method": method });

        if let Some(params) = params {
            command["params"] = params;
        }

        if let Some(session) = session {
            command["sessionId"] = json!(session);
        }
        self.input
            .write_all(format!("{command}\0").as_bytes())
            .ok()
            .map(|()| self.next_id as f64)
    }

    fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        session: Option<&str>,
        timeout: Duration,
        abort: &Abort,
    ) -> std::result::Result<Value, Wire> {
        const ABORTED: Wire = Wire::Safe("Chrome session capture was cancelled.");
        // Events that arrived since the last request, such as a detached session, come first.
        self.pump(Duration::ZERO);

        if self.closed {
            return Err(Wire::Safe(CONNECTION_CLOSED));
        }

        if abort.aborted() {
            return Err(ABORTED);
        }
        self.replies.clear();
        let id = self
            .send(method, params, session)
            .ok_or(Wire::Safe("Cannot communicate with Chrome debugging."))?;
        let deadline = Instant::now() + timeout;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let broken = self.pump(remaining.min(CANCEL_INTERVAL));

            if let Some(at) = self.replies.iter().position(|(reply, _)| *reply == id) {
                return self
                    .replies
                    .swap_remove(at)
                    .1?
                    .ok_or(Wire::Safe(INVALID_RESPONSE));
            }

            if let Some(message) = broken {
                return Err(Wire::Safe(message));
            }

            if abort.aborted() {
                return Err(ABORTED);
            }

            if remaining.is_zero() {
                return Err(Wire::Safe("Chrome debugging request timed out."));
            }
        }
    }

    /// The authentication cookies of the Abler tab, or `None`: the caller retries every failure.
    fn capture_cookies(&mut self, abort: &Abort) -> Option<Jar> {
        if self.session.is_none() {
            let targets = self
                .request("Target.getTargets", None, None, CDP_COMMAND_TIMEOUT, abort)
                .ok()?;
            let targets: Vec<(&str, &str, &str)> = targets
                .get("targetInfos")?
                .as_array()?
                .iter()
                .map(|target| {
                    Some((
                        target.get("targetId")?.as_str()?,
                        target.get("type")?.as_str()?,
                        target.get("url")?.as_str()?,
                    ))
                })
                .collect::<Option<_>>()?;
            let (page, _, _) = targets
                .into_iter()
                .find(|(_, kind, url)| *kind == "page" && url.starts_with(&format!("{ORIGIN}/")))?;
            let attached = self
                .request(
                    "Target.attachToTarget",
                    Some(json!({ "targetId": page, "flatten": true })),
                    None,
                    CDP_COMMAND_TIMEOUT,
                    abort,
                )
                .ok()?;
            self.session = Some(attached.get("sessionId")?.as_str()?.to_owned());
        }
        let session = self.session.clone();
        let cookies = self.request(
            "Network.getCookies",
            Some(json!({ "urls": [format!("{ORIGIN}/oauth/token"), format!("{ORIGIN}/graphql")] })),
            session.as_deref(),
            CDP_COMMAND_TIMEOUT,
            abort,
        );

        match cookies {
            Ok(value) => Jar::import(&Value::Array(value.get("cookies")?.as_array()?.clone())).ok(),
            Err(Wire::Protocol { code, message })
                if code == -32001.0 || session_is_gone(&message) =>
            {
                self.session = None;
                None
            }
            Err(_) => None,
        }
    }

    fn close_browser(&mut self) {
        let _ = self.send("Browser.close", None, None);
    }
}

/// A regular file the user may execute.
fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        && access(path, Access::EXEC_OK).is_ok()
}

fn find_on_path(command: &str, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| match directory.as_os_str().is_empty() {
            true => Path::new(".").join(command),
            false => directory.join(command),
        })
        .find(|candidate| exists(candidate))
}

/// The override when it is set, else the platform's known browsers in order.
fn find_browser(
    browser: Option<&str>,
    platform: &str,
    exists: &dyn Fn(&Path) -> bool,
    path_lookup: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<PathBuf> {
    let found = match (browser.filter(|browser| !browser.is_empty()), platform) {
        (Some(browser), _) => Some(PathBuf::from(browser)).filter(|path| exists(path)),
        (None, "macos") => MAC_BROWSERS
            .iter()
            .map(PathBuf::from)
            .find(|path| exists(path)),
        (None, "linux") => LINUX_BROWSERS
            .iter()
            .find_map(|command| path_lookup(command)),
        (None, _) => None,
    };
    found.ok_or(Fail::Safe(
        "No Chromium-family browser found. Install Chrome, Chromium, Brave, or Edge, or set ABLER_BROWSER/--browser to its executable. Use 'abler-mcp auth capture <URL>' or 'abler-mcp auth import <file>'.",
    ))
}

/// Node's `os.tmpdir()`.
fn tmpdir() -> PathBuf {
    ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(std::env::var_os)
        .find(|directory| !directory.is_empty())
        .map_or(PathBuf::from("/tmp"), PathBuf::from)
}

fn process_is_running(pid: Pid) -> bool {
    matches!(test_kill_process(pid), Ok(()) | Err(Errno::PERM))
}

fn process_group_is_running(pid: Pid) -> bool {
    matches!(test_kill_process_group(pid), Ok(()) | Err(Errno::PERM))
}

fn profile_has_live_browser(profile: &Path) -> bool {
    let Ok(lock) = fs::read_link(profile.join("SingletonLock")) else {
        return false;
    };
    let lock = lock.to_string_lossy();
    let owner = lock.rsplit('-').next().unwrap_or_default();

    // ponytail: PID reuse can preserve a stale profile; inspect process command lines if that matters.
    !owner.is_empty()
        && owner.bytes().all(|byte| byte.is_ascii_digit())
        && owner
            .parse()
            .ok()
            .filter(|pid| *pid >= 1)
            .and_then(Pid::from_raw)
            .is_some_and(process_is_running)
}

fn remove_tree(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Remove this user's profiles a crashed login left behind more than an hour ago.
fn sweep_abandoned_profiles(directory: &Path) -> std::io::Result<()> {
    let cutoff = SystemTime::now() - ABANDONED_PROFILE_AGE;
    let uid = getuid().as_raw();

    for entry in fs::read_dir(directory)? {
        let entry = entry?;

        if !entry
            .file_name()
            .as_encoded_bytes()
            .starts_with(PROFILE_PREFIX.as_bytes())
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let profile = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&profile) else {
            continue;
        };

        if !metadata.is_dir()
            || metadata.modified().is_ok_and(|modified| modified > cutoff)
            || metadata.uid() != uid
            || profile_has_live_browser(&profile)
        {
            continue;
        }
        remove_tree(&profile)?;
    }
    Ok(())
}

/// A new directory only this user can enter.
fn make_profile(directory: &Path) -> Option<PathBuf> {
    for _ in 0..8 {
        let profile = directory.join(format!("{PROFILE_PREFIX}{}", &js::uuid()?[..8]));

        match DirBuilder::new().mode(0o700).create(&profile) {
            Ok(()) => {
                fs::set_permissions(&profile, Permissions::from_mode(0o700)).ok()?;
                return Some(profile);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
    }
    None
}

/// The spawned browser, leader of its own process group.
struct Browser {
    child: Child,
    pid: Pid,
}

impl Browser {
    fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// A launcher may exit and leave the real browser running in its process group.
    fn gone(&mut self) -> bool {
        self.exited() && !process_group_is_running(self.pid)
    }

    fn signal_tree(&mut self, signal: Signal) {
        if kill_process_group(self.pid, signal).is_err() && !self.exited() {
            let _ = kill_process(self.pid, signal);
        }
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;

        while !self.gone() {
            let remaining = deadline.saturating_duration_since(Instant::now());

            if remaining.is_zero() {
                return false;
            }
            std::thread::sleep(remaining.min(POLL_INTERVAL));
        }
        true
    }

    fn terminate(&mut self) -> bool {
        if self.wait_for_exit(Duration::ZERO) {
            return true;
        }
        self.signal_tree(Signal::TERM);

        if self.wait_for_exit(PROCESS_TERM_TIMEOUT) {
            return true;
        }
        self.signal_tree(Signal::KILL);
        self.wait_for_exit(PROCESS_TERM_TIMEOUT)
    }
}

/// Start the browser in its own process group with the debugging pipe on its descriptors 3 and 4
/// and nothing else of ours. Safe Rust can hand a child only descriptors 0 to 2, so `sh` moves
/// them to 3 and 4 and replaces itself with the browser. `Bun.spawn` closes what is not in its
/// `stdio`; here every other descriptor is marked close-on-exec first, so one this process
/// inherited (a wrapper's file, lock or socket) does not reach the browser either.
fn spawn_browser(path: &Path, profile: &Path) -> Result<(Browser, Pipe)> {
    let failed = |_| Fail::Safe("Could not start the selected browser.");
    let (input, browser_input) = UnixStream::pair().map_err(failed)?;
    let (output, browser_output) = UnixStream::pair().map_err(failed)?;
    let mut data_directory = OsString::from("--user-data-dir=");
    data_directory.push(profile);
    // `exec` would read a leading dash as an option, and a bare name as a PATH search.
    let program = match path.is_absolute() {
        true => path.to_owned(),
        false => Path::new(".").join(path),
    };
    close_fds::set_fds_cloexec_threadsafe(
        3,
        &[browser_input.as_raw_fd(), browser_output.as_raw_fd()],
    );

    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg(r#"exec "$0" "$@" 3<&0 4>&1 </dev/null >/dev/null 2>&1"#)
        .arg(program)
        .arg(data_directory)
        .args([
            "--remote-debugging-pipe",
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            "https://www.abler.io/sign-on/login",
        ])
        .stdin(OwnedFd::from(browser_input))
        .stdout(OwnedFd::from(browser_output))
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(failed)?;
    let pid = Pid::from_child(&child);

    Ok((Browser { child, pid }, Pipe::new(input, output)))
}

fn throw_if_cancelled(cancel: &AtomicBool) -> Result<()> {
    match cancel.load(Ordering::SeqCst) {
        true => Err(CANCELLED),
        false => Ok(()),
    }
}

fn delay(duration: Duration, cancel: &AtomicBool) -> Result<()> {
    let deadline = Instant::now() + duration;

    loop {
        throw_if_cancelled(cancel)?;
        let remaining = deadline.saturating_duration_since(Instant::now());

        if remaining.is_zero() {
            return Ok(());
        }
        std::thread::sleep(remaining.min(CANCEL_INTERVAL));
    }
}

fn wait_for_pipe_debugging(pipe: &mut Pipe, cancel: &AtomicBool) -> Result<()> {
    let deadline = Instant::now() + DEBUG_READY_TIMEOUT;
    let abort = Abort {
        cancel,
        deadline: None,
    };

    while Instant::now() < deadline {
        throw_if_cancelled(cancel)?;
        pipe.pump(Duration::ZERO);

        if pipe.closed {
            return Err(Fail::Safe("The browser exited before debugging started."));
        }
        let version = pipe.request(
            "Browser.getVersion",
            None,
            None,
            Duration::from_secs(1),
            &abort,
        );
        throw_if_cancelled(cancel)?;

        match version {
            Ok(version)
                if version
                    .get("product")
                    .and_then(Value::as_str)
                    .is_some_and(|product| !product.is_empty()) =>
            {
                return Ok(());
            }
            Ok(_) | Err(Wire::Safe(INVALID_RESPONSE)) => return Err(Fail::Safe(INVALID_RESPONSE)),
            Err(_) => {}
        }
        delay(POLL_INTERVAL, cancel)?;
    }
    Err(Fail::Safe(
        "Timed out waiting for browser debugging to start.",
    ))
}

fn wait_for_cookies(pipe: &mut Pipe, timeout: Duration, cancel: &AtomicBool) -> Result<Jar> {
    let started = Instant::now();
    // ponytail: a timeout the clock cannot hold waits a year; nobody signs in that slowly.
    let deadline = started
        .checked_add(timeout)
        .unwrap_or(started + Duration::from_secs(365 * 24 * 60 * 60));

    while Instant::now() < deadline {
        throw_if_cancelled(cancel)?;
        pipe.pump(Duration::ZERO);

        if pipe.closed {
            return Err(Fail::Safe(
                "The browser closed before Abler sign-in completed.",
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let attempt = Abort {
            cancel,
            deadline: Some(Instant::now() + remaining.min(Duration::from_secs(10))),
        };

        if let Some(mut jar) = pipe.capture_cookies(&attempt)
            && jar.has("/oauth/token", "refreshToken")
            && jar.has("/graphql", "id_token")
        {
            return Ok(jar);
        }
        throw_if_cancelled(cancel)?;
        delay(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(2)),
            cancel,
        )?;
    }
    Err(Fail::Safe(
        "Abler login timed out. Try again or increase --timeout.",
    ))
}

/// The browser's processes are gone and, for a browser that answered, so is its end of the pipe.
fn debugging_is_gone(
    browser: &mut Browser,
    pipe: &mut Pipe,
    owned: bool,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;

    loop {
        if browser.gone() {
            if !owned {
                return true;
            }
            pipe.pump(Duration::ZERO);

            if pipe.closed_by_peer {
                return true;
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());

        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(remaining.min(POLL_INTERVAL));
    }
}

/// Ask the browser to close, then signal its process group. False if it may still be running.
fn close_browser(browser: &mut Browser, pipe: &mut Pipe, owned: bool) -> bool {
    let closed = (|| {
        if owned {
            pipe.close_browser();

            if debugging_is_gone(browser, pipe, owned, BROWSER_CLOSE_TIMEOUT) {
                return true;
            }
        }
        browser.terminate() && debugging_is_gone(browser, pipe, owned, BROWSER_CLOSE_TIMEOUT)
    })();
    pipe.close();
    closed
}

/// SIGINT and SIGTERM cancel the login while it runs, so its cleanup always happens.
struct Signals {
    cancel: Arc<AtomicBool>,
    listening: Arc<AtomicBool>,
}

impl Signals {
    fn install() -> Result<Self> {
        let handle = Handle::try_current().map_err(|_| Fail::Unknown)?;
        let _runtime = handle.enter();
        let mut interrupt = signal(SignalKind::interrupt()).map_err(|_| Fail::Unknown)?;
        let mut terminate = signal(SignalKind::terminate()).map_err(|_| Fail::Unknown)?;
        let signals = Self {
            cancel: Arc::new(AtomicBool::new(false)),
            listening: Arc::new(AtomicBool::new(true)),
        };
        let (cancel, listening) = (signals.cancel.clone(), signals.listening.clone());

        handle.spawn(async move {
            loop {
                let status = tokio::select! {
                    _ = interrupt.recv() => 130,
                    _ = terminate.recv() => 143,
                };

                if listening.load(Ordering::SeqCst) {
                    cancel.store(true, Ordering::SeqCst);
                } else {
                    // The runtime cannot restore the default action, so end as a signal would.
                    std::process::exit(status);
                }
            }
        });
        Ok(signals)
    }
}

/// What a login has started and must clean up, however it ends.
#[derive(Default)]
struct Started {
    profile: Option<PathBuf>,
    /// The browser, its pipe, and whether it answered on the pipe.
    browser: Option<(Browser, Pipe, bool)>,
}

fn sign_in(
    started: &mut Started,
    browser: Option<&str>,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<Jar> {
    const NO_PIPE: Fail = Fail::Safe(
        "Could not establish a private Chrome debugging pipe. Use `abler-mcp auth capture` or `abler-mcp auth import`, or select a Chromium browser with `--browser`.",
    );
    let directory = tmpdir();
    sweep_abandoned_profiles(&directory).map_err(|_| Fail::Unknown)?;
    throw_if_cancelled(cancel)?;
    let path = find_browser(browser, std::env::consts::OS, &is_executable, &|command| {
        find_on_path(command, &is_executable)
    })?;
    throw_if_cancelled(cancel)?;
    let profile = make_profile(&directory).ok_or(Fail::Unknown)?;
    started.profile = Some(profile.clone());

    let (running, pipe) = spawn_browser(&path, &profile).map_err(|_| NO_PIPE)?;
    let (_, pipe, owned) = started.browser.insert((running, pipe, false));

    wait_for_pipe_debugging(pipe, cancel).map_err(|error| match error {
        CANCELLED => CANCELLED,
        _ => NO_PIPE,
    })?;
    *owned = true;

    let _ = writeln!(
        std::io::stdout(),
        "Sign in to Abler in the browser window that opened."
    );
    wait_for_cookies(pipe, timeout, cancel)
}

/// Open a temporary browser, wait for the user to sign in to Abler, and return its session
/// cookies. The browser is closed and its profile removed before this returns, unless
/// `keep_browser` leaves both to the user.
pub fn login_in_browser(
    browser: Option<&str>,
    timeout_seconds: f64,
    keep_browser: bool,
) -> Result<Jar> {
    let timeout = Duration::try_from_secs_f64(timeout_seconds).unwrap_or(Duration::MAX);
    let signals = Signals::install()?;
    let mut started = Started::default();
    let outcome = sign_in(&mut started, browser, timeout, &signals.cancel);
    let mut cleanup_error = None;
    let mut keep_profile = false;

    match started.browser {
        Some((_, mut pipe, true)) if keep_browser => {
            pipe.close();
            let _ = writeln!(
                std::io::stderr(),
                "Keeping the browser open; its temporary profile contains live Abler credentials and no debugging endpoint is left open."
            );
            keep_profile = true;
        }
        Some((mut running, mut pipe, owned)) => {
            if !close_browser(&mut running, &mut pipe, owned) {
                cleanup_error = Some(Fail::Safe(
                    "A browser process may still be running; its temporary profile was removed.",
                ));
            }
        }
        None => {}
    }

    if let Some(profile) = started.profile.filter(|_| !keep_profile)
        && remove_tree(&profile).is_err()
    {
        cleanup_error = Some(Fail::Safe(
            "Could not remove the temporary browser profile.",
        ));
    }
    signals.listening.store(false, Ordering::SeqCst);

    if let Some(error) = cleanup_error {
        return Err(error);
    }
    throw_if_cancelled(&signals.cancel)?;
    outcome
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::os::unix::fs::OpenOptionsExt;

    use super::*;

    fn pipe() -> (Pipe, UnixStream, UnixStream) {
        let (input, commands) = UnixStream::pair().unwrap();
        let (output, replies) = UnixStream::pair().unwrap();
        (Pipe::new(input, output), commands, replies)
    }

    static IDLE: AtomicBool = AtomicBool::new(false);

    const NEVER: Abort = Abort {
        cancel: &IDLE,
        deadline: None,
    };

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("abler-unit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        path
    }

    #[test]
    fn browser_discovery_honors_the_override_and_reports_all_searched_choices() {
        let checked = RefCell::new(Vec::new());
        let browser = find_browser(
            Some("/fake/Chrome"),
            "linux",
            &|path| {
                checked.borrow_mut().push(path.to_owned());
                true
            },
            &|_| panic!("The PATH lookup should not run when an override is set."),
        );
        assert_eq!(browser, Ok(PathBuf::from("/fake/Chrome")));
        assert_eq!(*checked.borrow(), [PathBuf::from("/fake/Chrome")]);

        let searched = RefCell::new(Vec::new());
        let missing = find_browser(None, "linux", &|_| false, &|command| {
            searched.borrow_mut().push(command.to_owned());
            None
        });
        let message = missing.unwrap_err().safe().unwrap();
        assert!(message.contains("ABLER_BROWSER/--browser"));
        assert!(message.contains("auth capture <URL>' or 'abler-mcp auth import <file>"));
        assert_eq!(*searched.borrow(), LINUX_BROWSERS);

        // An override that is missing is never replaced by a discovered browser.
        assert!(find_browser(Some("/missing"), "linux", &|_| false, &|_| panic!()).is_err());
        assert!(
            find_browser(
                Some(""),
                "macos",
                &|path| path == Path::new(MAC_BROWSERS[2]),
                &|_| None
            )
            .is_ok()
        );
        assert!(find_browser(None, "windows", &|_| true, &|_| None).is_err());
    }

    #[test]
    fn frames_end_at_nul_and_may_span_reads() {
        let (mut pipe, mut commands, mut replies) = pipe();
        // Answers each command as it arrives, and returns the commands it read.
        let browser = std::thread::spawn(move || {
            let mut seen = Vec::new();
            let mut chunk = [0u8; 256];

            while let Ok(read @ 1..) = commands.read(&mut chunk) {
                seen.extend_from_slice(&chunk[..read]);

                match seen.iter().filter(|byte| **byte == 0).count() {
                    // An event, a reply to an abandoned request, then the reply in two pieces.
                    1 => {
                        replies
                            .write_all("{\"method\":\"Target.x\",\"params\":{}}\0{\"id\":7,\"result\":{}}\0{\"id\":1,\"result\":{\"product\":\"Chr".as_bytes())
                            .unwrap();
                        std::thread::sleep(Duration::from_millis(80));
                        replies.write_all("öme\"}}\0".as_bytes()).unwrap();
                    }
                    2 => replies
                        .write_all(b"{\"id\":2,\"error\":{\"code\":-32001,\"message\":\"gone\"}}\0")
                        .unwrap(),
                    // A reply without a result is not an answer.
                    3 => replies.write_all(b"{\"id\":3}\0").unwrap(),
                    _ => {}
                }
            }
            seen
        });
        let version = |pipe: &mut Pipe, timeout, abort: &Abort| {
            pipe.request("Browser.getVersion", None, None, timeout, abort)
        };
        let long = Duration::from_secs(5);

        assert_eq!(
            version(&mut pipe, long, &NEVER),
            Ok(json!({ "product": "Chröme" }))
        );
        let refused = pipe.request(
            "Network.getCookies",
            Some(json!({ "urls": [] })),
            Some("s"),
            long,
            &NEVER,
        );
        let gone = Wire::Protocol {
            code: -32001.0,
            message: "gone".to_owned(),
        };
        assert_eq!(refused, Err(gone));
        assert_eq!(
            version(&mut pipe, long, &NEVER),
            Err(Wire::Safe(INVALID_RESPONSE))
        );
        assert_eq!(
            version(&mut pipe, Duration::from_millis(60), &NEVER),
            Err(Wire::Safe("Chrome debugging request timed out."))
        );
        let cancel = AtomicBool::new(true);
        let abort = Abort {
            cancel: &cancel,
            deadline: None,
        };
        assert_eq!(
            version(&mut pipe, long, &abort),
            Err(Wire::Safe("Chrome session capture was cancelled."))
        );
        assert!(!pipe.closed);

        // Parameters and the session follow the method, as the TypeScript command orders them;
        // a cancelled request is never sent.
        pipe.close();
        assert_eq!(
            String::from_utf8(browser.join().unwrap()).unwrap(),
            "{\"id\":1,\"method\":\"Browser.getVersion\"}\0{\"id\":2,\"method\":\"Network.getCookies\",\"params\":{\"urls\":[]},\"sessionId\":\"s\"}\0{\"id\":3,\"method\":\"Browser.getVersion\"}\0{\"id\":4,\"method\":\"Browser.getVersion\"}\0"
        );
    }

    #[test]
    fn a_malformed_frame_closes_the_pipe_and_a_closed_browser_is_noticed() {
        for malformed in [
            &b"not json\0"[..],
            b"[]\0",
            b"{\"id\":\"1\"}\0",
            b"{\"id\":null}\0",
            b"{\"method\":1}\0",
            b"{\"id\":1,\"error\":{\"code\":\"x\",\"message\":\"m\"}}\0",
            b"{\"id\":1,\"error\":null}\0",
        ] {
            let (mut pipe, _commands, mut replies) = pipe();
            replies.write_all(malformed).unwrap();
            let broken = pipe.request(
                "Browser.getVersion",
                None,
                None,
                Duration::from_secs(5),
                &NEVER,
            );
            // The frame may arrive before the request is sent or while it waits.
            assert!(
                matches!(
                    broken,
                    Err(Wire::Safe(INVALID_RESPONSE | CONNECTION_CLOSED))
                ),
                "{broken:?}"
            );
            assert!(pipe.closed);
            let later = pipe.request(
                "Browser.getVersion",
                None,
                None,
                Duration::from_secs(5),
                &NEVER,
            );
            assert_eq!(later, Err(Wire::Safe(CONNECTION_CLOSED)));
        }

        let (mut pipe, commands, replies) = pipe();
        assert!(!pipe.closed_by_peer);
        drop((commands, replies));
        assert_eq!(pipe.pump(Duration::ZERO), Some(CONNECTION_CLOSED));
        assert!(pipe.closed && pipe.closed_by_peer);
    }

    #[test]
    fn a_detached_or_missing_session_is_forgotten() {
        let (mut pipe, _commands, mut replies) = pipe();
        pipe.session = Some("page".to_owned());
        replies
            .write_all(b"{\"method\":\"Target.detachedFromTarget\",\"params\":{\"sessionId\":\"other\"}}\0")
            .unwrap();
        pipe.pump(Duration::ZERO);
        assert_eq!(pipe.session.as_deref(), Some("page"));
        replies
            .write_all(
                b"{\"method\":\"Target.detachedFromTarget\",\"params\":{\"sessionId\":\"page\"}}\0",
            )
            .unwrap();
        pipe.pump(Duration::ZERO);
        assert_eq!(pipe.session, None);

        for (message, gone) in [
            ("Session with given id not found.", true),
            ("The SESSION does not exist", true),
            ("No session with given id", true),
            ("not found: session", false),
            ("Target closed", false),
        ] {
            assert_eq!(session_is_gone(message), gone, "{message}");
        }
    }

    fn script(directory: &Path, body: &str) -> PathBuf {
        let path = directory.join("browser");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&path)
            .unwrap()
            .write_all(format!("#!/bin/sh\n{body}\n").as_bytes())
            .unwrap();
        path
    }

    #[test]
    fn a_descriptor_this_process_inherited_does_not_reach_the_browser() {
        let directory = scratch("descriptors");
        // /dev/fd lists the descriptors of `ls`: the browser's, and one for the listing itself.
        let browser = script(
            &directory,
            "ls /dev/fd > \"$(dirname \"$0\")/tmp\"\nmv \"$(dirname \"$0\")/tmp\" \"$(dirname \"$0\")/fds\"",
        );
        // As a descriptor from the parent shell is: open and not close-on-exec.
        let inherited =
            rustix::io::fcntl_dupfd_cloexec(fs::File::open(&browser).unwrap(), 100).unwrap();
        rustix::io::fcntl_setfd(&inherited, rustix::io::FdFlags::empty()).unwrap();
        let (mut running, mut pipe) = spawn_browser(&browser, &directory.join("profile")).unwrap();
        let listed = (0..100)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(50));
                fs::read_to_string(directory.join("fds")).ok()
            })
            .unwrap();
        let listed: Vec<&str> = listed.lines().collect();

        assert!(listed.contains(&"3") && listed.contains(&"4"), "{listed:?}");
        assert!(
            !listed.contains(&inherited.as_raw_fd().to_string().as_str()),
            "{listed:?}"
        );
        assert!(listed.len() <= 6, "{listed:?}");
        assert!(close_browser(&mut running, &mut pipe, false));
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn the_browser_gets_the_pipe_on_descriptors_3_and_4_and_its_whole_group_is_closed() {
        let directory = scratch("spawn");
        // Answer one command on the pipe, then leave a child of the launcher running.
        let browser = script(
            &directory,
            "printf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args\"\nhead -c 39 <&3 >/dev/null\nprintf '{\"id\":1,\"result\":{\"product\":\"x\"}}\\0' >&4\nsleep 60 &\necho $! > \"$(dirname \"$0\")/pid\"\nexit 0",
        );
        let profile = directory.join("profile");
        let (mut running, mut pipe) = spawn_browser(&browser, &profile).unwrap();
        wait_for_pipe_debugging(&mut pipe, &AtomicBool::new(false)).unwrap();

        assert_eq!(
            fs::read_to_string(directory.join("args")).unwrap(),
            format!(
                "--user-data-dir={}\n--remote-debugging-pipe\n--no-first-run\n--no-default-browser-check\n--new-window\nhttps://www.abler.io/sign-on/login\n",
                profile.display()
            )
        );
        // The launcher exits; its child keeps the process group, and the pipe, alive.
        let launched = (0..100)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(50));
                fs::read_to_string(directory.join("pid"))
                    .ok()?
                    .trim()
                    .parse()
                    .ok()
            })
            .and_then(Pid::from_raw)
            .unwrap();
        assert!(process_is_running(launched));
        assert!(!running.wait_for_exit(Duration::from_millis(300)));
        assert!(running.exited());

        // It ignores Browser.close, so its process group is signalled.
        assert!(close_browser(&mut running, &mut pipe, true));
        assert!(running.gone() && pipe.closed_by_peer);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn abandoned_profiles_are_swept_and_recent_or_live_ones_kept() {
        let directory = scratch("sweep");
        let old = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        let aged = |name: &str| {
            let path = directory.join(name);
            fs::create_dir(&path).unwrap();
            path
        };
        let age = |path: &Path| fs::File::open(path).unwrap().set_modified(old).unwrap();
        let (abandoned, recent, active, other) = (
            aged("abler-login-abandoned"),
            aged("abler-login-recent"),
            aged("abler-login-active"),
            aged("other-abandoned"),
        );
        std::os::unix::fs::symlink(
            format!("host-{}", std::process::id()),
            active.join("SingletonLock"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&other, directory.join("abler-login-link")).unwrap();
        for path in [&abandoned, &active, &other] {
            age(path);
        }

        sweep_abandoned_profiles(&directory).unwrap();
        assert!(!abandoned.exists());
        assert!(recent.is_dir() && active.is_dir() && other.is_dir());

        let made = make_profile(&directory).unwrap();
        assert_eq!(fs::metadata(&made).unwrap().mode() & 0o777, 0o700);
        fs::remove_dir_all(&directory).unwrap();
    }
}
