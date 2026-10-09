/// How a failure crosses the MCP and terminal boundaries, as the TypeScript error classes do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// `SafeError`: a fixed, reviewed message.
    Safe(&'static str),
    /// `StoreFailure`: a store error's fixed message; verification passes it on unchanged.
    Store(&'static str),
    /// `ExpiredSession`: Abler will never accept the session again.
    Expired(&'static str),
    /// A `ZodError`: invalid input or unexpected upstream data.
    Invalid,
    /// Anything else; its details never cross a boundary.
    Unknown,
}

pub type Result<T> = std::result::Result<T, Fail>;

const UNKNOWN_ERROR: &str = "The operation failed. Check the server logs for details.";

const ZOD_ERROR: &str = "Invalid input or unexpected upstream data.";

impl Fail {
    /// The message, for a `SafeError` and its subclasses.
    pub fn safe(self) -> Option<&'static str> {
        match self {
            Fail::Safe(message) | Fail::Store(message) | Fail::Expired(message) => Some(message),
            Fail::Invalid | Fail::Unknown => None,
        }
    }

    /// The text of a tool error result (`toolResult`).
    pub fn tool_text(self) -> &'static str {
        match self {
            Fail::Invalid => ZOD_ERROR,
            other => other.safe().unwrap_or(UNKNOWN_ERROR),
        }
    }

    /// The CLI's diagnostic: only reviewed messages cross the terminal boundary.
    pub fn cli_text(self) -> &'static str {
        self.safe().unwrap_or("Abler MCP failed.")
    }
}
