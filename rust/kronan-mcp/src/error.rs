/// How a failure crosses the MCP and terminal boundaries, as the TypeScript error classes do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// `SafeError`, or an `Error` the CLI prints as it is: a fixed, reviewed message.
    Safe(&'static str),
    /// A `ZodError`: invalid input or unexpected upstream data.
    Invalid,
    /// Anything else; its details never cross a boundary.
    Unknown,
}

pub type Result<T> = std::result::Result<T, Fail>;

impl mcp_runtime::Failure for Fail {
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
