//! How a failure crosses the MCP and terminal boundaries, as the TypeScript error classes do.

pub const UNKNOWN_ERROR: &str = "The operation failed. Check the server logs for details.";

pub const ZOD_ERROR: &str = "Invalid input or unexpected upstream data.";

/// A server's failure. A server with fixed-message variants of its own (subclasses of
/// `SafeError`) implements this for its own enum; [`Fail`] serves one without.
pub trait Failure: Copy {
    /// The message of a `SafeError` or a subclass; `None` for anything else.
    fn safe(self) -> Option<&'static str>;

    /// Whether this is a `ZodError`: invalid input or unexpected upstream data.
    fn is_invalid(self) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// `SafeError`: a fixed, reviewed message.
    Safe(&'static str),
    /// A `ZodError`: invalid input or unexpected upstream data.
    Invalid,
    /// Anything else; its details never cross a boundary.
    Unknown,
}

impl Failure for Fail {
    fn safe(self) -> Option<&'static str> {
        match self {
            Fail::Safe(message) => Some(message),
            Fail::Invalid | Fail::Unknown => None,
        }
    }

    fn is_invalid(self) -> bool {
        self == Fail::Invalid
    }
}

/// The text of a tool error result (`toolResult`).
pub fn tool_text(fail: impl Failure) -> &'static str {
    if fail.is_invalid() {
        return ZOD_ERROR;
    }
    fail.safe().unwrap_or(UNKNOWN_ERROR)
}

/// The CLI's diagnostic: only reviewed messages cross the terminal boundary; anything else
/// prints the server's own `fallback`.
pub fn cli_text(fail: impl Failure, fallback: &'static str) -> &'static str {
    fail.safe().unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    enum Own {
        Base(Fail),
        Expired(&'static str),
    }

    impl Failure for Own {
        fn safe(self) -> Option<&'static str> {
            match self {
                Own::Base(fail) => fail.safe(),
                Own::Expired(message) => Some(message),
            }
        }

        fn is_invalid(self) -> bool {
            matches!(self, Own::Base(Fail::Invalid))
        }
    }

    #[test]
    fn texts_match_the_typescript_constants() {
        assert_eq!(
            UNKNOWN_ERROR,
            "The operation failed. Check the server logs for details."
        );
        assert_eq!(ZOD_ERROR, "Invalid input or unexpected upstream data.");
        assert_eq!(tool_text(Fail::Safe("Reviewed.")), "Reviewed.");
        assert_eq!(tool_text(Fail::Invalid), ZOD_ERROR);
        assert_eq!(tool_text(Fail::Unknown), UNKNOWN_ERROR);
        assert_eq!(tool_text(Own::Expired("Sign in again.")), "Sign in again.");
        assert_eq!(tool_text(Own::Base(Fail::Invalid)), ZOD_ERROR);
    }

    #[test]
    fn the_cli_prints_reviewed_messages_or_the_fallback() {
        let fallback = "Server failed.";

        assert_eq!(cli_text(Fail::Safe("Reviewed."), fallback), "Reviewed.");
        assert_eq!(cli_text(Fail::Invalid, fallback), fallback);
        assert_eq!(cli_text(Fail::Unknown, fallback), fallback);
        assert_eq!(
            cli_text(Own::Expired("Sign in again."), fallback),
            "Sign in again."
        );
    }
}
