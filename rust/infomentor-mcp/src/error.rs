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

/// Semantic login phases, never derived from upstream URLs or text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginStep {
    LoginPage,
    CredentialSubmit,
    Relay,
    IsAuthenticated,
    ParentBootstrap,
}

impl LoginStep {
    pub const fn name(self) -> &'static str {
        match self {
            Self::LoginPage => "login-page",
            Self::CredentialSubmit => "credential-submit",
            Self::Relay => "relay",
            Self::IsAuthenticated => "isauthenticated",
            Self::ParentBootstrap => "parent-bootstrap",
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
        login_step: Option<LoginStep>,
        http_status: Option<u16>,
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
            login_step: None,
            http_status: None,
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
        match self {
            Fail::Im {
                code,
                retry_after_ms,
                login_step,
                http_status,
                ..
            } => Fail::Im {
                code,
                message,
                retry_after_ms,
                login_step,
                http_status,
            },
            Fail::Invalid | Fail::Unknown => Fail::new(Code::UnexpectedPage, message),
        }
    }

    /// Attach the failing response's status.
    pub fn with_http_status(self, status: u16) -> Self {
        match self {
            Fail::Im {
                code,
                message,
                retry_after_ms,
                login_step,
                ..
            } => Fail::Im {
                code,
                message,
                retry_after_ms,
                login_step,
                http_status: Some(status),
            },
            other => other,
        }
    }

    /// Attach the login step without changing cancellation or timeout failures.
    pub fn at_login_step(self, step: LoginStep) -> Self {
        match self {
            Fail::Im {
                code: Code::Cancelled | Code::LoginTimeout,
                ..
            } => self,
            Fail::Im {
                code,
                message,
                retry_after_ms,
                http_status,
                ..
            } => Fail::Im {
                code,
                message,
                retry_after_ms,
                login_step: Some(step),
                http_status,
            },
            other => other,
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

    fn safe_message(self) -> Option<std::borrow::Cow<'static, str>> {
        use std::borrow::Cow;
        match self {
            Fail::Im {
                message,
                login_step: Some(step),
                http_status,
                ..
            } => Some(Cow::Owned(match http_status {
                Some(status) => format!(
                    "InfoMentor login failed at step {} (HTTP {}). {}",
                    step.name(),
                    status,
                    message
                ),
                None => format!(
                    "InfoMentor login failed at step {}. {}",
                    step.name(),
                    message
                ),
            })),
            _ => self.safe().map(Cow::Borrowed),
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

#[cfg(test)]
mod tests {
    use super::*;
    use mcp_runtime::Failure;

    const STEPS: [(LoginStep, &str); 5] = [
        (LoginStep::LoginPage, "login-page"),
        (LoginStep::CredentialSubmit, "credential-submit"),
        (LoginStep::Relay, "relay"),
        (LoginStep::IsAuthenticated, "isauthenticated"),
        (LoginStep::ParentBootstrap, "parent-bootstrap"),
    ];

    #[test]
    fn login_names_statuses_and_rewrap_are_typed() {
        for (step, name) in STEPS {
            assert_eq!(step.name(), name);
        }
        let base = Fail::new(
            Code::NetworkError,
            "InfoMentor returned an error. Try again later.",
        );
        for (status, expected) in [
            (
                None,
                "InfoMentor login failed at step isauthenticated. InfoMentor returned an error. Try again later.",
            ),
            (
                Some(411),
                "InfoMentor login failed at step isauthenticated (HTTP 411). InfoMentor returned an error. Try again later.",
            ),
            (
                Some(65535),
                "InfoMentor login failed at step isauthenticated (HTTP 65535). InfoMentor returned an error. Try again later.",
            ),
        ] {
            let fail = match status {
                Some(status) => base.with_http_status(status),
                None => base,
            }
            .at_login_step(LoginStep::IsAuthenticated);
            assert_eq!(fail.safe_message().unwrap(), expected);
            assert_eq!(fail.safe(), base.safe());
            assert_eq!(mcp_runtime::tool_text(fail), expected);
            assert_eq!(mcp_runtime::cli_text(fail, "Fallback."), expected);
        }
        let original = Fail::Im {
            code: Code::RateLimited,
            message: "InfoMentor is limiting requests. No automatic retry was made.",
            retry_after_ms: Some(120_000.0),
            login_step: Some(LoginStep::Relay),
            http_status: Some(429),
        };
        assert_eq!(
            original.rewrap("Reviewed replacement."),
            Fail::Im {
                code: Code::RateLimited,
                message: "Reviewed replacement.",
                retry_after_ms: Some(120_000.0),
                login_step: Some(LoginStep::Relay),
                http_status: Some(429),
            }
        );
        assert_eq!(CANCELLED.at_login_step(LoginStep::Relay), CANCELLED);
        let timeout = Fail::new(
            Code::LoginTimeout,
            "Sign-in timed out. The previous saved session was kept.",
        );
        assert_eq!(timeout.at_login_step(LoginStep::Relay), timeout);
        assert_eq!(
            Fail::Unknown.at_login_step(LoginStep::Relay).safe_message(),
            None
        );
        assert_eq!(
            LOGIN_REQUIRED.with_http_status(401).safe_message(),
            LOGIN_REQUIRED.safe_message()
        );
    }

    #[test]
    fn all_login_recovery_messages_fit_the_boundary() {
        // Every reviewed message the login HTTP/parser paths can render, including rewraps.
        for message in [
            LOGIN_REQUIRED.safe().unwrap(),
            "Invalid InfoMentor URL.",
            "Only HTTPS hosts under infomentor.is are supported.",
            "InfoMentor requested a pause. Wait before retrying.",
            "InfoMentor request timed out.",
            "InfoMentor request failed. Check the network.",
            "InfoMentor returned a redirect without a destination.",
            "InfoMentor requested an unsupported cross-origin form redirect.",
            "InfoMentor is limiting requests. No automatic retry was made.",
            "InfoMentor returned an unexpectedly large response.",
            "InfoMentor requires an interactive security check. Direct HTTP login cannot complete it; no automatic retry was made.",
            "InfoMentor denied access. Check the account before retrying.",
            "InfoMentor returned an error. Try again later.",
            "InfoMentor returned too many redirects.",
            "InfoMentor returned an unsupported authentication response.",
            "InfoMentor parent data has changed or is unavailable.",
            "InfoMentor returned an unsupported login form.",
            "InfoMentor changed its password form destination. Login stopped.",
            "InfoMentor returned an unsupported authentication handoff.",
            "InfoMentor did not accept the login. Check your credentials; no automatic retry was made.",
            "InfoMentor could not confirm restoration of the original child. No cursor was advanced. Check the overview before continuing.",
        ] {
            for (step, _) in STEPS {
                let fail = Fail::new(Code::UnexpectedPage, message)
                    .with_http_status(u16::MAX)
                    .at_login_step(step);
                assert!(fail.safe_message().unwrap().len() <= 512);
            }
        }
    }
}
