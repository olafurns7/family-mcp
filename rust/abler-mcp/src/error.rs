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

impl Fail {
    /// The message, for a `SafeError` and its subclasses.
    pub fn safe(self) -> Option<&'static str> {
        match self {
            Fail::Safe(message) | Fail::Store(message) | Fail::Expired(message) => Some(message),
            Fail::Invalid | Fail::Unknown => None,
        }
    }
}

impl mcp_runtime::Failure for Fail {
    fn safe(self) -> Option<&'static str> {
        Fail::safe(self)
    }

    fn is_invalid(self) -> bool {
        self == Fail::Invalid
    }
}
