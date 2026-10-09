use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process};

use crate::errors::{Cancel, Code, Error, Result, errno};
use crate::files::{assert_no_hard_links, create_private, ensure_private_dir, parent, uuid};

pub const DEFAULT_WAIT: Duration = Duration::from_secs(30);

const MAX_POLL: Duration = Duration::from_millis(250);

// Immediate retries still allowed once the deadline has passed, so a zero wait can finish
// recovering a dead owner; each is one rename and one directory read.
const LATE_RETRIES: u32 = 3;

const MAX_PID: u64 = 2_147_483_647;

const CREATE_FAILED: &str =
    "Cannot create the session lock. Check the session directory permissions.";

const RELEASE_FAILED: &str =
    "Cannot release the session lock. Check the session directory permissions.";

#[derive(Debug, Clone)]
pub struct LockOptions {
    /// Stops waiting for the lock; work that already started is not interrupted.
    pub cancel: Cancel,
    /// Longest wait for a busy lock before BUSY; zero fails immediately. Default 30 s.
    pub wait: Duration,
}

impl Default for LockOptions {
    fn default() -> Self {
        Self {
            cancel: Cancel::default(),
            wait: DEFAULT_WAIT,
        }
    }
}

/// Releases on unwind too, so a panic in `work` does not leave the lock to dead-owner recovery.
struct Held {
    directory: PathBuf,
    owner: String,
    released: bool,
}

impl Held {
    /// Returns true when this holder's owner file was already gone.
    fn release(mut self) -> Result<bool> {
        self.released = true;
        remove_owner(&self.directory, Some(&self.owner))
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if !self.released {
            let _ = remove_owner(&self.directory, Some(&self.owner));
        }
    }
}

/// Run `work` while holding the lock for `path`, coordinating every process on this host that
/// uses the same file, in either language. Errors from `work` propagate unchanged; after `work`
/// succeeds, LOCK_LOST is returned when another process removed or replaced this holder's owner
/// file in the meantime.
pub fn with_file_lock<T, E: From<Error>>(
    path: &Path,
    options: &LockOptions,
    work: impl FnOnce() -> std::result::Result<T, E>,
) -> std::result::Result<T, E> {
    let held = acquire(path, options)?;
    let settled = work();
    let lost = held.release()?;
    let value = settled?;

    if lost {
        return Err(Error::new(
            Code::LockLost,
            "Another process took over the session lock during this operation. Retry it.",
        )
        .into());
    }
    Ok(value)
}

fn acquire(path: &Path, options: &LockOptions) -> Result<Held> {
    let cancel = &options.cancel;
    cancel.check()?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::invalid("The locked path must end in a UTF-8 file name."))?;
    let directory_parent = parent(path);
    ensure_private_dir(directory_parent, false)?;
    // Aliased directories resolve to one lock; the lock lives beside the file it protects.
    let real_parent = fs::canonicalize(directory_parent)
        .map_err(|error| Error::io(error, "Cannot resolve the session directory."))?;
    let directory = real_parent.join(format!("{name}.lock"));
    reject_hard_linked_target(path)?;
    let owner = format!("{}-{}", std::process::id(), uuid()?);
    let temporary = real_parent.join(format!("{name}.lock-tmp.{owner}"));
    // Monotonic: a wall-clock step can neither extend nor cut the wait.
    let deadline = Instant::now() + options.wait;
    let mut poll = Duration::from_millis(25);
    let mut spins = 0u32;
    let mut late_retries = 0;
    let mut permission_misses = 0;

    DirBuilder::new()
        .mode(0o700)
        .create(&temporary)
        .and_then(|()| create_private(&temporary.join(&owner)))
        .map_err(|error| Error::io(error, CREATE_FAILED))?;

    let attempts = (|| {
        loop {
            cancel.check()?;
            let attempt = publish(&temporary, &directory)?;

            if attempt == Publish::Acquired {
                return Ok(());
            }
            let occupant = inspect(&directory)?;

            if occupant == Occupant::Missing && attempt == Publish::Permission {
                permission_misses += 1;

                if permission_misses >= 3 {
                    return Err(Error::new(Code::Io, CREATE_FAILED));
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());

            if remaining.is_zero() && occupant != Occupant::Busy {
                late_retries += 1;
            }

            match next_step(&occupant, remaining, late_retries) {
                Step::GiveUp => {
                    return Err(Error::new(
                        Code::Busy,
                        "Another process holds the session lock. Retry after its operation finishes.",
                    ));
                }
                Step::Retry => {
                    // Yield occasionally so a pathological directory cannot spin.
                    spins += 1;

                    if spins.is_multiple_of(16) && !remaining.is_zero() {
                        std::thread::sleep(poll.min(remaining));
                    }
                }
                Step::Wait => {
                    std::thread::sleep(poll.min(remaining));
                    poll = (poll * 2).min(MAX_POLL);
                }
            }
        }
    })();

    if let Err(error) = attempts {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    let held = Held {
        directory,
        owner,
        released: false,
    };

    // A cancel that arrived during the last attempt gives the lock back.
    if let Err(cancelled) = cancel.check() {
        held.release()?;
        return Err(cancelled);
    }
    Ok(held)
}

fn reject_hard_linked_target(path: &Path) -> Result<()> {
    match fs::metadata(path) {
        Ok(info) if info.is_file() => assert_no_hard_links(info.nlink()),
        Ok(_) => Ok(()),
        Err(error) if errno(&error) == Some(Errno::NOENT) => Ok(()),
        Err(error) => Err(Error::io(
            error,
            "Cannot inspect the session file. Check its path and permissions.",
        )),
    }
}

#[derive(PartialEq)]
enum Publish {
    Acquired,
    Occupied,
    Permission,
}

/// Publishing a complete, non-empty directory avoids partially written lock ownership.
fn publish(temporary: &Path, directory: &Path) -> Result<Publish> {
    match fs::rename(temporary, directory) {
        Ok(()) => Ok(Publish::Acquired),
        Err(error) => match errno(&error) {
            Some(Errno::NOTEMPTY | Errno::EXIST) => Ok(Publish::Occupied),
            Some(Errno::PERM) => Ok(Publish::Permission),
            _ => Err(Error::io(error, CREATE_FAILED)),
        },
    }
}

#[derive(Debug, PartialEq)]
enum Occupant {
    Busy,
    Missing,
    Retry,
}

#[derive(Debug, PartialEq)]
enum Step {
    Retry,
    Wait,
    GiveUp,
}

/// After a failed attempt: progress (a dead owner or an empty shell removed) retries at once, a
/// live owner is waited for, and neither outlasts the deadline. `late_retries` counts progress
/// after the deadline, including this one; a few still retry, so a zero wait can finish a recovery.
fn next_step(occupant: &Occupant, remaining: Duration, late_retries: u32) -> Step {
    match (remaining.is_zero(), occupant) {
        (false, Occupant::Busy) => Step::Wait,
        (false, _) => Step::Retry,
        (true, Occupant::Busy) => Step::GiveUp,
        (true, _) if late_retries <= LATE_RETRIES => Step::Retry,
        (true, _) => Step::GiveUp,
    }
}

fn inspect(directory: &Path) -> Result<Occupant> {
    let failed = |error| {
        Error::io(
            error,
            "Cannot inspect the session lock. Check the session directory permissions.",
        )
    };
    let owners = match fs::read_dir(directory) {
        Ok(entries) => entries
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(failed)?,
        Err(error) if errno(&error) == Some(Errno::NOENT) => return Ok(Occupant::Missing),
        Err(error) => return Err(failed(error)),
    };

    // A released shell is removed first, as the TypeScript package does for Windows.
    if owners.is_empty() {
        remove_owner(directory, None)?;
        return Ok(Occupant::Retry);
    }
    let [previous] = owners.as_slice() else {
        return Ok(Occupant::Busy);
    };
    let Some(pid) = previous.to_str().and_then(owner_pid) else {
        return Ok(Occupant::Busy);
    };

    if is_live(pid) {
        return Ok(Occupant::Busy);
    }
    // Remove only that owner's unique filename. A replacement directory is non-empty, so competing
    // recovery attempts can neither rmdir it nor rename over it.
    remove_owner(directory, previous.to_str())?;
    Ok(Occupant::Retry)
}

/// The pid of an owner file named `<pid>-<36 hex digits and dashes>`.
fn owner_pid(owner: &str) -> Option<i32> {
    let (pid, id) = owner.split_once('-')?;
    let plain = !pid.starts_with('0') && pid.bytes().all(|byte| byte.is_ascii_digit());
    let hex = id.len() == 36
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'));

    if !plain || !hex {
        return None;
    }
    let pid = pid.parse::<u64>().ok().filter(|pid| *pid <= MAX_PID)?;
    i32::try_from(pid).ok()
}

fn is_live(pid: i32) -> bool {
    // EPERM means the process exists but belongs to another user.
    Pid::from_raw(pid).is_none_or(|pid| test_kill_process(pid) != Err(Errno::SRCH))
}

/// Returns true when `owner` was already gone.
fn remove_owner(directory: &Path, owner: Option<&str>) -> Result<bool> {
    let mut missing = false;

    if let Some(owner) = owner
        && let Err(error) = fs::remove_file(directory.join(owner))
    {
        if errno(&error) != Some(Errno::NOENT) {
            return Err(Error::io(error, RELEASE_FAILED));
        }
        missing = true;
    }

    if let Err(error) = fs::remove_dir(directory)
        && !matches!(
            errno(&error),
            Some(Errno::NOENT | Errno::NOTEMPTY | Errno::EXIST)
        )
    {
        return Err(Error::io(error, RELEASE_FAILED));
    }
    Ok(missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_retry_outcome_obeys_the_deadline() {
        let some = Duration::from_millis(10);
        assert_eq!(next_step(&Occupant::Busy, some, 0), Step::Wait);
        assert_eq!(next_step(&Occupant::Retry, some, 0), Step::Retry);
        assert_eq!(next_step(&Occupant::Missing, some, 0), Step::Retry);
        assert_eq!(next_step(&Occupant::Busy, Duration::ZERO, 0), Step::GiveUp);

        // Past the deadline, progress gets a few immediate retries, then gives up like a busy lock.
        for occupant in [Occupant::Retry, Occupant::Missing] {
            assert_eq!(next_step(&occupant, Duration::ZERO, 1), Step::Retry);
            assert_eq!(next_step(&occupant, Duration::ZERO, 3), Step::Retry);
            assert_eq!(next_step(&occupant, Duration::ZERO, 4), Step::GiveUp);
        }
    }
}
