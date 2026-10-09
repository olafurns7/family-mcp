use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// The TypeScript package's `SessionStoreErrorCode`, plus `InvalidArgument` where it throws a
/// `RangeError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    Busy,
    Cancelled,
    LockLost,
    NotFound,
    UnsafeFile,
    TooLarge,
    Io,
    StoreUnavailable,
    StoreLocked,
    StoreAccessDenied,
    StoreTimeout,
    StoreError,
    StoreBackendRetired,
    StoreWriteUncertain,
    SecretNotFound,
    InvalidArgument,
}

impl Code {
    /// The code as the TypeScript package spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Busy => "BUSY",
            Code::Cancelled => "CANCELLED",
            Code::LockLost => "LOCK_LOST",
            Code::NotFound => "NOT_FOUND",
            Code::UnsafeFile => "UNSAFE_FILE",
            Code::TooLarge => "TOO_LARGE",
            Code::Io => "IO",
            Code::StoreUnavailable => "STORE_UNAVAILABLE",
            Code::StoreLocked => "STORE_LOCKED",
            Code::StoreAccessDenied => "STORE_ACCESS_DENIED",
            Code::StoreTimeout => "STORE_TIMEOUT",
            Code::StoreError => "STORE_ERROR",
            Code::StoreBackendRetired => "STORE_BACKEND_RETIRED",
            Code::StoreWriteUncertain => "STORE_WRITE_UNCERTAIN",
            Code::SecretNotFound => "SECRET_NOT_FOUND",
            Code::InvalidArgument => "INVALID_ARGUMENT",
        }
    }
}

type Cause = Box<dyn std::error::Error + Send + Sync>;

/// Every message is a literal without paths or file contents, so callers may forward it. A
/// refused store path (the TypeScript package's `StoreRefusal`) also carries that path, for the
/// owner's terminal only, and the command that fixes it when there is one.
#[derive(Debug)]
pub struct Error {
    pub code: Code,
    pub message: &'static str,
    cause: Option<Cause>,
    path: Option<PathBuf>,
    fix: Option<&'static str>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(code: Code, message: &'static str) -> Self {
        Self {
            code,
            message,
            cause: None,
            path: None,
            fix: None,
        }
    }

    pub fn caused(code: Code, message: &'static str, cause: impl Into<Cause>) -> Self {
        Self {
            cause: Some(cause.into()),
            ..Self::new(code, message)
        }
    }

    /// An UNSAFE_FILE refusal of `path`; `fix` is the command that fixes it once the path is added.
    pub fn refusal(
        message: &'static str,
        path: impl Into<PathBuf>,
        fix: Option<&'static str>,
    ) -> Self {
        Self {
            path: Some(path.into()),
            fix,
            ..Self::new(Code::UnsafeFile, message)
        }
    }

    /// The refused store path; never put it in a message an MCP client sees.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The command that fixes a refused path, to be followed by that path.
    pub fn fix(&self) -> Option<&'static str> {
        self.fix
    }

    pub(crate) fn io(cause: std::io::Error, message: &'static str) -> Self {
        Self::caused(Code::Io, message, cause)
    }

    pub(crate) fn invalid(message: &'static str) -> Self {
        Self::new(Code::InvalidArgument, message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as _)
    }
}

/// The TypeScript package's `AbortSignal`: a flag the caller sets from another thread. The default
/// is never cancelled.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            return Err(Error::new(
                Code::Cancelled,
                "The operation was cancelled before it changed any file.",
            ));
        }
        Ok(())
    }
}

pub(crate) fn errno(error: &std::io::Error) -> Option<rustix::io::Errno> {
    error
        .raw_os_error()
        .map(rustix::io::Errno::from_raw_os_error)
}
