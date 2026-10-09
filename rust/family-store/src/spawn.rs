use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    Timeout,
    Failed,
    Overflow,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Run {
    /// Exit status, or `None` when the child was killed, failed to start or overflowed.
    pub status: Option<i32>,
    pub stdout: String,
    pub failure: Option<Failure>,
}

impl Run {
    fn failed(failure: Failure, stdout: &[u8]) -> Self {
        Self {
            status: None,
            stdout: String::from_utf8_lossy(stdout).into_owned(),
            failure: Some(failure),
        }
    }
}

enum Piped {
    Chunk(Vec<u8>),
    End,
}

// How often the exit of a child whose output has ended is looked for.
const EXIT_POLL: Duration = Duration::from_millis(2);

/// Run an absolute executable without a shell, stdin closed, stderr discarded, and only PATH and
/// HOME in its environment. Returns by `timeout` even when the child ignores SIGTERM or a
/// grandchild keeps its stdout open: the deadline, not the child's exit, ends the wait, and a
/// child still running then is killed. Larger output than `max_bytes` is never an answer.
pub(crate) fn run_bounded(
    file: &Path,
    args: &[&OsStr],
    timeout: Duration,
    max_bytes: usize,
) -> Run {
    let deadline = Instant::now() + timeout;
    let home = std::env::var_os("HOME").unwrap_or_else(|| "/".into());
    let spawned = Command::new(file)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(_) => return Run::failed(Failure::Failed, &[]),
    };
    let Some(mut stdout) = child.stdout.take() else {
        abandon(child);
        return Run::failed(Failure::Failed, &[]);
    };
    let (sender, receiver) = mpsc::channel();

    // Left running if a grandchild holds the pipe; it ends when the pipe closes.
    std::thread::spawn(move || {
        let mut buffer = [0; 8192];

        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(Piped::Chunk(buffer[..read].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = sender.send(Piped::End);
    });

    let mut output = Vec::new();

    loop {
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Piped::Chunk(chunk)) => {
                if output.len() + chunk.len() > max_bytes {
                    abandon(child);
                    return Run::failed(Failure::Overflow, &output);
                }
                output.extend_from_slice(&chunk);
            }
            Ok(Piped::End) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                abandon(child);
                return Run::failed(Failure::Timeout, &output);
            }
        }
    }

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Run {
                    status: status.code(),
                    stdout: String::from_utf8_lossy(&output).into_owned(),
                    failure: None,
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(EXIT_POLL),
            Ok(None) => {
                abandon(child);
                return Run::failed(Failure::Timeout, &output);
            }
            Err(_) => {
                abandon(child);
                return Run::failed(Failure::Failed, &output);
            }
        }
    }
}

/// Kill the child and reap it on another thread, so this one never waits for it.
fn abandon(mut child: Child) {
    let _ = child.kill();
    std::thread::spawn(move || child.wait());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bounded_child_settles_at_its_deadline_even_when_its_output_stays_open() {
        let started = Instant::now();
        // The grandchild keeps stdout open long after the shell ignored SIGTERM and exited.
        let script = "trap \"\" TERM; (sleep 30 &); echo started; sleep 30";
        let run = run_bounded(
            Path::new("/bin/sh"),
            &[OsStr::new("-c"), OsStr::new(script)],
            Duration::from_millis(300),
            1024,
        );

        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            run,
            Run {
                status: None,
                stdout: "started\n".to_owned(),
                failure: Some(Failure::Timeout),
            }
        );

        let overflow = run_bounded(
            Path::new("/bin/sh"),
            &[OsStr::new("-c"), OsStr::new("yes")],
            Duration::from_secs(5),
            64,
        );
        assert_eq!(overflow.failure, Some(Failure::Overflow));
    }
}
