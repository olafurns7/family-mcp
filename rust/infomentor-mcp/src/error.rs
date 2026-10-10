/// How a failure crosses the MCP and terminal boundaries, as the TypeScript error classes do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fail {
    /// `InfoMentorError`: a fixed, reviewed message.
    Safe(&'static str),
    /// Anything else; its details never cross a boundary.
    Unknown,
}

pub type Result<T> = std::result::Result<T, Fail>;

impl mcp_runtime::Failure for Fail {
    fn safe(self) -> Option<&'static str> {
        match self {
            Fail::Safe(message) => Some(message),
            Fail::Unknown => None,
        }
    }

    fn is_invalid(self) -> bool {
        false
    }
}
