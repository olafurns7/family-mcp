//! `auth login` in a browser: a temporary profile driven over a private Chrome debugging pipe,
//! with the discovery, waiting rules and cleanup that packages/abler-mcp/src/browser-login.ts and
//! packages/inna-mcp/src/browser-login.ts share. A [`Site`] supplies what differs: the start page,
//! the tab that proves sign-in, the cookies to read, and the messages. Everything here blocks; a
//! CLI calls it from `spawn_blocking` inside a Tokio runtime, which delivers the signals.

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

use crate::js;

/// Why a browser login failed. Each server words these itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// SIGINT or SIGTERM arrived.
    Cancelled,
    /// No browser at the override, or none of the platform's known browsers.
    NoBrowser,
    /// The browser could not be started or never answered on its debugging pipe.
    NoPipe,
    /// The browser closed before the site's sign-in completed.
    Closed,
    /// The sign-in did not complete within the timeout.
    TimedOut,
    /// A browser process may still be running; its profile was removed.
    StillRunning,
    /// The temporary profile could not be removed.
    ProfileNotRemoved,
    /// Anything else; its details never cross a boundary.
    Unknown,
}

type Result<T> = std::result::Result<T, Error>;

/// What a server's browser login opens, waits for and reads.
pub trait Site {
    /// What a completed sign-in yields.
    type Session;

    /// The temporary profile's name prefix in the temporary directory, such as `abler-login-`.
    const PROFILE_PREFIX: &'static str;

    /// The page the browser opens on.
    const START_URL: &'static str;

    /// True: list the tabs on every attempt and attach again when the matching tab changes.
    /// False: keep the first attachment until its session ends.
    const FOLLOW_TAB: bool;

    /// A page tab whose URL proves the browser reached the signed-in site.
    fn is_tab(&self, url: &str) -> bool;

    /// The URLs whose cookies `Network.getCookies` returns.
    fn cookie_urls(&self) -> Value;

    /// The session in a `Network.getCookies` result, once it is complete; `None` keeps waiting.
    fn session(&self, result: &Value) -> Option<Self::Session>;

    /// Called just before the browser starts.
    fn launching(&self) {}

    /// Called once the browser answers on its debugging pipe.
    fn debugging(&self) {}

    /// Called when `keep_browser` leaves the signed-in browser and its profile to the user.
    fn kept(&self) {}
}

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
    /// The tab `session` is attached to.
    target: Option<String>,
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
            target: None,
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

    /// The site's session from its signed-in tab, or `None`: the caller retries every failure.
    fn capture<S: Site>(&mut self, site: &S, abort: &Abort) -> Option<S::Session> {
        if self.session.is_none() || S::FOLLOW_TAB {
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
                .find(|(_, kind, url)| *kind == "page" && site.is_tab(url))?;

            if self.session.is_none() || self.target.as_deref() != Some(page) {
                let page = page.to_owned();
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
                self.target = Some(page);
            }
        }
        let session = self.session.clone();
        let cookies = self.request(
            "Network.getCookies",
            Some(json!({ "urls": site.cookie_urls() })),
            session.as_deref(),
            CDP_COMMAND_TIMEOUT,
            abort,
        );

        match cookies {
            Ok(value) => site.session(&value),
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
    found.ok_or(Error::NoBrowser)
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
fn sweep_abandoned_profiles(directory: &Path, prefix: &str) -> std::io::Result<()> {
    let cutoff = SystemTime::now() - ABANDONED_PROFILE_AGE;
    let uid = getuid().as_raw();

    for entry in fs::read_dir(directory)? {
        let entry = entry?;

        if !entry
            .file_name()
            .as_encoded_bytes()
            .starts_with(prefix.as_bytes())
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
fn make_profile(directory: &Path, prefix: &str) -> Option<PathBuf> {
    for _ in 0..8 {
        let profile = directory.join(format!("{prefix}{}", &js::uuid()?[..8]));

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
fn spawn_browser(path: &Path, profile: &Path, start_url: &str) -> Result<(Browser, Pipe)> {
    let failed = |_| Error::NoPipe;
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
            start_url,
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
        true => Err(Error::Cancelled),
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

/// Wait until the browser answers on its pipe. A cancellation that arrives meanwhile still lets
/// one more question finish: a browser that is up by then is closed with `Browser.close`, as one
/// that answered earlier is, instead of being signalled while it may still be installing its own
/// handlers. The TypeScript logins abort the question at once, so their cleanup depends on
/// whether the browser had answered when the signal came.
fn wait_for_pipe_debugging(pipe: &mut Pipe, cancel: &AtomicBool) -> Result<()> {
    let deadline = Instant::now() + DEBUG_READY_TIMEOUT;
    let uncancelled = AtomicBool::new(false);
    let abort = Abort {
        cancel: &uncancelled,
        deadline: None,
    };
    let mut asked_after_cancel = false;

    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            if asked_after_cancel {
                return Err(Error::Cancelled);
            }
            asked_after_cancel = true;
        }
        pipe.pump(Duration::ZERO);

        if pipe.closed {
            // The browser exited before debugging started.
            return Err(Error::NoPipe);
        }
        let version = pipe.request(
            "Browser.getVersion",
            None,
            None,
            Duration::from_secs(1),
            &abort,
        );

        match version {
            Ok(version)
                if version
                    .get("product")
                    .and_then(Value::as_str)
                    .is_some_and(|product| !product.is_empty()) =>
            {
                return Ok(());
            }
            Ok(_) | Err(Wire::Safe(INVALID_RESPONSE)) => return Err(Error::NoPipe),
            Err(_) => {}
        }
        // A cancellation ends the pause and goes back to the check above.
        let _ = delay(POLL_INTERVAL, cancel);
    }
    // Timed out waiting for browser debugging to start.
    Err(Error::NoPipe)
}

fn wait_for_session<S: Site>(
    site: &S,
    pipe: &mut Pipe,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<S::Session> {
    let started = Instant::now();
    // ponytail: a timeout the clock cannot hold waits a year; nobody signs in that slowly.
    let deadline = started
        .checked_add(timeout)
        .unwrap_or(started + Duration::from_secs(365 * 24 * 60 * 60));

    while Instant::now() < deadline {
        throw_if_cancelled(cancel)?;
        pipe.pump(Duration::ZERO);

        if pipe.closed {
            return Err(Error::Closed);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let attempt = Abort {
            cancel,
            deadline: Some(Instant::now() + remaining.min(Duration::from_secs(10))),
        };

        if let Some(session) = pipe.capture(site, &attempt) {
            return Ok(session);
        }
        throw_if_cancelled(cancel)?;
        delay(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(2)),
            cancel,
        )?;
    }
    Err(Error::TimedOut)
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

/// Which signals cancel, and what a repeated one does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cancellation {
    /// SIGINT and SIGTERM cancel, as often as they arrive (`process.on`).
    InterruptOrTerminate,
    /// SIGINT cancels once; a second one ends the process as SIGINT would (`process.once`).
    /// SIGTERM keeps its default action.
    InterruptOnce,
}

/// Signals that cancel work in progress, so its cleanup always happens. Once [`Signals::stop`]
/// runs, a signal ends the process as its default action would.
pub struct Signals {
    cancel: Arc<AtomicBool>,
    listening: Arc<AtomicBool>,
}

impl Signals {
    /// Listen on the current Tokio runtime.
    pub fn install(cancellation: Cancellation) -> Result<Self> {
        let handle = Handle::try_current().map_err(|_| Error::Unknown)?;
        let _runtime = handle.enter();
        let mut interrupt = signal(SignalKind::interrupt()).map_err(|_| Error::Unknown)?;
        let mut terminate = match cancellation {
            Cancellation::InterruptOrTerminate => {
                Some(signal(SignalKind::terminate()).map_err(|_| Error::Unknown)?)
            }
            Cancellation::InterruptOnce => None,
        };
        let signals = Self {
            cancel: Arc::new(AtomicBool::new(false)),
            listening: Arc::new(AtomicBool::new(true)),
        };
        let (cancel, listening) = (signals.cancel.clone(), signals.listening.clone());

        handle.spawn(async move {
            loop {
                let status = tokio::select! {
                    _ = interrupt.recv() => 130,
                    Some(_) = async {
                        match terminate.as_mut() {
                            Some(terminate) => terminate.recv().await,
                            None => std::future::pending().await,
                        }
                    } => 143,
                };
                let repeated =
                    cancellation == Cancellation::InterruptOnce && cancel.load(Ordering::SeqCst);

                if listening.load(Ordering::SeqCst) && !repeated {
                    cancel.store(true, Ordering::SeqCst);
                } else {
                    // The runtime cannot restore the default action, so end as a signal would.
                    std::process::exit(status);
                }
            }
        });
        Ok(signals)
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// The flag a signal sets, for work that polls it.
    pub fn flag(&self) -> &AtomicBool {
        &self.cancel
    }

    /// Stop cancelling: from now on a signal ends the process.
    pub fn stop(&self) {
        self.listening.store(false, Ordering::SeqCst);
    }
}

/// What a login has started and must clean up, however it ends.
#[derive(Default)]
struct Started {
    profile: Option<PathBuf>,
    /// The browser, its pipe, and whether it answered on the pipe.
    browser: Option<(Browser, Pipe, bool)>,
    /// The browser answered on the pipe before any cancel; only then may `keep_browser` keep it.
    ready: bool,
}

fn sign_in<S: Site>(
    site: &S,
    started: &mut Started,
    browser: Option<&str>,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<S::Session> {
    let directory = tmpdir();
    sweep_abandoned_profiles(&directory, S::PROFILE_PREFIX).map_err(|_| Error::Unknown)?;
    throw_if_cancelled(cancel)?;
    let path = find_browser(browser, std::env::consts::OS, &is_executable, &|command| {
        find_on_path(command, &is_executable)
    })?;
    throw_if_cancelled(cancel)?;
    let profile = make_profile(&directory, S::PROFILE_PREFIX).ok_or(Error::Unknown)?;
    started.profile = Some(profile.clone());

    site.launching();
    let (running, pipe) = spawn_browser(&path, &profile, S::START_URL)?;
    let (_, pipe, owned) = started.browser.insert((running, pipe, false));

    let ready = wait_for_pipe_debugging(pipe, cancel);
    *owned = ready.is_ok();
    throw_if_cancelled(cancel)?;
    ready?;
    started.ready = true;

    site.debugging();
    wait_for_session(site, pipe, timeout, cancel)
}

/// Open a temporary browser on the site, wait for the user to sign in, and return the session.
/// The browser is closed and its profile removed before this returns, unless `keep_browser`
/// leaves both to the user. `signals` cancels the wait; the caller stops it when it is done.
pub fn login_in_browser<S: Site>(
    site: &S,
    signals: &Signals,
    browser: Option<&str>,
    timeout: Duration,
    keep_browser: bool,
) -> Result<S::Session> {
    login_until(site, signals.flag(), browser, timeout, keep_browser)
}

/// `login_in_browser`, cancelled by `cancel`.
fn login_until<S: Site>(
    site: &S,
    cancel: &AtomicBool,
    browser: Option<&str>,
    timeout: Duration,
    keep_browser: bool,
) -> Result<S::Session> {
    let mut started = Started::default();
    let outcome = sign_in(site, &mut started, browser, timeout, cancel);
    let mut cleanup_error = None;
    let mut keep_profile = false;
    let ready = started.ready;

    match started.browser {
        Some((_, mut pipe, true)) if keep_browser && ready => {
            pipe.close();
            site.kept();
            keep_profile = true;
        }
        Some((mut running, mut pipe, owned)) => {
            if !close_browser(&mut running, &mut pipe, owned) {
                cleanup_error = Some(Error::StillRunning);
            }
        }
        None => {}
    }

    if let Some(profile) = started.profile.filter(|_| !keep_profile)
        && remove_tree(&profile).is_err()
    {
        cleanup_error = Some(Error::ProfileNotRemoved);
    }

    if let Some(error) = cleanup_error {
        return Err(error);
    }
    throw_if_cancelled(cancel)?;
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

    const START: &str = "https://example.invalid/sign-in";

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("browser-login-unit-{name}-{}", std::process::id()));
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
        assert_eq!(missing, Err(Error::NoBrowser));
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
        // `ls /dev/fd` would add its own descriptors (one on Linux, two on macOS), and the shell
        // reading this script holds it on one more until exec. So a fresh `sh -c` tests each
        // number up to 255 with `[ -e ]`, which opens nothing, and only then writes the open ones.
        let browser = script(
            &directory,
            r#"exec /bin/sh -c 'fd=0 open=; while [ "$fd" -le 255 ]; do [ -e "/dev/fd/$fd" ] && open="$open $fd"; fd=$((fd + 1)); done; echo $open > "$1/tmp"; mv "$1/tmp" "$1/fds"' sh "$(dirname "$0")""#,
        );
        // As a descriptor from the parent shell is: open and not close-on-exec.
        let inherited =
            rustix::io::fcntl_dupfd_cloexec(fs::File::open(&browser).unwrap(), 100).unwrap();
        rustix::io::fcntl_setfd(&inherited, rustix::io::FdFlags::empty()).unwrap();
        assert!(inherited.as_raw_fd() <= 255);
        let (mut running, mut pipe) =
            spawn_browser(&browser, &directory.join("profile"), START).unwrap();
        let listed = (0..100)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(50));
                fs::read_to_string(directory.join("fds")).ok()
            })
            .unwrap();

        assert_eq!(
            listed.split_whitespace().collect::<Vec<_>>(),
            ["0", "1", "2", "3", "4"]
        );
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
        let (mut running, mut pipe) = spawn_browser(&browser, &profile, START).unwrap();
        wait_for_pipe_debugging(&mut pipe, &AtomicBool::new(false)).unwrap();

        assert_eq!(
            fs::read_to_string(directory.join("args")).unwrap(),
            format!(
                "--user-data-dir={}\n--remote-debugging-pipe\n--no-first-run\n--no-default-browser-check\n--new-window\n{START}\n",
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

    /// A site that never signs in, and records whether it was asked to keep the browser.
    #[derive(Default)]
    struct Slow {
        kept: AtomicBool,
    }

    impl Site for Slow {
        type Session = ();
        const PROFILE_PREFIX: &'static str = "browser-login-unit-keep-";
        const START_URL: &'static str = START;
        const FOLLOW_TAB: bool = false;

        fn is_tab(&self, _: &str) -> bool {
            false
        }

        fn cookie_urls(&self) -> Value {
            json!([])
        }

        fn session(&self, _: &Value) -> Option<()> {
            None
        }

        fn kept(&self) {
            self.kept.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn a_cancel_while_the_browser_starts_closes_it_even_with_keep_browser() {
        let directory = scratch("keep-cancel");
        // Answer Browser.getVersion only after 400 ms, then record the next command and exit.
        let browser = script(
            &directory,
            "echo $$ > \"$(dirname \"$0\")/pid\"\nhead -c 39 <&3 >/dev/null\nsleep 0.4\nprintf '{\"id\":1,\"result\":{\"product\":\"x\"}}\\0' >&4\nhead -c 34 <&3 > \"$(dirname \"$0\")/next\"\nexit 0",
        );
        let profiles = || -> Vec<PathBuf> {
            fs::read_dir(tmpdir())
                .unwrap()
                .filter_map(|entry| Some(entry.ok()?.path()))
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(Slow::PROFILE_PREFIX))
                })
                .collect()
        };
        let before = profiles();
        let cancel = AtomicBool::new(false);
        let site = Slow::default();

        let outcome = std::thread::scope(|scope| {
            scope.spawn(|| {
                // The cancel lands while the first Browser.getVersion waits for its answer.
                let deadline = Instant::now() + Duration::from_secs(10);

                while !directory.join("pid").exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::thread::sleep(Duration::from_millis(100));
                cancel.store(true, Ordering::SeqCst);
            });
            login_until(
                &site,
                &cancel,
                browser.to_str(),
                Duration::from_secs(30),
                true,
            )
        });

        assert!(matches!(outcome, Err(Error::Cancelled)), "{outcome:?}");
        assert!(!site.kept.load(Ordering::SeqCst));
        // It answered, so it was asked to close over the pipe before any signal.
        assert_eq!(
            fs::read_to_string(directory.join("next")).unwrap(),
            "{\"id\":2,\"method\":\"Browser.close\"}\0"
        );
        let pid = fs::read_to_string(directory.join("pid")).unwrap();
        let pid = Pid::from_raw(pid.trim().parse().unwrap()).unwrap();
        assert!(!process_is_running(pid));
        assert_eq!(profiles(), before);
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

        sweep_abandoned_profiles(&directory, "abler-login-").unwrap();
        assert!(!abandoned.exists());
        assert!(recent.is_dir() && active.is_dir() && other.is_dir());

        let made = make_profile(&directory, "abler-login-").unwrap();
        assert!(
            made.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("abler-login-")
        );
        assert_eq!(fs::metadata(&made).unwrap().mode() & 0o777, 0o700);
        fs::remove_dir_all(&directory).unwrap();
    }

    /// Answers each command with `answer(method, params, session)`, after `wait`, and records it.
    fn browser(
        mut commands: UnixStream,
        mut replies: UnixStream,
        wait: Duration,
        answer: impl Fn(&str, &Value, Option<&str>) -> Value + Send + 'static,
    ) -> std::thread::JoinHandle<Vec<Value>> {
        std::thread::spawn(move || {
            let (mut seen, mut buffer, mut chunk) = (Vec::new(), Vec::new(), [0u8; 4096]);

            while let Ok(read @ 1..) = commands.read(&mut chunk) {
                buffer.extend_from_slice(&chunk[..read]);

                while let Some(end) = buffer.iter().position(|byte| *byte == 0) {
                    let command: Value = serde_json::from_slice(&buffer[..end]).unwrap();
                    buffer.drain(..=end);
                    std::thread::sleep(wait);
                    let result = answer(
                        command["method"].as_str().unwrap(),
                        &command["params"],
                        command["sessionId"].as_str(),
                    );
                    let reply = json!({ "id": command["id"], "result": result });
                    let _ = replies.write_all(format!("{reply}\0").as_bytes());
                    seen.push(command);
                }
            }
            seen
        })
    }

    #[test]
    fn a_cancelled_login_still_lets_a_starting_browser_answer_once() {
        let (mut pipe, commands, replies) = pipe();
        let answering = browser(
            commands,
            replies,
            Duration::from_millis(300),
            |_, _, _| json!({ "product": "Chrome/1.0" }),
        );
        // Cancelled before the browser answered: it answers, so cleanup can ask it to close.
        let cancel = AtomicBool::new(true);
        assert_eq!(wait_for_pipe_debugging(&mut pipe, &cancel), Ok(()));
        pipe.close();
        assert_eq!(answering.join().unwrap().len(), 1);

        // A browser that never answers is given one question, not the whole readiness timeout.
        let (mut silent, _commands, _replies) = self::tests::pipe();
        let started = Instant::now();
        assert_eq!(
            wait_for_pipe_debugging(&mut silent, &cancel),
            Err(Error::Cancelled)
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    struct Follow;

    impl Site for Follow {
        type Session = String;
        const PROFILE_PREFIX: &'static str = "follow-";
        const START_URL: &'static str = START;
        const FOLLOW_TAB: bool = true;

        fn is_tab(&self, url: &str) -> bool {
            url == "https://site.invalid/home"
        }

        fn cookie_urls(&self) -> Value {
            json!(["https://site.invalid/"])
        }

        fn session(&self, result: &Value) -> Option<String> {
            result["cookies"][0]["value"].as_str().map(str::to_owned)
        }
    }

    #[test]
    fn a_followed_tab_is_found_on_every_attempt_and_attached_again_when_it_changes() {
        let (mut pipe, commands, replies) = pipe();
        let tab = Arc::new(std::sync::Mutex::new(("one", "https://site.invalid/home")));
        let shown = tab.clone();
        let answering = browser(
            commands,
            replies,
            Duration::ZERO,
            move |method, params, session| {
                let (id, url) = *shown.lock().unwrap();
                match method {
                    "Target.getTargets" => json!({ "targetInfos": [
                        { "targetId": "worker", "type": "service_worker", "url": url },
                        { "targetId": id, "type": "page", "url": url },
                    ] }),
                    "Target.attachToTarget" => {
                        json!({ "sessionId": format!("s-{}", params["targetId"].as_str().unwrap()) })
                    }
                    _ => json!({ "cookies": [{ "value": session.unwrap_or_default() }] }),
                }
            },
        );
        let attempt = |pipe: &mut Pipe| pipe.capture(&Follow, &NEVER);

        assert_eq!(attempt(&mut pipe).as_deref(), Some("s-one"));
        assert_eq!(attempt(&mut pipe).as_deref(), Some("s-one"));
        *tab.lock().unwrap() = ("two", "https://site.invalid/home");
        assert_eq!(attempt(&mut pipe).as_deref(), Some("s-two"));
        *tab.lock().unwrap() = ("two", "https://accounts.invalid/");
        assert_eq!(attempt(&mut pipe), None);
        pipe.close();

        let methods: Vec<String> = answering
            .join()
            .unwrap()
            .iter()
            .map(|command| command["method"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            methods,
            [
                "Target.getTargets",
                "Target.attachToTarget",
                "Network.getCookies",
                "Target.getTargets",
                "Network.getCookies",
                "Target.getTargets",
                "Target.attachToTarget",
                "Network.getCookies",
                "Target.getTargets",
            ]
        );
    }
}
