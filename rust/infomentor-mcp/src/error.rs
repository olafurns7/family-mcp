//! `InfoMentorError` and how a failure crosses the MCP and terminal boundaries, as the TypeScript
//! error classes do.

/// `ErrorCode`: what an `InfoMentorError` reports besides its message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    LoginRequired,
    InvalidSession,
    InvalidConfiguration,
    UnexpectedPage,
    NetworkError,
    #[expect(dead_code, reason = "login uses it from slice 3")]
    LoginTimeout,
    Cancelled,
    ChallengeRequired,
    RateLimited,
    AccessDenied,
    OperationInProgress,
}

impl Code {
    /// The TypeScript name, for the test build's failure record.
    #[cfg(feature = "test-origin")]
    pub fn name(self) -> &'static str {
        match self {
            Code::LoginRequired => "LOGIN_REQUIRED",
            Code::InvalidSession => "INVALID_SESSION",
            Code::InvalidConfiguration => "INVALID_CONFIGURATION",
            Code::UnexpectedPage => "UNEXPECTED_PAGE",
            Code::NetworkError => "NETWORK_ERROR",
            Code::LoginTimeout => "LOGIN_TIMEOUT",
            Code::Cancelled => "CANCELLED",
            Code::ChallengeRequired => "CHALLENGE_REQUIRED",
            Code::RateLimited => "RATE_LIMITED",
            Code::AccessDenied => "ACCESS_DENIED",
            Code::OperationInProgress => "OPERATION_IN_PROGRESS",
        }
    }
}

/// How a failure crosses the MCP and terminal boundaries.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fail {
    /// `InfoMentorError`: a fixed, reviewed message, its code, and the pause InfoMentor asked for.
    Im {
        code: Code,
        message: &'static str,
        retry_after_ms: Option<f64>,
    },
    /// A `ZodError`: unexpected data that TypeScript would not catch.
    Invalid,
    /// Anything else; its details never cross a boundary.
    Unknown,
}

pub type Result<T> = std::result::Result<T, Fail>;

impl Fail {
    pub const fn new(code: Code, message: &'static str) -> Self {
        Fail::Im {
            code,
            message,
            retry_after_ms: None,
        }
    }

    pub const fn config(message: &'static str) -> Self {
        Fail::new(Code::InvalidConfiguration, message)
    }

    pub fn code(self) -> Option<Code> {
        match self {
            Fail::Im { code, .. } => Some(code),
            Fail::Invalid | Fail::Unknown => None,
        }
    }

    pub fn is(self, wanted: Code) -> bool {
        self.code() == Some(wanted)
    }

    pub fn retry_after_ms(self) -> Option<f64> {
        match self {
            Fail::Im { retry_after_ms, .. } => retry_after_ms,
            Fail::Invalid | Fail::Unknown => None,
        }
    }

    /// `new InfoMentorError(error?.code ?? 'UNEXPECTED_PAGE', message, error?.retryAfterMs)`: a
    /// new message that keeps an InfoMentor failure's code and pause.
    pub fn rewrap(self, message: &'static str) -> Self {
        Fail::Im {
            code: self.code().unwrap_or(Code::UnexpectedPage),
            message,
            retry_after_ms: self.retry_after_ms(),
        }
    }
}

/// `loginRequiredError()`.
pub const LOGIN_REQUIRED: Fail = Fail::new(
    Code::LoginRequired,
    "Sign in first: run infomentor-mcp login on the MCP host, or call infomentor_login when the server was started with --allow-setup-tools.",
);

/// `throwIfAborted`'s failure.
pub const CANCELLED: Fail = Fail::new(
    Code::Cancelled,
    "Operation cancelled. The existing saved session was kept.",
);

impl mcp_runtime::Failure for Fail {
    fn safe(self) -> Option<&'static str> {
        match self {
            Fail::Im { message, .. } => Some(message),
            Fail::Invalid | Fail::Unknown => None,
        }
    }

    fn is_invalid(self) -> bool {
        self == Fail::Invalid
    }
}

/// In a test build with INFOMENTOR_TEST_FAILURES=1, a failure's code and pause go to stderr on
/// one line, so the TypeScript test drop-ins can rebuild the `InfoMentorError` they assert on.
#[cfg(feature = "test-origin")]
pub fn record(fail: Fail) {
    if std::env::var_os("INFOMENTOR_TEST_FAILURES").is_some_and(|flag| flag == "1") {
        let record = serde_json::json!({
            "code": fail.code().map(Code::name),
            "retryAfterMs": fail.retry_after_ms(),
        });
        eprintln!("INFOMENTOR_TEST_FAILURE {record}");
    }
}
